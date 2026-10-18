import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultSettings } from '../src/config';
import { defaultSync, SyncEngine, archiveConversation } from '../src/sync-engine';
import { cleanVisibleText, fingerprint, parseNativeRecord } from '../src/sync-format';
import { analyzeDocument } from '../src/ai';
import { migrateConversationState, persistentState } from '../src/sync-migration';
import { MemoryVault } from './obsidian';
import { readSourceFile } from '../src/sync-reader';
import type { State, Task } from '../src/types';

let root: string;
beforeEach(async () => { await fs.mkdir('.test-output', { recursive: true }); root = await fs.mkdtemp(path.resolve('.test-output/knowledge-')); await fs.mkdir(path.join(root, 'records')); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z')); });
afterEach(async () => { vi.useRealTimers(); if (!root.startsWith(path.resolve('.test-output') + path.sep)) throw new Error('Unsafe cleanup'); await fs.rm(root, { recursive: true, force: true }); });
const knowledge = { hasKnowledge: true, title: '导入功能修复', goal: '可靠同步知识', keyPoints: ['仅保存知识'], process: ['定位角色误判', '改为过滤后提炼'], reasoning: ['采用内存正文以避免日志污染'], results: ['完成修复'], todos: ['验证上线'], tags: ['同步'], destinationId: 'methods', reason: '可复用方法' };
const event = (text: string, id = 'one') => JSON.stringify({ type: 'user', role: 'user', id, sessionId: 'session', timestamp: Date.now(), content: text }) + '\n';
function host(state?: State) {
  state ||= { version: 1, settings: { ...defaultSettings(), initialized: true, apiKey: 'mock' }, tasks: [], sync: defaultSync() };
  const source = state.sync!.sources.find(s => s.id === 'workbuddy')!; source.directory = path.join(root, 'records'); source.enabled = true;
  const vault = new MemoryVault(); vault.adapter = { getBasePath: () => root };
  const save = vi.fn(async () => {}); const engine = new SyncEngine({ state: state.sync!, settings: () => state!.settings, tasks: () => state!.tasks, vault: vault as any, save, enqueue: () => {}, refresh: () => {} });
  return { state, source, vault, save, engine };
}
it.each(['<environment_context>secret</environment_context>', 'The following is the Codex agent history added since your last approval assessment.\n[REPL response 58 tool=node_repl.js]\nAPPROVAL REQUEST START', '<node_repl_review_evidence>tools</node_repl_review_evidence>', '[REPL response 59 tool=node_repl.js] data'])('drops runtime user envelopes before collection: %s', text => {
  expect(parseNativeRecord('workbuddy', { type: 'user', role: 'user', content: text }, Date.now(), 0)).toBeNull();
});
it('keeps ordinary discussion quoting a log marker and strips attached context blocks', () => {
  expect(cleanVisibleText('为什么日志里有 [REPL response 58]？')).toContain('[REPL response 58]');
  expect(cleanVisibleText('方案用去重游标。\n<environment_context>secret</environment_context>')).toBe('方案用去重游标。');
});
it('does not write or request AI for wholly internal messages', async () => {
  const h = host(), file = path.join(root, 'records', 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.source);
  await fs.appendFile(file, event('<environment_context>noise</environment_context>')); await h.engine.tick();
  expect(h.state.sync!.conversations).toHaveLength(0); expect(h.state.tasks).toHaveLength(0); expect(h.vault.contents.size).toBe(0);
});
it('replays unfinished messages after restart and never persists bodies or snapshots', async () => {
  const h = host(), file = path.join(root, 'records', 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.source);
  vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, event('真实讨论正文')); await h.engine.tick();
  expect(h.source.cursors[file].offset).toBe(0); expect(JSON.stringify(persistentState(h.state))).not.toContain('真实讨论正文');
  h.engine.stop(); const next = host(persistentState(h.state)); await next.engine.tick();
  vi.setSystemTime(Date.now() + 120000); await next.engine.tick(); const task = next.state.tasks.at(-1)!;
  expect(next.engine.material(task)).toContain('真实讨论正文');
  const a = await analyzeDocument(next.engine.material(task), task.name, next.state.settings.destinations, [], 12000, async () => JSON.stringify(knowledge), async () => {}, true);
  await next.engine.complete(task, a); task.analysis = a; task.status = 'review';
  expect(next.source.cursors[file].offset).toBe((await fs.stat(file)).size); expect(JSON.stringify(persistentState(next.state))).not.toContain('真实讨论正文');
  await archiveConversation(next.vault as any, next.state.settings, task, next.state.sync!.conversations[0], next.save);
  expect(next.vault.contents.size).toBe(1); expect([...next.vault.contents.values()].join('')).toContain('方案取舍与公开思路');
  expect(task.originalPath).toBeUndefined(); expect(task.transcriptText).toBeUndefined();
});
it('holds a shared file cursor until every conversation in the batch is durably processed', async () => {
  const h = host(), file = path.join(root, 'records', 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.source); vi.setSystemTime(Date.now() + 1000);
  await fs.appendFile(file, event('第一会话') + event('第二会话', 'two').replace('"session"', '"other"')); await h.engine.tick(); vi.setSystemTime(Date.now() + 120000); await h.engine.tick();
  const a = await analyzeDocument('text', 'name', h.state.settings.destinations, [], 12000, async () => JSON.stringify(knowledge), async () => {}, true);
  await h.engine.complete(h.state.tasks[0], a); expect(h.source.cursors[file].offset).toBe(0);
  await h.engine.complete(h.state.tasks[1], a); expect(h.source.cursors[file].offset).toBe((await fs.stat(file)).size);
});
it('quarantines incomplete or unknown Codex metadata instead of treating it as user data', async () => {
  const h = host(), file = path.join(root, 'records', 'codex.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'c', source: 'unknown-origin' } }) + '\n' + event('must not be sent'));
  await expect(readSourceFile({ ...h.source, kind: 'codex' }, file)).rejects.toThrow('隔离');
});
it('rolls back completion in memory if saving fails, so a retry can still read the material', async () => {
  const h = host(), file = path.join(root, 'records', 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.source);
  vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, event('暂存正文')); await h.engine.tick(); vi.setSystemTime(Date.now() + 120000); await h.engine.tick();
  const task = h.state.tasks[0], a = await analyzeDocument('正文', 'name', h.state.settings.destinations, [], 12000, async () => JSON.stringify(knowledge), async () => {}, true);
  h.save.mockRejectedValueOnce(new Error('disk')); await expect(h.engine.complete(task, a)).rejects.toThrow('disk');
  expect(h.source.cursors[file].offset).toBe(0); expect(h.engine.material(task)).toContain('暂存正文');
  expect(h.state.sync!.conversations[0].knowledge).toBeUndefined(); await h.engine.complete(task, a);
});
it('preserves stream updates that arrive during analysis and includes the previous knowledge next time', async () => {
  const h = host(), file = path.join(root, 'records', 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.source);
  vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, event('初稿')); await h.engine.tick(); vi.setSystemTime(Date.now() + 120000); await h.engine.tick();
  const first = h.state.tasks[0]; first.status = 'analyzing'; await fs.appendFile(file, event('完整答案')); await h.engine.tick();
  const a = await analyzeDocument('正文', 'name', h.state.settings.destinations, [], 12000, async () => JSON.stringify(knowledge), async () => {}, true);
  await h.engine.complete(first, a); expect(h.source.cursors[file].offset).toBe(0); expect(h.state.sync!.conversations[0].pendingCount).toBe(1);
  vi.setSystemTime(Date.now() + 120000); await h.engine.tick(); const next = h.state.tasks.at(-1)!;
  expect(h.engine.material(next)).toContain('完整答案'); expect(h.engine.material(next)).toContain('可靠同步知识');
});
it.each([false, true])('keeps prior knowledge when new messages have no value; archived=%s', async archived => {
  const h = host(), file = path.join(root, 'records', 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.source);
  vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, event('重要方案')); await h.engine.tick(); vi.setSystemTime(Date.now() + 120000); await h.engine.tick();
  const first = h.state.tasks[0], a = await analyzeDocument('正文', 'name', h.state.settings.destinations, [], 12000, async () => JSON.stringify(knowledge), async () => {}, true);
  await h.engine.complete(first, a); if (archived) await archiveConversation(h.vault as any, h.state.settings, first, h.state.sync!.conversations[0], h.save);
  await fs.appendFile(file, event('谢谢', 'greeting')); await h.engine.tick(); vi.setSystemTime(Date.now() + 120000); await h.engine.tick();
  const next = h.state.tasks.at(-1)!, nothing = await analyzeDocument('谢谢', 'name', h.state.settings.destinations, [], 12000, async () => '{"hasKnowledge":false,"reason":"仅问候"}', async () => {}, true);
  await h.engine.complete(next, nothing); expect(h.state.sync!.conversations[0].knowledge?.goal).toBe('可靠同步知识');
  expect(next.status).toBe(archived ? 'retained' : 'review');
});
it('accepts updates to an explicitly imported export after baselining its old contents', async () => {
  const h = host(); h.source.kind = 'trae'; h.source.id = 'trae'; h.state.sync!.sources = [h.source];
  const file = path.join(root, 'records', 'chat.md'); await fs.writeFile(file, '历史导出'); await fs.utimes(file, new Date(Date.now()), new Date(Date.now())); await h.engine.saveSource(h.source);
  await h.engine.importHistory('trae', '2026-10-14', '2026-10-14'); const task = h.state.tasks[0];
  const a = await analyzeDocument('正文', 'name', h.state.settings.destinations, [], 12000, async () => JSON.stringify(knowledge), async () => {}, true);
  await h.engine.complete(task, a); await fs.writeFile(file, '更新后的导出'); await h.engine.tick();
  expect(h.state.sync!.conversations[0].pendingCount).toBe(1); vi.setSystemTime(Date.now() + 120000); await h.engine.tick(); expect(h.engine.material(h.state.tasks.at(-1)!)).toContain('更新后的导出');
});
it('repairs malformed knowledge once, never defaults missing knowledge flags to true', async () => {
  const chat = vi.fn().mockResolvedValueOnce('{"title":"bad"}').mockResolvedValueOnce(JSON.stringify(knowledge));
  const a = await analyzeDocument('可用讨论', 'name', defaultSettings().destinations, [], 12000, chat, async () => {}, true);
  expect(a.hasKnowledge).toBe(true); expect(chat).toHaveBeenCalledTimes(2);
  const bad = vi.fn(async () => '{}'); await expect(analyzeDocument('讨论', 'name', defaultSettings().destinations, [], 12000, bad, async () => {}, true)).rejects.toThrow('hasKnowledge'); expect(bad).toHaveBeenCalledTimes(2);
});
it('backs up once, removes only unchanged plugin transcripts, clears cached bodies and invalidates old jobs', async () => {
  const h = host(); delete h.state.sync!.modeVersion;
  const original = '旧完整日志'; await h.vault.create('raw.md', original); await h.vault.create('edited.md', '我的修改');
  h.state.sync!.conversations.push({ key: 'workbuddy:old', sourceId: 'workbuddy', sessionId: 'old', title: '环境', messages: [{ id: 'one', role: 'user', timestamp: '', text: original }], transcriptPath: 'raw.md', transcriptHash: fingerprint(original), revision: 1, analyzedRevision: 0, lastChangedAt: 0, pendingSince: 0 });
  h.state.sync!.conversations.push({ ...h.state.sync!.conversations[0], key: 'workbuddy:edit', sessionId: 'edit', transcriptPath: 'edited.md' });
  h.state.tasks.push({ id: 'old', name: 'old', sourcePath: 'raw.md', status: 'analyzing', createdAt: '', conversationKey: 'workbuddy:old', transcriptText: original });
  await migrateConversationState(h.state, h.vault as any);
  expect(h.vault.entries.has('raw.md')).toBe(false); expect(h.vault.contents.get('edited.md')).toBe('我的修改');
  expect(JSON.stringify(persistentState(h.state))).not.toContain(original); expect(h.state.tasks[0].status).toBe('superseded');
  expect(h.source.historyPending).toEqual([{ from: '2026-10-08', to: '2026-10-14' }]);
  const backup = path.join(root, '.obsidian/plugins/knowledge-flow/migration-backup-v03'); const before = await fs.readdir(backup);
  await migrateConversationState(h.state, h.vault as any); expect(await fs.readdir(backup)).toEqual(before); expect(h.state.sync!.migrationWarnings?.[0]).toContain('手工修改');
});
