import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MemoryVault, requestUrl } from './obsidian';
import { defaultSettings, CONVERSATIONS } from '../src/config';
import { fingerprint, mergeMessages, parseExport, parseNativeRecord, redact, shouldAnalyze } from '../src/sync-format';
import { baselineSource, defaultSources, readSourceFile, sourceFiles } from '../src/sync-reader';
import { archiveConversation, defaultSync, SyncEngine } from '../src/sync-engine';
import { analyzeDocument, createChat } from '../src/ai';
import type { Conversation, SyncSource, Task } from '../src/types';
import { analysis } from './fixtures';

let directory: string;
beforeEach(async () => {
  await fs.mkdir('.test-output', { recursive: true }); directory = await fs.mkdtemp(path.resolve('.test-output/sync-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
});
afterEach(async () => {
  vi.useRealTimers();
  if (!directory.startsWith(path.resolve('.test-output') + path.sep)) throw new Error('Unsafe test cleanup');
  await fs.rm(directory, { recursive: true, force: true });
});
function native(text: string, id = 'm1', role = 'user', time = Date.now()) {
  return JSON.stringify({ id, type: role, role, timestamp: time, sessionId: 'session1', content: [{ type: 'text', text }] }) + '\n';
}
function source(kind: SyncSource['kind'] = 'workbuddy') { return { ...defaultSources().find(s => s.kind === kind)!, directory, enabled: true }; }
function conversation(): Conversation { return { key: 's:c', sourceId: 'workbuddy', sessionId: 'c', title: '测试对话', messages: [], transcriptPath: '', revision: 0, analyzedRevision: 0, lastChangedAt: 0, pendingSince: 0 }; }
function harness(s = source()) {
  const state = { ...defaultSync(), sources: [s] }; const tasks: Task[] = []; const vault = new MemoryVault();
  const settings = { ...defaultSettings(), initialized: true, apiKey: 'mock-key' };
  const enqueue = vi.fn(); const save = vi.fn(async () => {});
  const engine = new SyncEngine({ state, vault: vault as any, settings: () => settings, tasks: () => tasks, save, enqueue, refresh: () => {} });
  return { state, tasks, vault, settings, enqueue, save, engine };
}
it.each(['codex_work_desktop', 'Codex Desktop'])('identifies %s and automatically queues a completed turn', async originator => {
  const s = source('codex'); s.initialized = true;
  const h = harness(s); const filename = path.join(directory, 'turn.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'session1', source: 'vscode', originator } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '记录同步方案的关键取舍' }] } },
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '通过来源元信息与完成事件自动同步' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } }
  ];
  await fs.writeFile(filename, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await h.engine.tick();
  expect(h.state.conversations[0].appName).toBe(originator === 'codex_work_desktop' ? 'Work' : 'Codex');
  expect(h.tasks).toHaveLength(1);
  await h.engine.tick(); expect(h.tasks).toHaveLength(1);
});
describe('source parsers and privacy', () => {
  it('extracts visible Codex messages while excluding tool calls, analysis and event duplicates', () => {
    const record = { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '结论' }] } };
    expect(parseNativeRecord('codex', record, Date.now(), 1)?.message.text).toBe('结论');
    expect(parseNativeRecord('codex', { ...record, payload: { ...record.payload, channel: 'analysis' } }, Date.now(), 2)).toBeNull();
    expect(parseNativeRecord('codex', { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } }, Date.now(), 3)).toBeNull();
    expect(parseNativeRecord('codex', { type: 'response_item', payload: { type: 'function_call' } }, Date.now(), 4)).toBeNull();
  });
  it('excludes WorkBuddy reasoning channels even when they use an assistant text role', () => {
    expect(parseNativeRecord('workbuddy', { role: 'assistant', type: 'assistant', channel: 'analysis', content: '内部推理' }, Date.now(), 0)).toBeNull();
  });
  it('merges stream updates and repeated events using message identity', () => {
    const c = conversation(); const message = { id: 'a', role: 'assistant' as const, timestamp: new Date().toISOString(), text: '初稿' };
    expect(mergeMessages(c, [message])).toBe(true); expect(mergeMessages(c, [message])).toBe(false);
    expect(mergeMessages(c, [{ ...message, text: '完整回答' }])).toBe(true); expect(c.messages).toHaveLength(1); expect(c.messages[0].text).toBe('完整回答');
  });
  it('redacts keys, authorization, query tokens and custom configured credentials', () => {
    const fakeKey = 'sk-' + 'D'.repeat(36);
    const result = redact(`Key ${fakeKey}\nAuthorization: Bearer abc.def\napi_key="value123"\nhttps://a.test/?token=secret\nAPI Key：space-secret\nBasic dXNlcjpwYXNz\nhttps://user:pass@a.test\ncustomvalue`, 'customvalue');
    for (const secret of [fakeKey, 'abc.def', 'value123', 'token=secret', 'space-secret', 'dXNlcjpwYXNz', 'user:pass', 'customvalue']) expect(result).not.toContain(secret);
    expect(result).toContain('[已遮蔽凭据]');
  });
  it('uses placeholders for attachments instead of reading files', () => {
    const parsed = parseNativeRecord('workbuddy', { type: 'user', role: 'user', content: [{ type: 'image_url', image_url: 'private' }] }, Date.now(), 1);
    expect(parsed?.message.text).toBe('[附件未采集]');
  });
  it('recognizes explicit export formats and rejects unknown data', () => {
    expect(parseExport('{"sessionId":"c","messages":[{"id":"1","role":"user","content":"问题"}]}', '.json', 'f', Date.now())[0].message.text).toBe('问题');
    expect(parseExport('正文', '.md', 'f', Date.now())[0].message.text).toBe('正文');
    expect(() => parseExport('{"settings":{}}', '.json', 'f', Date.now())).toThrow('未知');
    expect(() => parseExport('bad', '.jsonl', 'f', Date.now())).toThrow('完整');
  });
  it('quarantines native exports with unknown session provenance', () => {
    expect(() => parseExport(JSON.stringify([{ type: 'session_meta', payload: { source: 'unknown' } }, { role: 'user', content: '不应发送' }]), '.json', 'session', Date.now())).toThrow('隔离');
  });
  it('excludes an internal-agent export even when the remaining records claim user roles', () => {
    expect(parseExport(JSON.stringify([{ type: 'session_meta', payload: { source: { subagent: {} } } }, { role: 'user', content: '内部请求' }]), '.json', 'session', Date.now())).toEqual([]);
  });
});
describe('incremental files', () => {
  it('starts after existing history, handles an incomplete line, and resumes after restart', async () => {
    const s = source(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, native('旧消息'));
    const cursors = await baselineSource(s); await fs.appendFile(file, native('新消息', 'm2').trimEnd());
    const partial = await readSourceFile(s, file, cursors[file]); expect(partial.records).toHaveLength(0);
    await fs.appendFile(file, '\n'); const complete = await readSourceFile(s, file, JSON.parse(JSON.stringify(partial.cursor)));
    expect(complete.records.map(r => r.message.text)).toEqual(['新消息']);
    expect((await readSourceFile(s, file, complete.cursor)).records).toHaveLength(0);
  });
  it('detects truncation/replacement and re-reads complete messages', async () => {
    const s = source(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, native('旧消息'.repeat(60)));
    const first = await readSourceFile(s, file); await fs.writeFile(file, native('新消息', 'm2'));
    expect((await readSourceFile(s, file, first.cursor)).records[0].message.text).toBe('新消息');
  });
  it('extracts Codex session ID from the session header', async () => {
    const s = source('codex'), file = path.join(directory, 'rollout.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'stable-id', source: 'cli' } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '内容' }] } }) + '\n');
    expect((await readSourceFile(s, file)).records[0].sessionId).toBe('stable-id');
  });
  it.each([0, 130000])('excludes Codex subagent rollouts with %s bytes of metadata', async padding => {
    const s = source('codex'), file = path.join(directory, 'agent.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'agent', instructions: 'x'.repeat(padding), source: { subagent: { spawn: {} } } } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '内部任务' }] } }) + '\n');
    expect((await readSourceFile(s, file)).records).toHaveLength(0);
  });
  it('ignores subagents and hidden credential files', async () => {
    const s = source(); await fs.mkdir(path.join(directory, 'subagents')); await fs.writeFile(path.join(directory, 'subagents', 'a.jsonl'), native('内部'));
    await fs.writeFile(path.join(directory, '.key.jsonl'), native('不应读取')); await fs.writeFile(path.join(directory, 'ok.jsonl'), native('有效'));
    expect(await sourceFiles(s)).toEqual([path.join(directory, 'ok.jsonl')]);
  });
  it('skips baseline exports but detects updates to newly imported exports', async () => {
    const s = source('trae'), old = path.join(directory, 'old.md'), fresh = path.join(directory, 'fresh.md');
    await fs.writeFile(old, '旧导出'); const cursors = await baselineSource(s); await fs.writeFile(old, '旧导出已改');
    expect((await readSourceFile(s, old, cursors[old])).records).toHaveLength(0);
    await fs.writeFile(fresh, '新导出'); const first = await readSourceFile(s, fresh);
    expect(first.records[0].message.text).toBe('新导出'); await fs.writeFile(fresh, '新导出更多内容');
    expect((await readSourceFile(s, fresh, first.cursor)).records[0].message.text).toContain('更多');
  });
});
describe('synchronization lifecycle', () => {
  it('baselines, collects only new messages, redacts before storage and deduplicates', async () => {
    const h = harness(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, native('历史'));
    await h.engine.saveSource(h.state.sources[0]); vi.setSystemTime(Date.now() + 1000);
    const fakeKey = 'sk-' + 'E'.repeat(30); await fs.appendFile(file, native('新消息 ' + fakeKey, 'new'));
    await h.engine.tick(); expect(h.state.conversations).toHaveLength(1); expect(h.state.conversations[0].pendingCount).toBe(1);
    const transcript = [...h.vault.contents.values()].join(''); expect(transcript).not.toContain(fakeKey); expect(transcript).not.toContain('历史');
    await h.engine.tick(); expect(h.state.conversations[0].pendingCount).toBe(1);
    expect(h.tasks).toHaveLength(0); vi.setSystemTime(Date.now() + 120000); await h.engine.tick(); expect(h.tasks).toHaveLength(1);
    expect(h.engine.material(h.tasks[0])).toContain('[已遮蔽凭据]'); expect(h.tasks[0].status).toBe('queued');
    expect(JSON.stringify({ state: h.state, tasks: h.tasks })).not.toContain('新消息'); expect(h.vault.contents.size).toBe(0);
  });
  it('pauses a source and resumes from its saved cursor', async () => {
    const h = harness(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.state.sources[0]);
    await h.engine.pause('workbuddy'); vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, native('暂停期间'));
    await h.engine.tick(); expect(h.state.conversations).toHaveLength(0);
    await h.engine.saveSource({ ...h.state.sources[0], enabled: true }); await h.engine.tick(); vi.setSystemTime(Date.now() + 120000); await h.engine.tick(); expect(h.engine.material(h.tasks[0])).toContain('暂停期间');
  });
  it('imports only the requested history interval without advancing native live cursors', async () => {
    const h = harness(), file = path.join(directory, 'chat.jsonl');
    await fs.writeFile(file, native('范围外', 'old', 'user', Date.parse('2026-10-01T04:00:00Z')) + native('范围内', 'selected', 'user', Date.parse('2026-10-10T04:00:00Z')));
    await h.engine.saveSource(h.state.sources[0]); const cursor = h.state.sources[0].cursors[file].offset;
    await h.engine.importHistory('workbuddy', '2026-10-10', '2026-10-10');
    expect(h.engine.material(h.tasks[0])).toContain('范围内'); expect(h.engine.material(h.tasks[0])).not.toContain('范围外'); expect(h.state.sources[0].cursors[file].offset).toBe(cursor);
    expect(h.tasks).toHaveLength(1);
  });
  it('does not commit read progress before a durable knowledge result', async () => {
    const h = harness(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.state.sources[0]);
    vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, native('第一条')); await h.engine.tick();
    const offset = h.state.sources[0].cursors[file].offset;
    await fs.appendFile(file, native('第二条', 'm2')); await h.engine.tick();
    expect(h.state.sources[0].cursors[file].offset).toBe(offset); expect(h.vault.contents.size).toBe(0);
  });
  it('creates a newer revision and supersedes an unconfirmed older suggestion', async () => {
    const h = harness(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, ''); await h.engine.saveSource(h.state.sources[0]);
    vi.setSystemTime(Date.now() + 1000); await fs.appendFile(file, native('第一条')); await h.engine.tick();
    vi.setSystemTime(Date.now() + 120000); await h.engine.tick(); h.tasks[0].status = 'review';
    await fs.appendFile(file, native('第二条', 'm2')); await h.engine.tick(); expect(h.tasks[0].status).toBe('superseded'); expect(h.state.conversations[0].revision).toBe(2);
  });
  it('detects unavailable paths and keeps monitoring errors separate from analysis', async () => {
    const h = harness(); await h.engine.saveSource(h.state.sources[0]); await fs.rm(directory, { recursive: true });
    await h.engine.tick(); expect(h.state.sources[0].error).toContain('来源目录'); expect(h.tasks).toHaveLength(0);
  });
  it('enforces both quiet time and maximum continuous interval', () => {
    const c = { ...conversation(), revision: 1, pendingSince: 0, lastChangedAt: 590000 };
    expect(shouldAnalyze(c, 600000)).toBe(true); expect(shouldAnalyze({ ...c, pendingSince: 590000 }, 600000)).toBe(false);
  });
});
describe('analysis and confirmed updates', () => {
  it('uses Agnes configured endpoint and model', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '连接成功' } }] } } as any);
    await createChat({ ...defaultSettings(), provider: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash', apiKey: 'mock' })('test', 'test');
    const request = vi.mocked(requestUrl).mock.calls.at(-1)![0] as any; expect(request.url).toBe('https://apihub.agnes-ai.com/v1/chat/completions'); expect(JSON.parse(request.body).model).toBe('agnes-2.5-flash');
    expect(JSON.parse(request.body).chat_template_kwargs.enable_thinking).toBe(false);
  });
  it('retains conversations with no reusable knowledge without fabricating a note', async () => {
    const settings = defaultSettings(); const result = await analyzeDocument('你好\n你好', '对话', settings.destinations, [], 12000, async () => '{"hasKnowledge":false,"reason":"只有问候"}', async () => {}, true);
    expect(result.hasKnowledge).toBe(false); expect(result.body).toBe('');
  });
  it('requires an explicit knowledge selection result', async () => {
    const settings = defaultSettings(); await expect(analyzeDocument('text', 'doc', settings.destinations, [], 12000, async () => JSON.stringify(analysis), async () => {}, true)).rejects.toThrow('hasKnowledge');
  });
  it('archives snapshots and updates only after confirmation, preserving the live input', async () => {
    const h = harness(), c = { ...conversation(), revision: 1, transcriptPath: `${CONVERSATIONS}/原始对话.md` };
    await h.vault.create(c.transcriptPath, '持续更新的原始对话');
    const t: Task = { id: 't', name: '对话.md', sourcePath: c.transcriptPath, createdAt: 'now', status: 'review', conversationKey: c.key, revision: 1, transcriptText: '第一版原始对话', analysis: { ...analysis, hasKnowledge: true } };
    await archiveConversation(h.vault as any, h.settings, t, c, h.save); const firstContent = h.vault.contents.get(c.notePath!);
    c.revision = 2; const update: Task = { ...t, id: 't2', status: 'review', revision: 2, transcriptText: '第二版原始对话', analysis: { ...analysis, hasKnowledge: true, body: '新增知识' }, notePath: undefined, originalPath: undefined, conversationArchive: undefined };
    expect(h.vault.contents.get(c.notePath!)).toBe(firstContent);
    await archiveConversation(h.vault as any, h.settings, update, c, h.save);
    expect(update.notePath).toBe(t.notePath); expect(h.vault.contents.get(c.notePath!)).toContain('新增知识'); expect(h.vault.contents.get(c.transcriptPath)).toBe('持续更新的原始对话');
    expect(t.originalPath).toBeUndefined(); expect(update.originalPath).toBeUndefined(); expect([...h.vault.entries.keys()].filter(p => p.includes('原始文档'))).toHaveLength(0);
  });
  it('refuses to overwrite a manually edited archived note', async () => {
    const h = harness(), c = { ...conversation(), revision: 1 };
    const t: Task = { id: 't', name: '对话.md', sourcePath: 'input.md', createdAt: 'now', status: 'review', revision: 1, transcriptText: '原始对话', analysis: { ...analysis, hasKnowledge: true } };
    await archiveConversation(h.vault as any, h.settings, t, c, h.save); h.vault.contents.set(c.notePath!, '我的修改'); c.revision = 2;
    const update: Task = { ...t, id: 't2', revision: 2, transcriptText: '新对话', conversationArchive: undefined };
    await expect(archiveConversation(h.vault as any, h.settings, update, c, h.save)).rejects.toThrow('手动修改'); expect(h.vault.contents.get(c.notePath!)).toBe('我的修改');
  });
  it('moves the same principal note when a confirmed update chooses another library', async () => {
    const h = harness(), c = { ...conversation(), revision: 1 };
    const t: Task = { id: 't', name: '对话.md', sourcePath: 'input.md', createdAt: 'now', status: 'review', revision: 1, transcriptText: '原始对话', analysis: { ...analysis, hasKnowledge: true } };
    await archiveConversation(h.vault as any, h.settings, t, c, h.save); const previousPath = c.notePath!; c.revision = 2;
    const update: Task = { ...t, id: 't2', revision: 2, transcriptText: '更新对话', analysis: { ...analysis, hasKnowledge: true, destinationId: 'wiki' }, conversationArchive: undefined };
    await archiveConversation(h.vault as any, h.settings, update, c, h.save);
    expect(c.notePath).toContain('06_WIKI-知识库/'); expect(h.vault.entries.has(previousPath)).toBe(false);
    expect([...h.vault.entries.keys()].filter(p => p.endsWith('测试方法.md'))).toHaveLength(1);
  });
  it('does not rewrite persisted state on an unchanged monitoring pass', async () => {
    const h = harness(), file = path.join(directory, 'chat.jsonl'); await fs.writeFile(file, native('历史'));
    await h.engine.saveSource(h.state.sources[0]); h.save.mockClear(); await h.engine.tick(); expect(h.save).not.toHaveBeenCalled();
  });
  it('resumes a completed write before task persistence without duplicating files', async () => {
    const h = harness(), c = { ...conversation(), revision: 1 };
    const t: Task = { id: 't', name: '对话.md', sourcePath: 'input.md', createdAt: 'now', status: 'review', revision: 1, transcriptText: '原始对话', analysis: { ...analysis, hasKnowledge: true } };
    await archiveConversation(h.vault as any, h.settings, t, c, h.save); const count = h.vault.entries.size;
    t.status = 'failed'; await archiveConversation(h.vault as any, h.settings, t, c, h.save); expect(h.vault.entries.size).toBe(count); expect(t.status).toBe('done');
  });
});
