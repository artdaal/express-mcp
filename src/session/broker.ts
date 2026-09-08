import { createServer, Server, Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { ExpressService, ServiceApi } from "../service.js";
import { createSafeLogger } from "../logger.js";
import { safeErrorBody } from "../errors.js";
import { AuthManager } from "./auth.js";
import { DirectAdapter, DirectClient } from "./direct.js";
import { SessionHttp } from "./http.js";
import { SessionSocket } from "./socket.js";
import { KeychainStore } from "./store.js";
import { LoginUi } from "./login-ui.js";
import { SessionError } from "./types.js";
import { dispatch, FRAME_LIMIT, requestSchema } from "./ipc.js";
import { helperPath, loadConfig, lockHelperPath, privateDirectory, socketPath } from "./paths.js";

export async function acquireProcessLock(helper: string, path: string): Promise<() => void> {
  const child = spawn(helper, [path], {stdio: ["pipe", "pipe", "pipe"]});
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new SessionError("BROKER_UNAVAILABLE")); }, 5000);
    child.once("error", () => { clearTimeout(timer); reject(new SessionError("KEYCHAIN_UNAVAILABLE")); });
    child.once("exit", () => { clearTimeout(timer); reject(new SessionError("BROKER_BUSY")); });
    child.stdout.once("data", data => { clearTimeout(timer); if (data.toString().trim() === '{"ok":true}') resolve(); else reject(new SessionError("BROKER_BUSY")); });
  });
  // Losing the lease unexpectedly must stop the owning daemon, never fork owners.
  const lost = () => process.kill(process.pid, "SIGTERM"); child.once("exit", lost);
  return () => { child.off("exit", lost); child.stdin.end(); };
}

export class Broker {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly work = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly path: string, private readonly makeService: () => ServiceApi, private readonly login: () => Promise<unknown>, private readonly epoch: () => string = () => "default") {
    this.server = createServer(socket => this.accept(socket)); this.server.maxConnections = 32;
  }
  async start() {
    await privateDirectory(dirname(this.path));
    // Only call with the exclusive native process lease held.
    try { const existing = await lstat(this.path); if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new SessionError("IPC_PATH_UNSAFE"); await unlink(this.path); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.path, () => resolve()); });
    await chmod(this.path, 0o600);
  }
  private accept(socket: Socket) {
    if (this.closed || this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket); let service = this.makeService(); let epoch = this.epoch();
    let buffer = Buffer.alloc(0); let queued = 0; let chain = Promise.resolve();
    // One queue per caller. Shared transport is multiplexed; login has its own mutex.
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > FRAME_LIMIT) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        let request: ReturnType<typeof requestSchema.parse>;
        try { request = requestSchema.parse(JSON.parse(frame.toString())); } catch { socket.destroy(); return; }
        if (++queued > 32) { socket.destroy(); return; }
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          if (epoch !== this.epoch()) { await service.close(); service = this.makeService(); epoch = this.epoch(); }
          let response: object;
          try { response = { id: request.id, result: await dispatch(service, request, this.login) }; }
          catch (error) { response = {id: request.id, error: safeErrorBody(error).error}; }
          const encoded = JSON.stringify(response) + "\n";
          if (Buffer.byteLength(encoded) > FRAME_LIMIT || socket.writableLength > FRAME_LIMIT) { socket.destroy(); return; }
          if (!socket.destroyed) socket.write(encoded);
        }).catch(() => socket.destroy()).then(() => { queued--; });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket); buffer.fill(0);
      const done = chain.finally(() => service.close()); this.work.add(done); void done.finally(() => this.work.delete(done));
    });
  }
  async close() {
    this.closed = true; for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve())); await Promise.allSettled([...this.work]);
    try { await unlink(this.path); } catch {}
  }
}
export async function runDaemon() {
  process.umask(0o077); const path = socketPath(); await privateDirectory(dirname(path));
  const release = await acquireProcessLock(lockHelperPath(), path + ".lock");
  const http = new SessionHttp(await loadConfig()); const auth = new AuthManager(new KeychainStore(helperPath()), bundle => http.refresh(bundle));
  const socket = new SessionSocket(http.config, auth); const direct = new DirectClient(auth, http, socket); const login = new LoginUi(auth, http);
  const broker = new Broker(path, () => {
    const service = new ExpressService({adapter: new DirectAdapter(direct), logger: createSafeLogger()});
    const original = service.status.bind(service);
    service.status = async () => { const result = await original(); result.status.session = {...result.status.session, ...login.diagnostics(), ...http.diagnostics(), brokerState: "running"}; return result; }; return service;
  }, () => login.start(), () => auth.epoch());
  let stop!: () => void; const stopped = new Promise<void>(resolve => {stop = resolve;});
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await broker.start(); auth.start(); createSafeLogger().info({operation: "daemon", code: "BROKER_LISTENING"}); await stopped; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await login.stop(); socket.close(); await broker.close(); direct.close(); await auth.close(); release(); }
}
