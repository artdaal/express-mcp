import { spawn } from "node:child_process";
import { AuthBundle, parseBundle, SecretStore, SessionError } from "./types.js";

// Secret values are carried only on private pipes, never argv or inherited logs.
export class KeychainStore implements SecretStore {
  constructor(private readonly helper: string) {}
  private call(request: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helper, [], { stdio: ["pipe", "pipe", "ignore"] });
      let data = Buffer.alloc(0); let done = false;
      const finish = (error?: SessionError, value?: unknown) => {
        if (done) return; done = true; clearTimeout(timer); data.fill(0);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => { child.kill(); finish(new SessionError("KEYCHAIN_UNAVAILABLE")); }, 15_000);
      child.on("error", () => finish(new SessionError("KEYCHAIN_UNAVAILABLE")));
      child.stdin.on("error", () => finish(new SessionError("KEYCHAIN_UNAVAILABLE")));
      child.stdout.on("data", (chunk: Buffer) => {
        if (data.length + chunk.length > 1024 * 1024) { child.kill(); finish(new SessionError("AUTH_STORE_INVALID")); return; }
        data = Buffer.concat([data, chunk]);
      });
      child.on("close", code => {
        if (code !== 0) { finish(new SessionError("KEYCHAIN_LOCKED")); return; }
        try {
          const response = JSON.parse(data.toString("utf8"));
          if (response.ok !== true) finish(new SessionError("KEYCHAIN_LOCKED"));
          else finish(undefined, response.value ?? null);
        } catch { finish(new SessionError("AUTH_STORE_INVALID")); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
  async load(): Promise<AuthBundle | null> {
    const data = await this.call({ operation: "load" });
    return data === null ? null : parseBundle(data);
  }
  async save(value: AuthBundle): Promise<void> { await this.call({ operation: "save", value: parseBundle(value) }); }
  async openLogin(url: string): Promise<void> { await this.call({ operation: "openLogin", url }); }
}
