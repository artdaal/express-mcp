import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { AuthManager } from "./auth.js";
import { SessionConfig, SessionError } from "./types.js";
import { SessionHttp } from "./http.js";

export type SocketFactory = (url: string, origin: string) => WebSocket;
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class SessionSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private ref = 1;
  private closed = false;
  private wanted = false;
  private ready = false;
  private retry: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private attempts = 0;
  private lastAck: number | null = null;
  private state = "disconnected";
  private readonly changed = () => { this.disconnect(); if (this.wanted && !this.closed) this.schedule(); };
  private readonly unavailable = () => { this.disconnect(); this.state = "auth_required"; };
  constructor(private readonly config: SessionConfig, private readonly auth: AuthManager, private readonly factory: SocketFactory = (url, origin) => new WebSocket(url, { headers: { Origin: origin }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15_000, rejectUnauthorized: true }), private readonly timeoutMs = 15_000, private readonly heartbeatMs = 25_000) {
    super(); auth.on("changed", this.changed); auth.on("unavailable", this.unavailable);
  }
  diagnostics() { return { transportState: this.state, lastHeartbeatAckAt: this.lastAck, inFlightRequests: this.pending.size }; }
  async ensure() {
    if (this.closed) throw new SessionError("BROKER_UNAVAILABLE");
    this.wanted = true;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = this.open();
    try { await this.opening; } finally { this.opening = null; }
  }
  private async open() {
    const bundle = await this.auth.credentials();
    if (this.closed) throw new SessionError("BROKER_UNAVAILABLE");
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    const origin = new SessionHttp(this.config).authorizeCtsOrigin(bundle.ctsOrigin);
    const url = new URL("/socket/user/websocket", origin); url.protocol = "wss:";
    url.search = new URLSearchParams({ vsn: "1.0.0", auto_join: "true", key_id: bundle.ctsKey.id, version: "6", background: "false", voex_unencrypted: "true", instance_id: randomUUID() }).toString();
    const ws = this.factory(url.href, this.config.webOrigin); this.ws = ws; this.state = "connecting";
    ws.on("message", data => { if (this.ws === ws) this.receive(data.toString()); });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.disconnect(); this.emit("disconnected"); this.schedule();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.terminate(); reject(new SessionError("UPSTREAM_UNAVAILABLE")); }, this.timeoutMs);
        const stop = () => { clearTimeout(timer); reject(new SessionError("UPSTREAM_UNAVAILABLE")); };
        ws.once("close", stop);
        ws.once("open", () => { clearTimeout(timer); ws.removeListener("close", stop); resolve(); });
      });
      if (this.ws !== ws || this.closed) throw new SessionError("UPSTREAM_UNAVAILABLE");
      await this.raw("phoenix", "authenticate", { token: bundle.accessToken });
      if (this.ws !== ws) throw new SessionError("UPSTREAM_UNAVAILABLE");
      this.ready = true; this.state = "connected"; this.attempts = 0; this.auth.authenticated();
      this.heartbeat = setInterval(() => {
        void this.raw("phoenix", "heartbeat", {}).then(() => { this.lastAck = Date.now(); }).catch(() => { if (this.ws === ws) ws.terminate(); });
      }, this.heartbeatMs); this.heartbeat.unref(); this.emit("connected");
    } catch (error) {
      if (this.ws === ws) this.disconnect();
      this.schedule(); throw error;
    }
  }
  async request(topic: string, event: string, payload: object): Promise<any> { await this.ensure(); return this.raw(topic, event, payload); }
  private raw(topic: string, event: string, payload: object): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new SessionError("UPSTREAM_UNAVAILABLE"));
    if (this.pending.size >= 128) return Promise.reject(new SessionError("BROKER_BUSY"));
    const ref = this.ref++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new SessionError("UPSTREAM_TIMEOUT")); }, this.timeoutMs);
      this.pending.set(ref, { resolve, reject, timer });
      ws.send(JSON.stringify({ topic, event, payload, ref }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(ref); reject(new SessionError("UPSTREAM_UNAVAILABLE")); }
      });
    });
  }
  private receive(text: string) {
    let frame: any;
    try { frame = JSON.parse(text); } catch { this.ws?.terminate(); return; }
    if (frame.event === "phx_reply") {
      const ref = Number(frame.ref); const pending = this.pending.get(ref); if (!pending) return;
      this.pending.delete(ref); clearTimeout(pending.timer);
      if (frame.payload?.status === "ok") pending.resolve(frame.payload.response ?? {});
      else pending.reject(new SessionError(frame.payload?.response?.reason === "unauthorized" ? "UPSTREAM_UNAUTHORIZED" : "UPSTREAM_REJECTED"));
    } else if (frame.event === "openid_access_token_expired") {
      void this.auth.refresh().catch(() => {});
    } else if (frame.event === "message_new" && frame.payload?.sync_id && frame.payload?.group_chat_id) {
      this.emit("activity", { chatId: frame.payload.group_chat_id, syncId: frame.payload.sync_id });
    }
  }
  private schedule() {
    if (this.closed || this.retry || !this.wanted) return;
    const authState = this.auth.diagnostics().authState;
    if (!["ready", "refreshing", "retry_wait"].includes(authState)) return;
    this.state = "reconnecting";
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts++, 6)) + Math.floor(Math.random() * 500);
    this.retry = setTimeout(() => { this.retry = undefined; void this.ensure().catch(() => this.schedule()); }, delay); this.retry.unref();
  }
  disconnect() {
    this.ready = false; this.state = "disconnected";
    if (this.heartbeat) clearInterval(this.heartbeat);
    const ws = this.ws; this.ws = null; ws?.terminate();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new SessionError("UPSTREAM_UNAVAILABLE")); }
    this.pending.clear();
  }
  close() {
    this.closed = true; if (this.retry) clearTimeout(this.retry); this.disconnect();
    this.auth.off("changed", this.changed); this.auth.off("unavailable", this.unavailable); this.removeAllListeners();
  }
}
