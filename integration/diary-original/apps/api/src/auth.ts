import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool, queryRows } from "./db.js";
import { config } from "./config.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

function generateToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

export async function createSession(userId: number): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
    [token, userId, expiresAt]
  );
  return token;
}

export async function verifySession(token: string): Promise<number | null> {
  const rows = await queryRows<{ user_id: number; expires_at: Date }>("SELECT user_id, expires_at FROM sessions WHERE token = ?", [token]);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) {
    await pool.query("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  return row.user_id;
}

export async function destroySession(token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token = ?", [token]);
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header(
    "Set-Cookie",
    `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.header(
    "Set-Cookie",
    "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  );
}

export function getSessionToken(request: FastifyRequest): string | null {
  const raw = request.headers.cookie;
  if (!raw) return null;
  const match = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith("session="));
  return match ? decodeURIComponent(match.slice("session=".length)) : null;
}

declare module "fastify" {
  interface FastifyRequest {
    userId: number | null;
  }
}

export function registerAuth(server: FastifyInstance) {
  server.decorateRequest("userId", null);

  // 解析 session 的 preHandler：所有 /api/* 路由（除 /api/auth/* 和 /api/health）
  server.addHook("preHandler", async (request, reply) => {
    const url = request.url;
    if (url.startsWith("/api/auth/") || url === "/api/health") return;
    if (!url.startsWith("/api/")) return;
    if(config.demoDatabase && config.host==='127.0.0.1'){request.userId=1;return;}

    const token = getSessionToken(request);
    if (!token) {
      reply.code(401).send({ error: "未登录",code:'AUTH_REQUIRED',requestId:request.id });
      return;
    }
    const userId = await verifySession(token);
    if (!userId) {
      reply.code(401).send({ error: "登录已过期",code:'AUTH_REQUIRED',requestId:request.id });
      return;
    }
    request.userId = userId;
  });
}
