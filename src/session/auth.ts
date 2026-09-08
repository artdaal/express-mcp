import { EventEmitter } from "node:events";
import { AuthBundle, AuthState, SecretStore, SessionError } from "./types.js";

export type RefreshResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; expiresIn: number | null }
  | { kind: "temporary"; code: string; retryAfterMs?: number }
  | { kind: "permanent"; code: string }
  | { kind: "ambiguous"; code: string };
export class AuthManager extends EventEmitter {
  private bundle: AuthBundle | null = null;
  private flight: Promise<void> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private state: AuthState = "missing";
  private error: string | null = null;
  private retryAt = 0;
  private failures = 0;
  private timer: NodeJS.Timeout | undefined;
  private authenticatedAt: number | null = null;
  private closed = false;
  readonly boot: Promise<void>;
  constructor(private readonly store: SecretStore, private readonly refreshRequest: (bundle: AuthBundle) => Promise<RefreshResult>, private readonly now = Date.now) {
    super(); this.boot = this.restore();
  }
  private async restore() {
    try {
      this.bundle = await this.store.load();
      this.state = !this.bundle ? "missing" : this.bundle.revoked ? "reauth_required" : this.bundle.refreshPending ? "recovery_required" : "ready";
    } catch { this.state = "locked"; this.error = "KEYCHAIN_UNAVAILABLE"; }
  }
  start() {
    if (this.timer) return;
    // Wall-clock checks also cover missed timers while a Mac sleeps.
    this.timer = setInterval(() => { void this.credentials().catch(() => {}); }, 5000);
    this.timer.unref();
  }
  epoch(): string { return this.bundle ? `${this.bundle.accountId}:${this.bundle.udid}` : "signed-out"; }
  diagnostics() {
    return { authState: this.state, credentialState: this.state === "locked" ? "locked" : this.bundle ? "available" : "missing", accessExpiresAt: this.bundle?.expiresAt ?? null, refreshAt: this.bundle?.refreshAt ?? null, generation: this.bundle?.generation ?? null, lastAuthenticatedRequestAt: this.authenticatedAt, lastAuthErrorCode: this.error, nextRetryAt: this.retryAt || null };
  }
  authenticated() { this.authenticatedAt = this.now(); }
  private mutate(operation: () => Promise<void>): Promise<void> {
    // Enrollment and rotation share one writer, including their durable saves.
    const next = this.mutations.then(async () => {
      if (this.closed) throw new SessionError("BROKER_UNAVAILABLE");
      await operation();
    });
    this.mutations = next.catch(() => {});
    return next;
  }
  async install(bundle: AuthBundle) {
    await this.boot;
    await this.mutate(async () => {
      await this.store.save(bundle); this.bundle = bundle; this.state = "ready"; this.error = null; this.failures = 0; this.retryAt = 0; this.authenticatedAt = null;
      this.emit("changed", { epoch: this.epoch(), enrollment: true });
    });
  }
  async credentials(): Promise<AuthBundle> {
    await this.boot; await this.mutations;
    if (this.closed) throw new SessionError("BROKER_UNAVAILABLE");
    if (["missing", "locked", "reauth_required", "recovery_required"].includes(this.state) || !this.bundle) throw new SessionError(this.state === "locked" ? "KEYCHAIN_LOCKED" : this.state === "recovery_required" ? "AUTH_RECOVERY_REQUIRED" : "REAUTH_REQUIRED");
    if (this.flight) await this.flight;
    else if (this.bundle.refreshAt !== null && this.now() >= this.bundle.refreshAt && this.now() >= this.retryAt) await this.refresh();
    if (!this.bundle || ["reauth_required", "recovery_required", "locked"].includes(this.state)) throw new SessionError(this.state === "recovery_required" ? "AUTH_RECOVERY_REQUIRED" : "REAUTH_REQUIRED");
    if (this.bundle.expiresAt !== null && this.now() >= this.bundle.expiresAt) throw new SessionError("AUTH_RETRY_WAIT");
    return this.bundle;
  }
  async refresh(): Promise<void> {
    await this.boot;
    if (this.closed) throw new SessionError("BROKER_UNAVAILABLE");
    if (this.flight) return this.flight;
    const expected = this.bundle;
    const flight = this.mutate(async () => {
      // A queued expiry notification for the old device must not refresh its replacement.
      if (this.bundle !== expected) return;
      if (!this.bundle || !["ready", "retry_wait"].includes(this.state)) throw new SessionError("REAUTH_REQUIRED");
      if (this.retryAt > this.now()) throw new SessionError("AUTH_RETRY_WAIT");
      await this.rotate();
    });
    this.flight = flight;
    try { await flight; } finally { if (this.flight === flight) this.flight = null; }
  }
  private async rotate() {
    const previous = this.bundle!;
    this.state = "refreshing";
    try { await this.store.save({ ...previous, refreshPending: true }); }
    catch { this.state = "locked"; this.error = "KEYCHAIN_UNAVAILABLE"; throw new SessionError(this.error); }
    let result: RefreshResult;
    try { result = await this.refreshRequest(previous); }
    catch { result = { kind: "ambiguous", code: "REFRESH_RESPONSE_LOST" }; }
    if (result.kind === "ambiguous") {
      this.bundle = { ...previous, refreshPending: true }; this.state = "recovery_required"; this.error = result.code; this.emit("unavailable"); return;
    }
    if (result.kind === "ok") {
      const issuedAt = this.now();
      const next: AuthBundle = { ...previous, accessToken: result.accessToken, refreshToken: result.refreshToken, generation: previous.generation + 1, refreshPending: false, issuedAt, expiresAt: result.expiresIn === null ? null : issuedAt + result.expiresIn * 1000, refreshAt: result.expiresIn === null ? null : issuedAt + result.expiresIn * 500 };
      try { await this.store.save(next); }
      catch { this.bundle = { ...previous, refreshPending: true }; this.state = "recovery_required"; this.error = "REFRESH_SAVE_FAILED"; this.emit("unavailable"); return; }
      this.bundle = next; this.state = "ready"; this.error = null; this.failures = 0; this.retryAt = 0; this.authenticated(); this.emit("changed", { epoch: this.epoch(), enrollment: false }); return;
    }
    const next = { ...previous, refreshPending: false, revoked: result.kind === "permanent" };
    try { await this.store.save(next); }
    catch { this.bundle = { ...previous, refreshPending: true }; this.state = "recovery_required"; this.error = "AUTH_SAVE_FAILED"; this.emit("unavailable"); return; }
    this.bundle = next; this.error = result.code;
    if (result.kind === "permanent") { this.state = "reauth_required"; this.authenticatedAt = null; this.emit("unavailable"); }
    else { this.state = "retry_wait"; this.failures++; this.retryAt = this.now() + Math.min(300_000, Math.max(result.retryAfterMs ?? 0, 1000 * 2 ** Math.min(this.failures, 8)) + Math.floor(Math.random() * 500)); }
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.mutations; this.removeAllListeners(); }
}
