import { z } from "zod";

const secret = z.string().min(1).max(64 * 1024);
const bytes = (n: number) => z.string().refine(s => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, "base64").length === n);
export const keySchema = z.object({ id: z.string().uuid(), secret: bytes(32), public: bytes(32) }).strict();
export const bundleSchema = z.object({
  version: z.literal(1), generation: z.number().int().nonnegative(),
  accountId: z.string().uuid(), udid: z.string().uuid(),
  ctsOrigin: z.string().url(),
  accessToken: secret, refreshToken: secret, etsToken: secret,
  issuedAt: z.number().finite(), expiresAt: z.number().finite().nullable(), refreshAt: z.number().finite().nullable(),
  refreshPending: z.boolean(), revoked: z.boolean().default(false),
  ctsKey: keySchema, rtsKey: keySchema,
  signing: z.object({ id: z.string().uuid(), seed: bytes(32), public: bytes(32) }).strict(),
  serverPublicKey: bytes(32),
}).strict();
export type AuthBundle = z.infer<typeof bundleSchema>;
export type AccountKey = z.infer<typeof keySchema>;
export type AuthState = "missing" | "locked" | "ready" | "refreshing" | "retry_wait" | "recovery_required" | "reauth_required";
export interface SecretStore {
  load(): Promise<AuthBundle | null>;
  save(value: AuthBundle): Promise<void>;
}
export class SessionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SessionError"; }
}
export const safeCode = (error: unknown) => error instanceof SessionError ? error.code : "INTERNAL_ERROR";
export const configSchema = z.object({
  ctsOrigin: z.string().url(), etsOrigin: z.string().url(), webOrigin: z.string().url(),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default("3.71.16"),
  packageId: z.string().min(1).max(128).default("com.example.express"),
  clientProfile: z.enum(["native", "express-cli-web"]).default("native"),
}).strict().superRefine((c, ctx) => {
  for (const value of [c.ctsOrigin, c.etsOrigin, c.webOrigin]) {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") ctx.addIssue({ code: "custom", message: "Expected an HTTPS origin" });
  }
});
export type SessionConfig = z.infer<typeof configSchema>;
export const DEFAULT_CONFIG: SessionConfig = { ctsOrigin: "https://chat.example.com", etsOrigin: "https://ets.chat.example.com", webOrigin: "https://chat.example.com", appVersion: "3.71.16", packageId: "com.example.express", clientProfile: "native" };
export function parseBundle(value: unknown): AuthBundle {
  const result = bundleSchema.safeParse(value);
  if (!result.success) throw new SessionError("AUTH_STORE_INVALID");
  return result.data;
}
