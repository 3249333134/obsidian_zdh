import Fastify from "fastify";
import { captureRequestSchema, validationIssues, DIARY_BODY_LIMIT } from '@diary/contracts';
import { parseCapture } from './capture.js';
import cors from "@fastify/cors";
import { ProxyAgent, request as undiciRequest } from "undici";
import { placeParentSchema, entityTypeSchema, pinQuickFactRequestSchema, sentenceSplitRequestSchema, tagCreateSchema, weeklySummaryRequestSchema } from "@diary/contracts";
import { ZodError } from "zod";
import { config, vaultPaths } from "./config.js";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertDate, addDays, todayInTimezone, weekStart } from "./date.js";
import { EntityIndex } from "./entities.js";
import { listDiaryDates, loadDiary, saveDiary } from "./vault.js";
import { generateWeeklySummary } from "./weekly.js";
import { splitSentenceWithAi, parseTodoFromText, suggestTags } from "./split.js";
import { listActions, changeAction, actionRequestSchema } from './actions.js';
import { listSchedule, scheduleQuery, updateSeries, seriesRequest } from './schedule.js';
import { getAllQuickFacts, pinQuickFact, useQuickFact, unpinQuickFact } from "./quickfacts.js";
import { registerAuth, hashPassword, verifyPassword, createSession, destroySession, verifySession, setSessionCookie, clearSessionCookie, getSessionToken } from "./auth.js";
import { pool, queryRows } from "./db.js";

// ── SPA 静态文件服务：原生 fs ──
const distPath = path.resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

import { addSharedTag, tagLibrary, getPlanCategories, addPlanCategory, reorderPlanCategories, getPlanViews, savePlanViews } from './planSettings.js';

function safeJoin(root: string, ...parts: string[]) {
  const joined = path.join(root, ...parts);
  if (!joined.startsWith(path.resolve(root))) throw new Error("path traversal blocked");
  return joined;
}

export async function buildServer() {
  const app = Fastify({ genReqId:()=>crypto.randomUUID(), logger: { redact: ["req.headers.authorization", "req.body", "res.body"] }, bodyLimit: DIARY_BODY_LIMIT });

  // CORS — 放开 remote 代理和本地
  await app.register(cors, { origin: true, credentials: true });

  // 注册认证（preHandler 钩子解析 session，未登录返回 401）
  registerAuth(app);

  // 按用户隔离的 EntityIndex
  const indexes = new Map<number, EntityIndex>();
  const getIndex = async (userId: number): Promise<EntityIndex> => {
    let idx = indexes.get(userId);
    if (!idx) {
      idx = new EntityIndex(userId);
      await idx.rebuild();
      indexes.set(userId, idx);
    }
    return idx;
  };

  /* ── 认证路由 ── */
  app.post<{ Body: { username: string; password: string } }>("/api/auth/register", async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) return reply.code(400).send({ error: "用户名和密码不能为空" });
    if (username.length < 2 || username.length > 80) return reply.code(400).send({ error: "用户名长度 2-80" });
    if (password.length < 6) return reply.code(400).send({ error: "密码至少 6 位" });
    const [existing] = await pool.query("SELECT id FROM users WHERE username = ?", [username]);
    if ((existing as unknown[]).length > 0) return reply.code(409).send({ error: "用户名已被占用" });
    const hash = await hashPassword(password);
    const [result] = await pool.query("INSERT INTO users (username, password_hash) VALUES (?, ?)", [username, hash]);
    const userId = (result as { insertId: number }).insertId;
    const token = await createSession(userId);
    setSessionCookie(reply, token);
    return { id: userId, username };
  });

  app.post<{ Body: { username: string; password: string } }>("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) return reply.code(400).send({ error: "用户名和密码不能为空" });
    const rows = await queryRows<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE username = ?", [username]);
    if (rows.length === 0) return reply.code(401).send({ error: "用户名或密码错误" });
    const user = rows[0];
    if (!(await verifyPassword(password, user.password_hash))) return reply.code(401).send({ error: "用户名或密码错误" });
    const token = await createSession(user.id);
    setSessionCookie(reply, token);
    return { id: user.id, username };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = getSessionToken(request);
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if(config.demoDatabase&&config.host==='127.0.0.1')return {id:1,username:'本地演示'};
    const token = getSessionToken(request);
    if (!token) return reply.code(401).send({ error: "未登录" });
    const userId = await verifySession(token);
    if (!userId) return reply.code(401).send({ error: "登录已过期" });
    const rows = await queryRows<{ id: number; username: string }>("SELECT id, username FROM users WHERE id = ?", [userId]);
    if (rows.length === 0) return reply.code(401).send({ error: "用户不存在" });
    return rows[0];
  });

  /* ── 健康检查 ── */
  app.get("/api/health", async () => ({ ok: true, timezone: config.timezone }));

  app.get<{ Params: { date: string } }>("/api/obsidian/:date", async (request, reply) => {
    const userId = request.userId!;
    const date = assertDate(request.params.date);
    if (!(await loadDiary(date, userId)).exists) return reply.code(404).send({ error: "请先保存这一天的日记" });
    // 已迁移至云端，不再关联本地 Obsidian，返回提示
    return { message: "数据已存储在云端，不再关联本地 Obsidian 文件。" };
  });

  app.get<{ Params: { date: string } }>("/api/diaries/:date", async (request) => {
    const userId = request.userId!;
    return loadDiary(assertDate(request.params.date), userId);
  });

  app.put<{ Params: { date: string } }>("/api/diaries/:date", async (request, reply) => {
    const userId = request.userId!;
    if (request.headers['x-diary-record-version'] !== '2') return reply.code(428).send({ error: '日记结构已升级，请刷新页面后再保存，避免丢失关联。' });
    const expected = String(request.headers["if-match"] || "").replace(/^W\//, "").replace(/^"|"$/g, "");
    if (!expected) return reply.code(428).send({ error: "保存前需要日记版本" });
    const result = await saveDiary(assertDate(request.params.date), request.body, expected, userId);
    try { const idx = await getIndex(userId); await idx.rebuild(); }
    catch (error) {
      app.log.warn({ requestId: request.id, errorType: error instanceof Error ? error.name : 'Error', code: 'CONTEXT_REFRESH_FAILED' }, 'diary saved; index refresh failed');
      return { ...result, warning: { code: 'CONTEXT_REFRESH_FAILED', message: '日记已保存，关联信息稍后刷新' } };
    }
    return result;
  });

  app.get<{ Querystring: { from?: string; to?: string } }>("/api/diaries", async (request) => {
    const userId = request.userId!;
    return { dates: await listDiaryDates(userId, request.query.from, request.query.to) };
  });

  app.get('/api/actions', async (request) => {
    const userId = request.userId!;
    return listActions(userId);
  });
  app.get('/api/schedule', async request => listSchedule(scheduleQuery.parse(request.query),request.userId!));
  app.post('/api/schedule/series', async request => {
    const result=await updateSeries(seriesRequest.parse(request.body),request.userId!);
    const idx=await getIndex(request.userId!);await idx.rebuild();return result;
  });

  app.post('/api/actions', async request => {
    const userId = request.userId!;
    const result = await changeAction(actionRequestSchema.parse(request.body), userId);
    const idx = await getIndex(userId);
    await idx.rebuild();
    return result;
  });

  app.get<{ Querystring: { date?: string } }>("/api/weeks", async (request) => {
    const userId = request.userId!;
    const date = assertDate(request.query.date || todayInTimezone(config.timezone));
    const start = weekStart(date);
    const dates = await listDiaryDates(userId, start, addDays(start, 6));
    return { start, end: addDays(start, 6), entries: await Promise.all(dates.map(async (item) => ({ date: item, document: (await loadDiary(item, userId)).document }))) };
  });

  app.get<{ Querystring: { q?: string; type?: string; limit?: string } }>("/api/entities", async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const type = request.query.type ? entityTypeSchema.parse(request.query.type) : undefined;
    return { entities: idx.list(request.query.q, type, Number(request.query.limit || 100)) };
  });

  app.get<{ Params: { type: string; name: string } }>("/api/entities/:type/:name", async (request, reply) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const type = entityTypeSchema.parse(request.params.type);
    const entity = idx.get(type, request.params.name);
    return entity || reply.code(404).send({ error: "未找到该实体" });
  });

  app.put("/api/place-parent", async request => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const { key, parentKey } = placeParentSchema.parse(request.body);
    await idx.setPlaceParent(key, parentKey);
    return { entities: idx.list("", undefined, 500) };
  });

  app.get("/api/tags", async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const typed = idx.getTags(), shared = await tagLibrary(typed, userId);
    return { tags: Object.fromEntries(Object.keys(typed).map(type => [type, [...new Set([...typed[type as keyof typeof typed], ...shared])]])), sharedTags: shared };
  });

  app.get('/api/tag-library', async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    return { tags: await tagLibrary(idx.getTags(), userId) };
  });

  app.post<{ Body: { tag: string } }>('/api/tag-library', async request => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    await addSharedTag(request.body.tag, userId);
    return { tags: await tagLibrary(idx.getTags(), userId) };
  });

  app.get('/api/plan-categories', async (request) => {
    const userId = request.userId!;
    return { categories: await getPlanCategories(userId) };
  });

  app.post('/api/plan-categories', async request => {
    const userId = request.userId!;
    return addPlanCategory(request.body, userId);
  });

  app.put<{ Body: { ids: string[] } }>('/api/plan-categories/order', async request => {
    const userId = request.userId!;
    return reorderPlanCategories(request.body.ids, userId);
  });

  app.get('/api/plan-views', async (request) => {
    const userId = request.userId!;
    return { views: await getPlanViews(userId) };
  });

  app.put<{ Body: { views: unknown } }>('/api/plan-views', async request => {
    const userId = request.userId!;
    await savePlanViews(request.body.views, userId);
    return { views: await getPlanViews(userId) };
  });

  app.post("/api/tags", async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const input = tagCreateSchema.parse(request.body);
    const typed = await idx.addTag(input.type, input.name), shared = await tagLibrary(typed, userId);
    return { tags: Object.fromEntries(Object.keys(typed).map(type => [type, [...new Set([...typed[type as keyof typeof typed], ...shared])]])) };
  });

  app.post('/api/capture/parse', async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    return parseCapture(captureRequestSchema.parse(request.body), { names: idx.list('', undefined, 500).map(entity => entity.name), tags: await tagLibrary(idx.getTags(), userId),categories:await getPlanCategories(userId) });
  });

  app.post("/api/split-sentence", async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const input = sentenceSplitRequestSchema.parse(request.body);
    return { result: await splitSentenceWithAi(input.sentence, idx.list("", undefined, 500)), mode: "ai" as const };
  });

  /* ── 快捷事实（Quick Facts）：自动发现 + 钉选衰减 ── */
  app.get<{ Querystring: { days?: string; limit?: string } }>("/api/quick-facts", async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const days = Math.min(Math.max(Number(request.query.days || 30), 7), 90);
    const limit = Math.min(Math.max(Number(request.query.limit || 15), 1), 40);
    return { facts: await getAllQuickFacts(idx, days, limit, userId) };
  });

  app.post("/api/quick-facts/pin", async (request) => {
    const userId = request.userId!;
    const idx = await getIndex(userId);
    const input = pinQuickFactRequestSchema.parse(request.body);
    return await pinQuickFact(idx, input, userId);
  });

  app.post<{ Params: { id: string } }>("/api/quick-facts/:id/use", async (request, reply) => {
    const userId = request.userId!;
    const result = await useQuickFact(request.params.id, userId);
    return result || reply.code(404).send({ error: "未找到该快捷事实" });
  });

  app.delete<{ Params: { id: string } }>("/api/quick-facts/:id", async (request, reply) => {
    const userId = request.userId!;
    const ok = await unpinQuickFact(request.params.id, userId);
    return ok ? { ok: true } : reply.code(404).send({ error: "未找到该快捷事实" });
  });

  /** AI 解析待办文本 → 提取标题/截止时间/优先级/清单/标签 */
  app.post<{ Body: { text: string } }>("/api/parse-todo", async (request) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text) return { title: "", dueDate: "", dueTime: "", priority: "medium", list: "", tags: [] };
    return await parseTodoFromText(text);
  });

  /** AI 根据内容推荐标签 */
  app.post<{ Body: { text: string; kind: "idea" | "learn" | "input" } }>("/api/suggest-tags", async (request) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    const kind = request.body?.kind === "learn" || request.body?.kind === "input" ? request.body.kind : "idea";
    if (!text) return [];
    return await suggestTags(text, kind);
  });

  /** 逆向地理编码：经纬度 → 地点名 */
  app.get<{ Querystring: { lat: string; lng: string } }>("/api/reverse-geocode", async (request, reply) => {
    const lat = parseFloat(request.query.lat);
    const lng = parseFloat(request.query.lng);
    if (isNaN(lat) || isNaN(lng)) return reply.code(400).send({ error: "无效的经纬度" });
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&accept-language=zh-CN`;
      const dispatcher = config.ai.proxy ? new ProxyAgent(config.ai.proxy) : undefined;
      const response = await undiciRequest(url, {
        method: "GET",
        headers: { "User-Agent": "DiaryApp/1.0" },
        dispatcher,
        signal: AbortSignal.timeout(10_000),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        return reply.code(502).send({ error: `地理编码服务响应 ${response.statusCode}` });
      }
      const data = await response.body.json() as { address?: Record<string, string>; display_name?: string };
      const addr = data.address || {};
      const name = addr.suburb || addr.neighbourhood || addr.road || addr.city || addr.town || addr.village || addr.county || addr.state || "";
      return { name: name || data.display_name?.split(",")[0] || `${lat.toFixed(4)}, ${lng.toFixed(4)}`, address: data.display_name || "", lat, lng };
    } catch {
      return reply.code(502).send({ error: "地理编码服务不可用" });
    }
  });

  /** AI 为小票生成个性化 remark + 日总结 */
  app.post<{ Body: { receipts: Array<{ id: string; kind: string; content: string; details?: string[] }>; date?: string } }>(
    "/api/receipts/remarks",
    async (request, reply) => {
      if (!config.ai.key) return reply.code(503).send({ error: "尚未配置 AI 服务" });
      const items = request.body.receipts.slice(0, 40);
      const body = JSON.stringify({
        model: config.ai.model,
        temperature: 0.9,
        max_tokens: 1500,
        messages: [
          {
            role: "system",
            content: [
              "你是中文日记小票润色助手。只输出一个 JSON 对象，不要 Markdown。",
              "对象包含 remarks（{小票id: 一句话}）和 daySummary（字符串）。",
              "每张小票的一句话要温暖、具体、不空洞，12-22 字之间。根据 kind 和内容选不同语气：事实偏治愈、新知偏欣喜、输入偏沉静、灵感偏明亮。",
              "daySummary 是对全天 2-3 句的整体感受，要真诚，不要套话。",
              "保持克制，不要用感叹号堆砌，不要说'真棒''加油'这类空洞鼓励。",
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify({ date: request.body.date, items }) },
        ],
      });
      const dispatcher = config.ai.proxy ? new ProxyAgent(config.ai.proxy) : undefined;
      const response = await undiciRequest(`${config.ai.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.key}` },
        body, dispatcher,
        signal: AbortSignal.timeout(20_000),
        headersTimeout: 20_000, bodyTimeout: 20_000,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) { await response.body.dump(); return reply.code(502).send({ error: "AI 响应异常" }); }
      const payload = await response.body.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) return reply.code(502).send({ error: "AI 未返回内容" });
      try {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
        const raw = JSON.parse(fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        const remarks: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw.remarks || {})) {
          if (typeof v === "string" && v.trim()) remarks[k] = v.trim().slice(0, 60);
        }
        const daySummary = typeof raw.daySummary === "string" ? raw.daySummary.trim().slice(0, 80) : "";
        return { remarks, daySummary };
      } catch { return reply.code(502).send({ error: "AI 返回格式异常" }); }
    },
  );

  app.post("/api/weekly-summaries", async (request) => {
    const userId = request.userId!;
    const input = weeklySummaryRequestSchema.parse(request.body || {});
    return generateWeeklySummary(userId, input.date || todayInTimezone(config.timezone), { useAi: input.useAi ?? Boolean(config.ai.key) });
  });

  // Custom parser: save raw multipart body into request.body so handler can parse it manually
  app.addContentTypeParser("multipart/form-data", function (_, payload, done) {
    const chunks: Buffer[] = [];
    payload.on("data", (chunk: Buffer) => chunks.push(chunk));
    payload.on("end", () => { done(null, Buffer.concat(chunks)); });
    payload.on("error", () => { done(null, Buffer.alloc(0)); });
  });

  app.post("/api/upload", async (request, reply) => {
    const userId = request.userId!;
    const boundaryMatch = (request.headers["content-type"] || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) return reply.code(400).send({ error: "缺少 boundary" });
    const boundary = (boundaryMatch[1] || boundaryMatch[2]!).trim();
    const body = request.body as Buffer;
    if (!body || !body.length) return reply.code(400).send({ error: "请求体为空" });
    const delimiter = Buffer.from(`--${boundary}`);
    const closing = Buffer.from(`--${boundary}--`);
    const nameMatch = /name="([^"]+)"(?:;\s*filename="([^"]+)")?/;
    let offset = 0;
    let filename = "";
    let fileBuf: Buffer | null = null;
    while (offset < body.length) {
      const endDelim = body.indexOf(delimiter, offset);
      if (endDelim < 0) break;
      if (body.subarray(endDelim, endDelim + closing.length).equals(closing)) break;
      const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), endDelim);
      if (headerEnd < 0) break;
      const headerText = body.subarray(endDelim + delimiter.length + 2, headerEnd).toString("utf8");
      const valueStart = headerEnd + 4;
      const nextDelim = body.indexOf(delimiter, valueStart);
      if (nextDelim < 0) break;
      const value = body.subarray(valueStart, nextDelim - 2);
      const m = nameMatch.exec(headerText);
      if (m && m[2]) { filename = m[2]; fileBuf = value; }
      offset = nextDelim;
    }
    if (!fileBuf || fileBuf.length === 0) return reply.code(400).send({ error: "未收到文件" });
    const sizeLimit = 8 * 1024 * 1024;
    if (fileBuf.length > sizeLimit) return reply.code(413).send({ error: "文件超过 8MB" });
    const dateParam = (request.query as { date?: string }).date || todayInTimezone(config.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return reply.code(400).send({ error: "日期格式不正确" });
    const ext = path.extname(filename || "").toLowerCase() || ".png";
    const allowed = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf", ".txt"]);
    if (!allowed.has(ext)) return reply.code(400).send({ error: "不支持的文件类型" });
    const yearMonth = dateParam.slice(0, 7);
    // 附件存到服务器磁盘 data/assets/{userId}/{yearMonth}/
    const assetsDir = path.resolve(config.dataDir, "assets", String(userId), yearMonth);
    fs.mkdirSync(assetsDir, { recursive: true });
    const baseName = crypto.randomUUID().replace(/-/g, "");
    const fileName = `${baseName}${ext}`;
    const targetPath = path.join(assetsDir, fileName);
    fs.writeFileSync(targetPath, fileBuf);
    const relPath = `assets/${userId}/${yearMonth}/${fileName}`;
    // 元数据存 assets 表
    const mime = MIME[ext] || "application/octet-stream";
    await pool.query(
      "INSERT INTO assets (user_id, date, filename, path, size, mime) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, dateParam, filename || fileName, relPath, fileBuf.length, mime]
    );
    return { path: relPath, name: filename || fileName, size: fileBuf.length };
  });

  /* ── Assets static serving (images etc.) ── */
  app.get<{ Params: { userId: string; yearMonth: string; file: string } }>("/assets/:userId/:yearMonth/:file", async (request, reply) => {
    const { userId, yearMonth, file } = request.params;
    if (!/^\d+$/.test(userId)) return reply.code(400).send("bad");
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) return reply.code(400).send("bad");
    if (/[\/\\]/.test(file)) return reply.code(400).send("bad");
    const filePath = safeJoin(path.resolve(config.dataDir, "assets"), userId, yearMonth, file);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return reply.code(404).send();
    const ext = path.extname(file).toLowerCase();
    reply.header("Content-Type", MIME[ext] || "application/octet-stream");
    reply.header("Cache-Control", "public, max-age=2592000");
    reply.send(fs.readFileSync(filePath));
  });

  /* ── SPA fallback + 原生静态文件服务 ── */
  app.get("/*", async (request, reply) => {
    const raw = String((request.params as Record<string, string>)["*"] || "");
    const safeRaw = raw.startsWith("/") ? raw.slice(1) : raw;

    const ext = path.extname(safeRaw).toLowerCase();
    if (ext && MIME[ext]) {
      try {
        const filePath = safeJoin(distPath, safeRaw);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const buf = fs.readFileSync(filePath);
          reply.header("Content-Type", MIME[ext]);
          reply.header("Cache-Control", "public, max-age=86400, immutable");
          reply.send(buf);
          return;
        }
      } catch { /* traversal 或文件不存在 → fallback 到 index.html */ }
    }

    const indexPath = safeJoin(distPath, "index.html");
    if (fs.existsSync(indexPath)) {
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("Cache-Control", "no-cache");
      reply.send(fs.readFileSync(indexPath));
      return;
    }
    reply.code(404).send("前端未构建，请先运行 npm run build");
  });

  app.setErrorHandler((error, request, reply) => {
    const detail = error as Error & { statusCode?: number; code?: string; current?: unknown };
    if (detail.statusCode === 409) return reply.code(409).send({ error: detail.message, code: detail.code, current: detail.current, requestId: request.id });
    if (error instanceof ZodError) {
      const issues = validationIssues(error.issues);
      app.log.warn({ requestId: request.id, code: 'VALIDATION_FAILED', issues: issues.map(({ path, code, maximum, minimum }) => ({ path, code, maximum, minimum })) }, 'request validation failed');
      return reply.code(400).send({ error: issues[0]?.message || '请求内容格式不正确', code: 'VALIDATION_FAILED', issues, requestId: request.id });
    }
    const status = detail.statusCode && detail.statusCode >= 400 && detail.statusCode <= 599 ? detail.statusCode : 500;
    const code = status === 401 ? 'AUTH_REQUIRED' : status === 413 ? 'BODY_TOO_LARGE' : status >= 500 ? 'SERVICE_ERROR' : 'REQUEST_FAILED';
    if (status >= 500) app.log.error({ requestId: request.id, errorType: detail.name, code: detail.code || code }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? '服务暂时无法完成请求，请重试' : status===413?'整份日记超过请求大小限制，请拆分记录':detail.message, code, requestId: request.id, ...(status===413?{limit:{maximum:DIARY_BODY_LIMIT,unit:'bytes'}}:{}) });
  });
  return app;
}
