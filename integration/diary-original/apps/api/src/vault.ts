import { createHash } from "node:crypto";
import { diaryDocumentSchema, emptyDiary, type DiaryDocument, type DiaryResponse } from "@diary/contracts";
import { assertDate } from "./date.js";
import { parseDiaryMarkdown, serializeDiaryMarkdown } from "./markdown.js";
import { pool, queryRows } from "./db.js";

function versionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// 按用户维度的写锁，避免单用户并发写冲突
const userLocks = new Map<number, Promise<unknown>>();
export function withVaultLock<T>(userId: number, work: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const result = prev.then(work, work);
  userLocks.set(userId, result.catch(() => {}));
  return result;
}

export async function loadDiary(date: string, userId: number): Promise<DiaryResponse> {
  assertDate(date);
  const rows = await queryRows<{ content: string }>("SELECT content FROM diaries WHERE user_id = ? AND date = ?", [userId, date]);
  if (rows.length === 0) {
    return { document: emptyDiary(date), version: "0", exists: false };
  }
  const content = rows[0].content;
  return { document: parseDiaryMarkdown(content, date), version: versionOf(content), exists: true };
}

export function saveDiary(
  date: string,
  input: unknown,
  expectedVersion: string,
  userId: number
): Promise<DiaryResponse> {
  return withVaultLock(userId, () => saveDiaryUnlocked(date, input, expectedVersion, userId));
}

export async function saveDiaryUnlocked(
  date: string,
  input: unknown,
  expectedVersion: string,
  userId: number
): Promise<DiaryResponse> {
  assertDate(date);
  const document = diaryDocumentSchema.parse(input);
  if (document.date !== date) throw Object.assign(new Error("路径日期与日记日期不一致"), { statusCode: 400 });
  const current = await loadDiary(date, userId);
  if (current.version !== expectedVersion) {
    throw Object.assign(new Error("日记已在其他位置修改"), { statusCode: 409, code: "VERSION_CONFLICT", current });
  }
  const content = serializeDiaryMarkdown(document);
  const version = versionOf(content);
  await pool.query(
    "INSERT INTO diaries (user_id, date, content, version) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content), version = VALUES(version)",
    [userId, date, content, version]
  );
  const saved = await loadDiary(date, userId);
  return { ...saved, savedAt: new Date().toISOString() };
}

export async function listDiaryDates(userId: number, from?: string, to?: string): Promise<string[]> {
  if (from) assertDate(from);
  if (to) assertDate(to);
  let sql = "SELECT date FROM diaries WHERE user_id = ?";
  const params: (string | number)[] = [userId];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date ASC";
  const rows = await queryRows<{ date: string }>(sql, params);
  return rows.map((r) => r.date);
}

export async function readJson<T>(key: string, fallback: T, userId: number): Promise<T> {
  const rows = await queryRows<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND `key` = ?", [userId, key]);
  if (rows.length === 0) return fallback;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown, userId: number): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  await pool.query(
    "INSERT INTO settings (user_id, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [userId, key, json]
  );
}
