import {annotateRole,type RoleContext} from './role-workflow';
import path from 'node:path';
import { TFile, type Vault } from 'obsidian';
import { CONVERSATIONS, ORIGINALS } from './config';
import { safeName, safePath } from './core';
import { ensureFolder, uniquePath } from './storage';
import type { Analysis, Conversation, ConversationMessage, FileCursor, Settings, SyncSource, SyncState, Task } from './types';
import { baselineSource, defaultSources, detectSource, readSourceFile, sourceFiles } from './sync-reader';
import { cleanVisibleText, fingerprint, redact, shouldAnalyze, type ParsedMessage } from './sync-format';

export const defaultSync = (): SyncState => ({ modeVersion: 2, sources: defaultSources(), conversations: [] });
interface Host { roleContext?:()=>RoleContext|undefined; vault: Vault; state: SyncState; settings: () => Settings; tasks: () => Task[]; save: () => Promise<void>; refresh: () => void; enqueue: () => void }
interface Buffered { message: ConversationMessage; file: string; lane: string; hash: string }
export class SyncEngine {
  private busy = false; private stopped = false;
  private buffers = new Map<string, Map<string, Buffered>>();
  private scans = new Map<string, FileCursor>();
  private snapshots = new Map<string, Buffered[]>();
  constructor(private host: Host) {}
  stop() { this.stopped = true; this.buffers.clear(); this.snapshots.clear(); this.scans.clear(); }
  private async exclusive(work: () => Promise<void>) { if (this.busy) throw new Error('正在同步，请等待本次完成。'); this.busy = true; try { await work(); } finally { this.busy = false; this.host.refresh(); } }
  async detect(input: SyncSource) {
    const found = await detectSource(input); const base = (this.host.vault.adapter as any)?.getBasePath?.();
    if (base) for (const folder of [CONVERSATIONS, ORIGINALS]) {
      const selected = path.resolve(found.directory).toLowerCase(), managed = path.resolve(base, folder).toLowerCase();
      if (selected === managed || managed.startsWith(selected + path.sep) || selected.startsWith(managed + path.sep)) throw new Error('不能监控插件生成的笔记，请选择单独的记录目录。');
    }
    return found;
  }
  async saveSource(input: SyncSource) {
    await this.exclusive(async () => {
      const stored = this.host.state.sources.find(s => s.id === input.id); if (!stored || stored.kind !== input.kind) throw new Error('来源不存在。');
      const found = input.enabled || input.directory.trim() ? await this.detect(input) : undefined;
      const directory = found?.directory || input.directory.trim();
      if (directory !== stored.directory) { stored.initialized = false; stored.cursors = {}; stored.startedAt = undefined; for (const key of this.scans.keys()) if (key.startsWith(stored.id + '|')) this.scans.delete(key); }
      Object.assign(stored, { directory, executablePath: input.executablePath.trim(), enabled: input.enabled, error: undefined, detected: found?.message || stored.detected });
      stored.historyPending ||= [];
      if (stored.enabled && !stored.initialized) { stored.cursors = await baselineSource(stored); stored.initialized = true; stored.startedAt = Date.now(); }
      await this.host.save();
    });
  }
  async pause(id: string) { const s = this.host.state.sources.find(s => s.id === id); if (!s) throw new Error('来源不存在。'); s.enabled = false; await this.host.save(); this.host.refresh(); }
  private pendingFile(sourceId: string, file: string, lane: string) { return [...this.buffers].some(([key, items]) => key.startsWith(sourceId + ':') && [...items.values()].some(m => m.file === file && m.lane === lane)); }
  private hasPending(id: string) { return [...this.buffers].some(([key, items]) => key.startsWith(id + ':') && items.size); }
  private async scan(source: SyncSource, history?: { from: string; to: string }) {
    const lane = history ? `history:${history.from}:${history.to}` : 'live';
    const start = history ? Date.parse(history.from + 'T00:00:00') : 0, end = history ? Date.parse(history.to + 'T23:59:59.999') : Infinity;
    let failed = 0;
    for (const file of await sourceFiles(source)) {
      if (this.stopped || (!history && !source.enabled)) break;
      const scanKey = `${source.id}|${lane}|${file}`;
      try {
        let previous = this.scans.get(scanKey) || (history ? undefined : source.cursors[file]);
        do {
          const batch = await readSourceFile(source, file, previous); if (this.stopped) return failed;
          if (batch.cursor.internal) { const c = this.host.state.conversations.find(c => c.sourceId === source.id && c.sessionId === batch.cursor.sessionId); if (c) { c.excluded = true; this.buffers.delete(c.key); this.supersede(c); } }
          const records = history ? batch.records.filter(r => { const t = Date.parse(r.message.timestamp); return t >= start && t <= end; }) : batch.records;
          this.apply(source, file, lane, records, Boolean(history)); this.scans.set(scanKey, batch.cursor);
          const conversation = this.host.state.conversations.find(c => c.sourceId === source.id && c.sessionId === batch.cursor.sessionId);
          if (conversation) {
            if (batch.cursor.appName && conversation.appName !== batch.cursor.appName) {
              conversation.appName = batch.cursor.appName;
              const note = conversation.notePath && this.host.vault.getAbstractFileByPath(conversation.notePath);
              if (note instanceof TFile && conversation.archivedHash) {
                const old = await this.host.vault.read(note);
                if (fingerprint(old) === conversation.archivedHash) {
                  const updated = old.replace(/^source_app: .*$/m, `source_app: ${JSON.stringify(conversation.appName)}`).replace(/Codex \/ Work 本地会话 · 会话 /g, `${conversation.appName} · 会话 `);
                  if (updated !== old) {
                    await this.host.vault.process(note, content => { if (content !== old) throw new Error('笔记已修改，保留原来源属性。'); return updated; });
                    conversation.archivedHash = fingerprint(updated);
                  }
                }
              }
            }
            if (batch.cursor.turnComplete === true) conversation.completedRevision = conversation.revision;
            if (batch.cursor.turnComplete === false) conversation.completedRevision = undefined;
          }
          // Reading progress is volatile. Commit only after every clean message
          // from the file has a durable knowledge result.
          if (!history && !this.pendingFile(source.id, file, lane) && batch.cursor !== source.cursors[file]) { source.cursors[file] = batch.cursor; await this.host.save(); }
          if (batch.cursor.offset <= (previous?.offset || 0) || batch.cursor.offset >= batch.cursor.size) break;
          previous = batch.cursor;
        } while (!this.stopped);
      } catch (error) { failed++; source.error = error instanceof Error && !('code' in error) ? error.message : '读取来源文件失败，请检查权限或目录。'; }
    }
    return failed;
  }
  async tick(id?: string) {
    if (this.busy || this.stopped) { if (id && this.busy) throw new Error('正在同步，请稍候。'); return; }
    await this.exclusive(async () => {
      const before = JSON.stringify(this.host.state, (key, value) => key === 'lastScanAt' ? undefined : value);
      for (const s of this.host.state.sources.filter(s => s.enabled && (!id || s.id === id))) {
        if (this.stopped) break;
        try {
          if (!s.initialized) { s.cursors = await baselineSource(s); s.initialized = true; s.startedAt = Date.now(); }
          s.error = undefined; let failed = 0;
          for (const history of s.historyPending || []) failed += await this.scan(s, history);
          failed += await this.scan(s); s.lastScanAt = new Date().toISOString();
          if (!failed && !this.hasPending(s.id)) s.historyPending = [];
        } catch { s.error = '无法读取来源目录，请检测来源并检查权限。'; }
      }
      if (!this.stopped) { if (JSON.stringify(this.host.state, (key, value) => key === 'lastScanAt' ? undefined : value) !== before) await this.host.save(); await this.schedule(); }
    });
  }
  async importHistory(id: string, from: string, to: string) {
    const start = Date.parse(from + 'T00:00:00'), end = Date.parse(to + 'T23:59:59.999'); if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('请选择有效日期范围。');
    await this.exclusive(async () => {
      const s = this.host.state.sources.find(s => s.id === id); if (!s) throw new Error('来源不存在。'); s.directory = (await this.detect(s)).directory; s.historyPending ||= [];
      if (!s.historyPending.some(h => h.from === from && h.to === to)) s.historyPending.push({ from, to });
      await this.host.save(); s.error = undefined; const failed = await this.scan(s, { from, to });
      if (failed) s.error = `${failed} 个历史文件读取失败，其他文件已处理；可重试。`;
      if (!failed && !this.hasPending(s.id)) s.historyPending = [];
      for (const c of this.host.state.conversations) if (c.sourceId === id && this.buffers.get(c.key)?.size) c.lastChangedAt = Date.now() - 120000;
      await this.host.save(); await this.schedule();
    });
  }
  private supersede(c: Conversation) { for (const t of this.host.tasks()) if (t.conversationKey === c.key && ['review', 'queued', 'retained', 'failed'].includes(t.status)) { t.status = 'superseded'; t.progress = '对话已有更新或被排除'; t.error = undefined; this.snapshots.delete(t.id); } }
  discard(task: Task) { this.snapshots.delete(task.id); }
  private apply(source: SyncSource, file: string, lane: string, records: ParsedMessage[], history: boolean) {
    for (const record of records) {
      const text = redact(cleanVisibleText(record.message.text), this.host.settings().apiKey); if (!text.trim()) continue;
      const sessionId = record.sessionId || path.basename(file, path.extname(file)), key = source.id + ':' + sessionId;
      let c = this.host.state.conversations.find(c => c.key === key); if (c?.excluded) continue;
      if (!history && Date.parse(record.message.timestamp) < (source.startedAt || 0) && !c?.messageIndex?.[record.message.id]) continue;
      c ||= { key, sourceId: source.id, sessionId, title: '待提炼对话', revision: 0, analyzedRevision: 0, lastChangedAt: 0, pendingSince: 0, messageIndex: {} };
      const message = { ...record.message, text }, hash = fingerprint(JSON.stringify([message.role, message.timestamp, text]));
      const items = this.buffers.get(key) || new Map<string, Buffered>();
      if (c.messageIndex?.[message.id] === hash || Object.values(c.messageIndex || {}).includes(hash) || items.get(message.id)?.hash === hash || [...items.values()].some(m => m.hash === hash)) continue;
      if (!this.host.state.conversations.includes(c)) this.host.state.conversations.push(c);
      if (!items.size) c.pendingSince = Date.now(); items.set(message.id, { message, file, lane, hash }); this.buffers.set(key, items);
      c.revision++; c.pendingCount = items.size; c.lastChangedAt = Date.now();
      c.firstMessageAt = !c.firstMessageAt || message.timestamp < c.firstMessageAt ? message.timestamp : c.firstMessageAt;
      c.lastMessageAt = !c.lastMessageAt || message.timestamp > c.lastMessageAt ? message.timestamp : c.lastMessageAt;
      this.supersede(c);
    }
  }
  material(task: Task): string {
    const c = this.host.state.conversations.find(c => c.key === task.conversationKey), snapshot = this.snapshots.get(task.id);
    if (!c || c.excluded || task.status === 'superseded' || !snapshot?.length) throw new Error('正文尚未恢复，请点击立即同步后重试。');
    return JSON.stringify({ previousKnowledge: c.knowledge || null, messages: snapshot.map(({ message }) => message) });
  }
  async complete(task: Task, analysis: Analysis) {
    const c = this.host.state.conversations.find(c => c.key === task.conversationKey), snapshot = this.snapshots.get(task.id); if (!c || c.excluded || !snapshot) throw new Error('提炼版本不存在。');
    const previous = JSON.parse(JSON.stringify(c)) as Conversation;
    const source = this.host.state.sources.find(s => s.id === c.sourceId)!;
    const previousCursors = { ...source.cursors }, previousHistory = source.historyPending;
    const previousItems = new Map(this.buffers.get(c.key)!);
    const priorKnowledge = c.knowledge;
    if (analysis.hasKnowledge || !priorKnowledge?.hasKnowledge) c.knowledge = analysis;
    task.analysis = !analysis.hasKnowledge && priorKnowledge?.hasKnowledge && !c.notePath ? priorKnowledge : analysis;
    if (analysis.hasKnowledge) c.title = analysis.title; c.analyzedRevision = Math.max(c.analyzedRevision, task.revision || 0); c.messageIndex ||= {};
    const items = this.buffers.get(c.key)!;
    for (const item of snapshot) { c.messageIndex[item.message.id] = item.hash; if (items.get(item.message.id)?.hash === item.hash) items.delete(item.message.id); }
    c.pendingCount = items.size; c.pendingSince = items.size ? Date.now() : 0;
    for (const item of snapshot) if (item.lane === 'live' && !this.pendingFile(source.id, item.file, item.lane)) { const cursor = this.scans.get(`${source.id}|live|${item.file}`); if (cursor) source.cursors[item.file] = cursor; }
    if (source.kind === 'trae') for (const item of snapshot) if (!this.pendingFile(source.id, item.file, item.lane)) {
      const cursor = this.scans.get(`${source.id}|${item.lane}|${item.file}`); if (cursor) source.cursors[item.file] = cursor;
      this.scans.delete(`${source.id}|live|${item.file}`);
    }
    if (!this.hasPending(source.id) && !source.error) source.historyPending = [];
    task.status = c.revision !== task.revision ? 'superseded' : task.analysis.hasKnowledge ? 'review' : 'retained'; task.name = task.analysis.title;
    try { await this.host.save(); }
    catch (error) {
      for (const key of Object.keys(c)) delete (c as any)[key]; Object.assign(c, previous);
      source.cursors = previousCursors; source.historyPending = previousHistory; this.buffers.set(c.key, previousItems); throw error;
    }
    this.snapshots.delete(task.id); this.host.refresh();
  }
  private async schedule() {
    if (!this.host.settings().initialized || !this.host.settings().apiKey.trim()) return;
    let created = false;
    for (const c of this.host.state.conversations) {
      const items = this.buffers.get(c.key); if (c.excluded || !items?.size || !this.host.state.sources.find(s => s.id === c.sourceId)?.enabled || !shouldAnalyze(c, Date.now())) continue;
      const existing = this.host.tasks().find(t => t.conversationKey === c.key && t.revision === c.revision && t.status !== 'superseded');
      if (existing) { if (!this.snapshots.has(existing.id)) this.snapshots.set(existing.id, [...items.values()]); continue; }
      if(!c.roleBound){c.roleContext=this.host.roleContext?.();c.roleBound=true;}
      const task: Task = { roleContext:c.roleContext, id: crypto.randomUUID(), name: c.title, sourcePath: '', status: 'queued', createdAt: new Date().toISOString(), conversationKey: c.key, revision: c.revision, progress: '等待提炼主要信息、过程与思路' };
      this.snapshots.set(task.id, [...items.values()]); this.host.tasks().push(task); c.lastAnalysisAt = Date.now();
      created = true;
    }
    if (created) await this.host.save(); this.host.enqueue();
  }
}

export function renderConversationNote(a: Analysis, c: Conversation, sourceName: string, directory: string): string {
  const q = JSON.stringify;
  return `---\nknowledge_flow_id: ${q(c.key)}\nsource_app: ${q(sourceName)}\nsession_id: ${q(c.sessionId)}\nsource_directory: ${q(directory)}\ntime_from: ${q(c.firstMessageAt || '')}\ntime_to: ${q(c.lastMessageAt || '')}\ntags: ${q(a.tags)}\n---\n\n# ${a.title}\n\n${a.body}\n\n## 来源\n\n${sourceName} · 会话 ${c.sessionId}\n\n分类理由：${a.reason}\n`;
}
export async function archiveConversation(vault: Vault, settings: Settings, task: Task, c: Conversation, save: () => Promise<void>, rename = (file: TFile, destination: string) => vault.rename(file, destination), source?: SyncSource) {
  if (c.excluded) throw new Error('内部 Agent 记录不参与归档。'); if (!task.analysis?.hasKnowledge || !task.revision) throw new Error('没有可归档的知识建议。');
  if (task.revision !== c.revision && !task.conversationArchive) throw new Error('对话已有新消息，请等待最新建议。');
  if (!task.conversationArchive) {
    const d = settings.destinations.find(d => d.enabled && d.id === task.analysis!.destinationId); if (!d) throw new Error('目标库不存在或已停用。');
    const folder = safePath(d.path); await ensureFolder(vault, folder); const sameFolder = c.notePath && c.notePath.slice(0, c.notePath.lastIndexOf('/')) === folder;
    const notePath = sameFolder ? c.notePath! : uniquePath(vault, folder, safeName(task.analysis.title) + '.md');
    task.conversationArchive = { notePath, expected: c.archivedHash, previousNotePath: c.notePath && !sameFolder ? c.notePath : undefined, content: annotateRole(renderConversationNote(task.analysis, c, c.appName || (source?.kind === 'codex' ? '来源未识别' : source?.name || c.sourceId), source?.directory || ''),task.roleContext,folder) };
    task.notePath = notePath; await save();
  }
  const plan = task.conversationArchive; safePath(plan.notePath);
  if (plan.previousNotePath) { const old = vault.getAbstractFileByPath(safePath(plan.previousNotePath)); if (old) { if (!(old instanceof TFile) || fingerprint(await vault.read(old)) !== plan.expected) throw new Error('已归档笔记被手动修改，未移动或覆盖。'); if (vault.getAbstractFileByPath(plan.notePath)) throw new Error('新的目标位置被占用。'); await rename(old, plan.notePath); } }
  const existing = vault.getAbstractFileByPath(plan.notePath);
  if (existing) { if (!(existing instanceof TFile)) throw new Error('归档位置被文件夹占用。'); await vault.process(existing, old => { if (old === plan.content) return old; if (!plan.expected || fingerprint(old) !== plan.expected) throw new Error('已归档笔记被手动修改，未覆盖。'); return plan.content; }); }
  else { if (plan.expected) throw new Error('原归档笔记不存在，请恢复笔记后再确认更新。'); await vault.create(plan.notePath, plan.content); }
  c.notePath = plan.notePath; c.archivedHash = fingerprint(plan.content); if ((task.revision || 0) >= c.analyzedRevision) c.knowledge = task.analysis; task.status = 'done'; task.progress = '提炼知识已归档'; task.error = undefined; await save();
}
