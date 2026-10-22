import { createServer, Server } from "node:http";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { AuthManager } from "./auth.js";
import { SessionHttp } from "./http.js";
import { QrEnrollment } from "./qr.js";
import { safeCode, SessionError } from "./types.js";

export class LoginUi {
  private server: Server | null = null;
  private enrollment: QrEnrollment | null = null;
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<void> | null = null;
  private state = "idle";
  private error: string | null = null;
  private active = false;
  private cycle = 0;
  private attemptedEnrollment: {cycle: number; epoch: string} | null = null;
  private readonly changed = (event: {epoch: string; enrollment: boolean}) => {
    if (this.active && event.enrollment && this.attemptedEnrollment?.cycle === this.cycle && event.epoch === this.attemptedEnrollment.epoch) {
      this.state = "complete"; this.error = null; this.attemptedEnrollment = null;
    }
  };
  constructor(private readonly auth: AuthManager, private readonly http: SessionHttp) {}
  diagnostics() { return { enrollmentState: this.state, enrollmentErrorCode: this.error }; }
  async start(): Promise<{url: string; expiresAt: number}> {
    if (this.state === "starting" || this.enrollment || this.flight) throw new SessionError("LOGIN_BUSY");
    this.state = "starting";
    await this.stop();
    this.active = true; this.auth.on("changed", this.changed);
    const route = `/${randomBytes(32).toString("base64url")}`;
    const csrf = randomBytes(32).toString("base64url");
    let qr = ""; let port = 0; let expiresAt = 0; let cycleTimer: NodeJS.Timeout | undefined;
    const newCycle = async () => {
      if (this.enrollment || this.flight) return;
      const cycle = ++this.cycle; this.attemptedEnrollment = null;
      const enrollment = new QrEnrollment(this.http); this.enrollment = enrollment;
      this.state = "awaiting_mobile_approval"; this.error = null; expiresAt = enrollment.expiresAt;
      qr = await QRCode.toDataURL(enrollment.payload(), {width: 440, margin: 4, errorCorrectionLevel: "M"});
      cycleTimer = setTimeout(() => { enrollment.cancel(); qr = ""; this.state = "expired"; this.error = "QR_EXPIRED"; }, 120_000); cycleTimer.unref();
      this.flight = enrollment.run().then(async bundle => {
        if (!this.active || this.cycle !== cycle || this.enrollment !== enrollment) throw new SessionError("QR_EXPIRED");
        this.attemptedEnrollment = {cycle, epoch: `${bundle.accountId}:${bundle.udid}`};
        await this.auth.install(bundle);
        if (this.active && this.cycle === cycle) {this.state = "complete"; this.error = null; this.attemptedEnrollment = null;}
      }).catch(error => {
        if (!this.active || this.cycle !== cycle) return;
        const session = this.auth.diagnostics(); const last = session.authRecoveryHistory.at(-1);
        if (session.authState !== "locked" || last?.phase !== "enrollment_reconcile" || last.outcome !== "retry_scheduled") this.attemptedEnrollment = null;
        this.state = "failed"; this.error = Date.now() >= enrollment.expiresAt ? "QR_EXPIRED" : safeCode(error);
      }).finally(() => {
        if (cycleTimer) clearTimeout(cycleTimer);
        if (this.cycle === cycle) {qr = ""; this.enrollment = null; this.flight = null;}
      });
    };
    await newCycle();
    const server = createServer((request, response) => {
      const origin = `http://127.0.0.1:${port}`; const renew = request.method === "POST" && request.url === route + "/renew";
      const originValid = !request.headers.origin || request.headers.origin === origin || (request.headers.origin === "null" && request.headers["sec-fetch-site"] === "same-origin");
      if ((!renew && (request.method !== "GET" || request.url !== route)) || request.headers.host !== `127.0.0.1:${port}` || !originValid || request.headers["sec-fetch-site"] === "cross-site") { response.writeHead(403).end(); return; }
      if (renew) {
        void (async () => {
          let body = "";
          for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 1024) {response.writeHead(413).end(); request.destroy(); return;} }
          if (new URLSearchParams(body).get("csrf") !== csrf) {response.writeHead(403).end(); return;}
          await newCycle(); response.writeHead(303, {Location: route, "Cache-Control": "no-store"}).end();
        })().catch(() => response.writeHead(500).end()); return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
      const awaiting = this.state === "awaiting_mobile_approval";
      if (this.attemptedEnrollment && !awaiting) {
        const session = this.auth.diagnostics(); const last = session.authRecoveryHistory.at(-1);
        if (session.authState !== "locked" || last?.phase !== "enrollment_reconcile" || !["started", "retry_scheduled"].includes(last.outcome)) this.attemptedEnrollment = null;
      }
      const pendingCompletion = this.attemptedEnrollment !== null;
      const deviceHint = this.http.config.clientProfile === "express-cli-web" ? "Подключение использует режим совместимости express-cli: на телефоне устройство будет называться «Chrome 149.0». Это подключение Express MCP." : "Подтвердите новое устройство «Express MCP».";
      const message = awaiting ? `В eXpressе на телефоне откройте подключение компьютера и отсканируйте QR. ${deviceHint}` : this.state === "complete" ? "Устройство подключено. Окно можно закрыть." : pendingCompletion ? "Вход подтверждён. Ожидаем доступ к связке ключей, чтобы проверить сохранение устройства. Это окно обновится автоматически." : this.error === "QR_EXPIRED" ? "Время действия QR истекло. Нажмите «Новый QR» и отсканируйте его телефоном." : `Подключение не завершено: ${this.error ?? "QR_EXPIRED"}. Можно получить новый QR.`;
      response.end(`<!doctype html><html lang="ru"><meta charset="utf-8">${awaiting || pendingCompletion ? '<meta http-equiv="refresh" content="3">' : ''}<title>Подключение Express MCP</title><style>body{font:18px system-ui;max-width:640px;margin:48px auto;padding:24px;color:#152238}img{display:block;max-width:100%;margin:auto}p{line-height:1.5}button{font:inherit;background:#126c56;color:white;border:0;border-radius:8px;padding:14px 24px;cursor:pointer}</style><h1>Подключение Express MCP</h1><p>${message}</p>${awaiting ? `<img alt="QR подключения нового устройства" src="${qr}" width="440" height="440"><p>QR действует две минуты. Это окно доступно десять минут.</p>` : this.state === "complete" || pendingCompletion ? '' : `<form method="post" action="${route}/renew"><input type="hidden" name="csrf" value="${csrf}"><button>Новый QR</button></form>`}</html>`);
    });
    this.server = server; server.maxConnections = 8; server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    port = (server.address() as {port: number}).port;
    this.timer = setTimeout(() => { if (cycleTimer) clearTimeout(cycleTimer); void this.stop(); }, 600_000); this.timer.unref();
    return {url: `http://127.0.0.1:${port}${route}`, expiresAt};
  }
  async stop() {
    this.active = false; this.cycle++; this.attemptedEnrollment = null; this.auth.off("changed", this.changed);
    this.enrollment?.cancel(); this.enrollment = null;
    if (this.timer) clearTimeout(this.timer);
    this.server?.closeAllConnections(); this.server?.close(); this.server = null;
    await this.flight;
    this.flight = null;
  }
}
