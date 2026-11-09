import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { HubUserConfig, UserRole } from "@pi-agent-hub/protocol";

export interface ConsoleUser {
  username: string;
  role: UserRole;
}

const sessions = new Map<string, ConsoleUser>();
const csrfTokens = new Map<string, string>();

export function verifyUser(user: HubUserConfig, password: string): boolean {
  if (user.disabled) return false;
  if (user.passwordHash?.startsWith("scrypt$")) {
    const [, salt, hash] = user.passwordHash.split("$");
    if (!salt || !hash) return false;
    const actual = scryptSync(password, salt, 64).toString("hex");
    return safeEqual(actual, hash);
  }
  if (typeof user.password === "string") return safeEqual(password, user.password);
  return false;
}

export function createSession(user: ConsoleUser): { sessionId: string; csrfToken: string } {
  const sessionId = randomBytes(24).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  sessions.set(sessionId, user);
  csrfTokens.set(sessionId, csrfToken);
  return { sessionId, csrfToken };
}

export function getSession(sessionId: string | undefined): ConsoleUser | undefined {
  return sessionId ? sessions.get(sessionId) : undefined;
}

export function getCsrfToken(sessionId: string): string | undefined {
  return csrfTokens.get(sessionId);
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
  csrfTokens.delete(sessionId);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(configToken: { token?: string; tokenHash?: string }, token: string): boolean {
  if (configToken.tokenHash) {
    const expected = configToken.tokenHash.replace(/^sha256:/, "");
    return safeEqual(hashToken(token), expected);
  }
  return typeof configToken.token === "string" && safeEqual(token, configToken.token);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
