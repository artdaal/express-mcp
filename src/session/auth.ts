import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { AuthBundle, AuthRecoveryEvent, AuthRecoveryPhase, AuthState, replacementBundle, SecretStore, SessionError } from "./types.js";

export type RefreshResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; expiresIn: number | null }
  | { kind: "temporary"; code: string; retryAfterMs?: number }
  | { kind: "permanent"; code: string }
  | { kind: "ambiguous"; code: string };
type SavedResult = Exclude<RefreshResult, {kind: "ambiguous"}>;
type Recovery = {phase: "restore"} | {phase: "fence"; previous: AuthBundle}
  | {phase: "replacement_save" | "result_save"; next: AuthBundle; result: SavedResult};
interface EnrollmentAttempt {
  next: AuthBundle; prior: EnrollmentAttempt | null; state: AuthState; error: string | null;
  retryAt: number; failures: number; authenticatedAt: number | null;
}
const AUTH_CODES = new Set([
  "KEYCHAIN_UNAVAILABLE", "AUTH_STORE_INVALID", "REFRESH_SAVE_FAILED", "AUTH_SAVE_FAILED", "REFRESH_RESPONSE_LOST", "REFRESH_RESPONSE_INVALID", "REFRESH_OUTCOME_UNKNOWN",
  "OPENID_SESSION_NOT_FOUND", "REFRESH_TOKEN_ERROR", "REFRESH_TOKEN_NOT_FOUND", "OPENID_OFFLINE_SESSION_INVALID", "KEYCLOAK_REFRESH_ERROR", "RATE_LIMITED",
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT", "REFRESH_CONNECT_TIMEOUT", "REFRESH_CONNECT_FAILED", "UNCLASSIFIED_AUTH_ERROR",
]);
const authCode = (code: string) => AUTH_CODES.has(code) ? code : "UNCLASSIFIED_AUTH_ERROR";

export class AuthManager extends EventEmitter {
  private bundle: AuthBundle | null = null;
  private recovery: Recovery | null = null;
  private enrollmentAttempt: EnrollmentAttempt | null = null;
  private history: AuthRecoveryEvent[] = [];
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
    super(); this.boot = this.mutate(() => this.restore(false));
  }
  private record(phase: AuthRecoveryPhase, outcome: AuthRecoveryEvent["outcome"], code: string | null = this.error) {
    this.history.push({timestamp: this.now(), phase, state: this.state, generation: this.bundle?.generation ?? null, code: code === null ? null : authCode(code), outcome});
    if (this.history.length > 32) this.history.shift();
  }
  private checkOpen() { if (this.closed) throw new SessionError("BROKER_UNAVAILABLE"); }
  private scheduleRetry(phase: AuthRecoveryPhase, retryAfterMs = 0) {
    this.failures++;
    const requested = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
    this.retryAt = this.now() + Math.min(300_000, Math.max(requested, 1000 * 2 ** Math.min(this.failures, 8)) + Math.floor(Math.random() * 500));
    this.record(phase, "retry_scheduled");
  }
  private resetRetry() { this.failures = 0; this.retryAt = 0; }
  private async restore(recovering: boolean) {
    this.record("restore", "started");
    let restored: AuthBundle | null;
    try { restored = await this.store.load(); }
    catch (error) {
      if (error instanceof SessionError && error.code === "AUTH_STORE_INVALID") {
        this.checkOpen(); this.recovery = null; this.state = "reauth_required"; this.error = "AUTH_STORE_INVALID"; this.resetRetry();
        this.record("restore", "ambiguous"); this.emit("unavailable"); return;
      }
      this.checkOpen(); this.recovery = {phase: "restore"}; this.state = "locked"; this.error = "KEYCHAIN_UNAVAILABLE";
      this.scheduleRetry("restore"); return;
    }
    this.checkOpen(); this.bundle = restored; this.recovery = null; this.resetRetry();
    this.state = !restored ? "missing" : restored.revoked ? "reauth_required" : restored.refreshPending ? "recovery_required" : "ready";
    this.error = restored?.revoked ? "REFRESH_TOKEN_ERROR" : restored?.refreshPending ? "REFRESH_OUTCOME_UNKNOWN" : null;
    this.record("restore", this.state === "reauth_required" ? "revoked" : this.state === "recovery_required" ? "ambiguous" : "succeeded");
    if (recovering && this.state === "ready" && restored && (restored.expiresAt === null || this.now() < restored.expiresAt)) this.emit("changed", {epoch: this.epoch(), enrollment: false});
    if (["reauth_required", "recovery_required"].includes(this.state)) this.emit("unavailable");
  }
  start() {
    if (this.timer || this.closed) return;
    // Wall-clock checks also cover missed timers while a Mac sleeps.
    this.timer = setInterval(() => { void this.credentials().catch(() => {}); }, 5000);
    this.timer.unref();
  }
  epoch(): string { return this.bundle ? `${this.bundle.accountId}:${this.bundle.udid}` : "signed-out"; }
  diagnostics() {
    return { authState: this.state, credentialState: this.state === "locked" ? "locked" : this.bundle ? "available" : "missing", accessExpiresAt: this.bundle?.expiresAt ?? null, refreshAt: this.bundle?.refreshAt ?? null, generation: this.bundle?.generation ?? null, lastAuthenticatedRequestAt: this.authenticatedAt, lastAuthErrorCode: this.error, nextRetryAt: this.retryAt || null, authRecoveryHistory: this.history.map(event => ({...event})) };
  }
  authenticated(at = this.now()) { if (!this.closed) this.authenticatedAt = at; }
  private mutate(operation: () => Promise<void>): Promise<void> {
    // Enrollment, restore and rotation share one writer, including durable saves.
    const next = this.mutations.then(async () => { this.checkOpen(); await operation(); });
    this.mutations = next.catch(() => {}); return next;
  }
  async install(bundle: AuthBundle) {
    await this.boot;
    await this.mutate(async () => {
      this.record("enrollment", "started");
      const attempt: EnrollmentAttempt = {next: bundle, prior: this.enrollmentAttempt, state: this.state, error: this.error,
        retryAt: this.retryAt, failures: this.failures, authenticatedAt: this.authenticatedAt};
      try { await this.store.save(bundle); }
      catch (error) {
        this.checkOpen(); this.enrollmentAttempt = attempt; this.state = "locked"; this.error = "AUTH_SAVE_FAILED";
        // A throwing save may already have installed the new device. Suspend all
        // old writes until this same writer reconciles its exact durable result.
        this.emit("unavailable");
        if (await this.reconcileEnrollment() !== "installed") throw error;
        return;
      }
      this.checkOpen(); this.adoptEnrollment(bundle);
    });
  }
  private adoptEnrollment(bundle: AuthBundle) {
    this.bundle = bundle; this.enrollmentAttempt = null; this.recovery = null; this.state = "ready"; this.error = null; this.resetRetry(); this.authenticatedAt = null;
    this.record("enrollment", "succeeded"); this.emit("changed", {epoch: this.epoch(), enrollment: true});
  }
  private async reconcileEnrollment(): Promise<"installed" | "not_installed" | "unavailable"> {
    const attempt = this.enrollmentAttempt!;
    this.record("enrollment_reconcile", "started");
    let restored: AuthBundle | null;
    try { restored = await this.store.load(); }
    catch (error) {
      this.checkOpen();
      if (error instanceof SessionError && error.code === "AUTH_STORE_INVALID") {
        this.state = "reauth_required"; this.error = "AUTH_STORE_INVALID"; this.resetRetry(); this.record("enrollment_reconcile", "ambiguous");
      } else { this.state = "locked"; this.error = "KEYCHAIN_UNAVAILABLE"; this.scheduleRetry("enrollment_reconcile"); }
      return "unavailable";
    }
    this.checkOpen();
    if (isDeepStrictEqual(restored, attempt.next)) {
      this.record("enrollment_reconcile", "succeeded", null); this.adoptEnrollment(attempt.next); return "installed";
    }
    this.enrollmentAttempt = attempt.prior; this.state = attempt.state; this.error = attempt.error;
    this.retryAt = attempt.retryAt; this.failures = attempt.failures; this.authenticatedAt = attempt.authenticatedAt;
    this.record("enrollment_reconcile", "succeeded", null);
    if (!this.enrollmentAttempt && ["ready", "retry_wait"].includes(this.state) && this.bundle && (this.bundle.expiresAt === null || this.now() < this.bundle.expiresAt))
      this.emit("changed", {epoch: this.epoch(), enrollment: false});
    return "not_installed";
  }
  private unavailableError() {
    return new SessionError(this.state === "locked" ? "KEYCHAIN_LOCKED" : this.state === "recovery_required" ? "AUTH_RECOVERY_REQUIRED" : "REAUTH_REQUIRED");
  }
  async credentials(): Promise<AuthBundle> {
    await this.boot; await this.mutations; this.checkOpen();
    const refreshDue = this.state === "ready" && this.bundle?.refreshAt != null && this.now() >= this.bundle.refreshAt;
    if (this.flight) await this.flight;
    else if (this.now() >= this.retryAt && ((this.enrollmentAttempt && this.state === "locked") || (!this.enrollmentAttempt && (this.recovery || this.state === "retry_wait" || refreshDue)))) await this.refresh();
    // A queued enrollment may have started while the refresh promise settled.
    await this.mutations; this.checkOpen();
    if (!this.bundle || !["ready", "retry_wait"].includes(this.state)) throw this.unavailableError();
    if (this.bundle.expiresAt !== null && this.now() >= this.bundle.expiresAt) throw new SessionError("AUTH_RETRY_WAIT");
    return this.bundle;
  }
  async refresh(): Promise<void> {
    await this.boot; this.checkOpen();
    if (this.flight) return this.flight;
    const expected = this.bundle; const expectedRecovery = this.recovery; const expectedEnrollment = this.enrollmentAttempt;
    const flight = this.mutate(async () => {
      // Queued expiry/recovery callbacks for the old device cannot touch enrollment.
      if (this.bundle !== expected || this.recovery !== expectedRecovery || this.enrollmentAttempt !== expectedEnrollment) return;
      if (this.retryAt > this.now()) throw new SessionError("AUTH_RETRY_WAIT");
      const recovering = this.recovery !== null || this.enrollmentAttempt !== null;
      if (this.enrollmentAttempt) {
        if (this.state !== "locked") throw this.unavailableError();
        await this.reconcileEnrollment();
      }
      else if (this.recovery?.phase === "restore") await this.restore(true);
      else if (this.recovery?.phase === "replacement_save" || this.recovery?.phase === "result_save") await this.saveResult(this.recovery);
      else if (this.recovery?.phase === "fence") await this.rotate(this.recovery.previous);
      else if (this.bundle && ["ready", "retry_wait"].includes(this.state)) await this.rotate(this.bundle);
      else throw this.unavailableError();
      // Recovery may reveal an already-due saved bundle. Continue once under the
      // same writer; temporary/failed outcomes keep their normal backoff guards.
      if (recovering && !this.closed && !this.recovery && !this.enrollmentAttempt && this.state === "ready" && this.bundle?.refreshAt != null && this.now() >= this.bundle.refreshAt && this.now() >= this.retryAt)
        await this.rotate(this.bundle);
    });
    this.flight = flight;
    try { await flight; } finally { if (this.flight === flight) this.flight = null; }
  }
  private async rotate(previous: AuthBundle) {
    this.state = "refreshing"; this.record("fence", "started");
    try { await this.store.save({ ...previous, refreshPending: true }); }
    catch {
      this.checkOpen(); this.recovery = {phase: "fence", previous}; this.state = "locked"; this.error = "KEYCHAIN_UNAVAILABLE";
      this.scheduleRetry("fence"); this.emit("unavailable"); return;
    }
    this.checkOpen(); this.record("fence", "succeeded", null); this.record("exchange", "started", null);
    let result: RefreshResult;
    try { result = await this.refreshRequest(previous); }
    catch { result = { kind: "ambiguous", code: "REFRESH_RESPONSE_LOST" }; }
    // Closing drains an already-started exchange and its exact durable save.
    // The check above the request still prevents sending after a closed fence.
    if (result.kind === "ambiguous") {
      this.recovery = null; this.retryAt = 0; this.bundle = { ...previous, refreshPending: true }; this.state = "recovery_required"; this.error = authCode(result.code);
      this.record("exchange", "ambiguous"); if (!this.closed) this.emit("unavailable"); return;
    }
    const issuedAt = this.now();
    const next = result.kind === "ok"
      ? replacementBundle(previous, result.accessToken, result.refreshToken, result.expiresIn, issuedAt)
      : { ...previous, refreshPending: false, revoked: result.kind === "permanent" };
    if (!next) {
      this.recovery = null; this.retryAt = 0; this.bundle = {...previous, refreshPending: true}; this.state = "recovery_required"; this.error = "REFRESH_RESPONSE_INVALID";
      this.record("exchange", "ambiguous"); if (!this.closed) this.emit("unavailable"); return;
    }
    if (result.kind === "ok") this.record("exchange", "succeeded", null);
    this.bundle = {...previous, refreshPending: true};
    this.recovery = {phase: result.kind === "ok" ? "replacement_save" : "result_save", next, result};
    await this.saveResult(this.recovery);
  }
  private async saveResult(pending: Extract<Recovery, {next: AuthBundle}>) {
    const wasUnavailable = this.state === "locked";
    this.record(pending.phase, "started", pending.result.kind === "ok" ? null : pending.result.code);
    try { await this.store.save(pending.next); }
    catch {
      if (this.closed) return;
      this.state = pending.result.kind === "permanent" ? "reauth_required" : "locked";
      this.error = pending.result.kind === "ok" ? "REFRESH_SAVE_FAILED" : "AUTH_SAVE_FAILED";
      this.authenticatedAt = null; this.scheduleRetry(pending.phase); this.emit("unavailable"); return;
    }
    if (this.closed) return;
    this.bundle = pending.next; this.recovery = null;
    if (pending.result.kind === "ok") {
      this.state = "ready"; this.error = null; this.resetRetry(); this.authenticated(pending.next.issuedAt);
      this.record(pending.phase, "succeeded");
      if (pending.next.expiresAt === null || this.now() < pending.next.expiresAt) this.emit("changed", { epoch: this.epoch(), enrollment: false });
    } else {
      this.error = authCode(pending.result.code);
      if (pending.result.kind === "permanent") {
        this.state = "reauth_required"; this.resetRetry(); this.authenticatedAt = null; this.record(pending.phase, "revoked"); this.emit("unavailable");
      } else {
        this.state = "retry_wait"; this.record(pending.phase, "succeeded"); this.scheduleRetry("exchange", pending.result.retryAfterMs);
        if (wasUnavailable && (pending.next.expiresAt === null || this.now() < pending.next.expiresAt)) this.emit("changed", {epoch: this.epoch(), enrollment: false});
      }
    }
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await this.mutations; this.enrollmentAttempt = null; this.recovery = null; this.bundle = null; this.removeAllListeners();
  }
}
