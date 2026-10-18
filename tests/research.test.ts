import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryVault, requestUrl } from './obsidian';
import { defaultSettings } from '../src/config';
import { KnowledgeIndex, KnowledgeQA } from '../src/knowledge';
import { ResearchService, archiveResearch, draftAnalysis, researchBody, type ResearchMeta } from '../src/research';
import { Tavily, publicURL, type WebSource } from '../src/web-research';
import { persistentState } from '../src/sync-migration';
import type { Task } from '../src/types';

beforeEach(() => requestUrl.mockReset());
const page = (n: number): WebSource => ({ url: `https://example.org/report-${n}`, title: `公开研究报告 ${n}`, text: `真实资料内容 ${n}`, score: .9, fetchedAt: '2026-10-15T00:00:00Z', publishedDate: '2025-01-01', status: 'excerpt' });
function harness(withLocal = true) {
  const settings = { ...defaultSettings(), apiKey: 'private-ai-key', searchApiKey: 'tvly-secret-123456789012', initialized: true };
  const index = new KnowledgeIndex({} as any, () => []);
  if (withLocal) index.notes.set('项目/资料.md', { id: '项目/资料.md', title: '二次元产品', text: '# 定位\n二次元社区应用的用户定位与产品思路', attributes: '', links: [], tags: [], hash: 'h' });
  const chat = vi.fn(async (system: string) => system.includes('queries') ? '{"queries":["中国二次元行业公开报告","二次元用户竞争格局","日本动漫产业国际对照"]}' : withLocal ? '本地定位 [E1]。网络报告提供行业依据 [E2]。\n## 综合判断\n结合行业变化评估产品机会。' : '网络报告提供行业依据 [E1]。\n## 通用框架\n按用户、供给、竞争分析。');
  const local = new KnowledgeQA(index, {}, async () => {}, () => chat, () => 'm', () => settings.apiKey);
  const web = { search: vi.fn(async () => [page(1), page(2), page(3), page(4)]), extract: vi.fn(async (sources: WebSource[]) => sources.map(s => ({ ...s, status: 'read' as const }))) };
  const service = new ResearchService(local, () => settings, () => chat, () => web);
  return { settings, index, chat, web, service };
}
it('combines local and real web evidence, deduplicates URLs and preserves citation metadata', async () => {
  const h = harness(); const progress = vi.fn(); const result = await h.service.answer('二次元行业分析', [], [], true, () => true, progress);
  expect(h.web.search).toHaveBeenCalledTimes(3); expect(h.web.extract.mock.calls[0][0]).toHaveLength(4);
  expect(result.citations.map(c => c.kind)).toEqual(['local', 'web']); expect(result.citations[1].url).toBe(page(1).url);
  expect(result.research?.queries).toHaveLength(3); expect(result.answer).toContain('[2]');
  const body = researchBody(result); expect(body).toContain('[[项目/资料.md#定位'); expect(body).toContain('https://example.org/report-1'); expect(body).toContain('2025-01-01');
});
it('researches without any local notes instead of refusing the question', async () => {
  const h = harness(false); const result = await h.service.answer('二次元行业分析', [], [], true, () => true, vi.fn());
  expect(result.citations[0].kind).toBe('web'); expect(result.evidence).toHaveLength(0); expect(h.chat).toHaveBeenCalledTimes(2);
});
it('does not send local paths, note bodies, history answers or keys to the search service', async () => {
  const h = harness(); await h.service.answer('二次元行业分析 private-ai-key', [{ question: '此前问题', answer: 'PRIVATE HISTORY ANSWER' }], [], true, () => true, vi.fn());
  const webCalls = JSON.stringify([h.web.search.mock.calls, h.web.extract.mock.calls]);
  expect(webCalls).not.toContain('项目/资料.md'); expect(webCalls).not.toContain('PRIVATE HISTORY ANSWER'); expect(webCalls).not.toContain('private-ai-key'); expect(webCalls).not.toContain(h.settings.searchApiKey);
});
it('bounds sparse searches at five and makes the degraded mode explicit', async () => {
  const h = harness(false); h.web.search.mockResolvedValue([]); h.chat.mockImplementation(async s => s.includes('queries') ? '{"queries":["行业规模","用户结构","国际对照"]}' : '## 通用框架\n资料不足，可先按供需与竞争结构分析。');
  const result = await h.service.answer('行业分析', [], [], true, () => true, vi.fn());
  expect(h.web.search).toHaveBeenCalledTimes(5); expect(h.web.extract).not.toHaveBeenCalled(); expect(result.research?.mode).toBe('degraded'); expect(result.research?.warnings.join('')).toContain('未取得有效资料');
});
it('handles web reading failures as excerpt-only sources and does not claim full reading', async () => {
  const h = harness(); h.web.extract.mockRejectedValue(new Error('cannot extract'));
  const result = await h.service.answer('二次元行业分析', [], [], true, () => true, vi.fn());
  expect(result.research?.warnings.join('')).toContain('仅使用搜索摘要');
  const prompt = h.chat.mock.calls.at(-1)![1]; expect(prompt).toContain('excerpt'); expect(prompt).toContain('2025-01-01');
});
it('rejects unsafe generated searches without leaking fallback question text', async () => {
  const h = harness(); h.chat.mockResolvedValue('{"queries":["C:\\notes\\secret.md","foo","bar"]}');
  await expect(h.service.answer('私人项目分析', [], [], true, () => true, vi.fn())).rejects.toThrow('安全检索词'); expect(h.web.search).not.toHaveBeenCalled();
});
it('handles greetings locally without adopting a role from notes or requesting AI', async () => {
  const h = harness(); h.settings.searchApiKey = ''; const result = await h.service.answer('你好！', [], [], true, () => true, vi.fn());
  expect(result.answer).toContain('知流工作台'); expect(result.research?.mode).toBe('greeting'); expect(h.chat).not.toHaveBeenCalled(); expect(h.web.search).not.toHaveBeenCalled();
});
it('requires search configuration for online mode but permits local and general analysis', async () => {
  const h = harness(); h.settings.searchApiKey = '';
  await expect(h.service.answer('二次元行业分析', [], [], true, () => true, vi.fn())).rejects.toThrow('Tavily');
  h.chat.mockResolvedValue('本地定位 [E1]。\n## 通用框架\n分析用户与产品。'); const result = await h.service.answer('二次元行业分析', [], [], false, () => true, vi.fn());
  expect(result.research?.mode).toBe('local-general'); expect(h.web.search).not.toHaveBeenCalled();
});
it('stops future searches and rejects late answers when cancellation happens', async () => {
  const h = harness(); let active = true; h.web.search.mockImplementationOnce(async () => { active = false; return [page(1)]; });
  await expect(h.service.answer('二次元行业分析', [], [], true, () => active, vi.fn())).rejects.toThrow('已停止'); expect(h.web.search).toHaveBeenCalledTimes(1);
});
it('corrects a bad evidence ID once, then fails rather than fabricating a citation', async () => {
  const h = harness(); h.chat.mockImplementation(async s => s.includes('queries') ? '{"queries":["行业规模","用户结构","国际对照"]}' : '错误引用 [E999]');
  await expect(h.service.answer('二次元行业分析', [], [], true, () => true, vi.fn())).rejects.toThrow('引用'); expect(h.chat).toHaveBeenCalledTimes(3);
});
it('only accepts public HTTP URLs and strips tracking parameters', () => {
  for (const value of ['file:///secret', 'javascript:alert(1)', 'http://localhost/x', 'http://127.1/a', 'http://10.0.0.1/a', 'http://172.16.0.1/a', 'https://user:pass@example.com/', 'https://example.com/?token=secret']) expect(publicURL(value)).toBeUndefined();
  expect(publicURL('https://example.com/report?utm_source=x#chapter')).toBe('https://example.com/report');
});
it('Tavily limits extraction to eight known search URLs and sanitizes errors', async () => {
  requestUrl.mockResolvedValueOnce({ status: 200, json: { results: Array.from({ length: 10 }, (_, i) => ({ url: page(i).url, title: page(i).title, content: page(i).text })) } });
  const client = new Tavily('tvly-secret'); const results = await client.search('公开行业报告'); expect(results).toHaveLength(10);
  requestUrl.mockResolvedValueOnce({ status: 200, json: { results: [{ url: results[0].url, raw_content: '正文' }, { url: 'https://unexpected.org/', raw_content: '不要信任' }], failed_results: [] } });
  const read = await client.extract(results, '公开报告'); expect(JSON.parse(requestUrl.mock.calls[1][0].body).urls).toHaveLength(8); expect(read[0].status).toBe('read'); expect(read.some(s => s.url.includes('unexpected'))).toBe(false);
  requestUrl.mockResolvedValueOnce({ status: 401, json: { detail: 'tvly-secret' } }); await expect(client.search('test')).rejects.toThrow('Key 无效');
});
it.each([429, 432, 500])('reports Tavily %s failures without leaking credentials', async status => {
  requestUrl.mockResolvedValueOnce({ status, json: { error: 'tvly-secret' } }); await expect(new Tavily('tvly-secret').search('公开问题')).rejects.toThrow(`Tavily ${status}`);
});
function metadata(): ResearchMeta { return { id: 'answer-id', question: '行业分析', createdAt: '2026-10-15', scope: '中国为主、国际对照', queries: ['公开报告'], mode: 'mixed', warnings: [], citations: [{ id: 'https://example.org/', heading: '', kind: 'web', url: 'https://example.org/' }] }; }
it('archives without an original file, preserves sources and is idempotent across retries', async () => {
  const vault = new MemoryVault(), settings = defaultSettings(); const result = { answer: '研究结论 [1]', citations: metadata().citations, evidence: [], research: metadata() };
  const task: Task = { id: 'task', name: '行业分析', sourcePath: '', createdAt: 'now', status: 'review', research: metadata(), analysis: draftAnalysis(result, settings) };
  await archiveResearch(vault as any, settings, task, async () => {}); const first = task.notePath!;
  await archiveResearch(vault as any, settings, task, async () => {}); expect(vault.getMarkdownFiles()).toHaveLength(1); expect(await vault.read(vault.getAbstractFileByPath(first) as any)).toContain('https://example.org/');
  expect(task.originalPath).toBeUndefined(); const state = persistentState({ version: 1, settings, tasks: [task] }); expect(JSON.stringify(state.tasks)).not.toContain('raw_content');
});
it('reserves a unique path and protects edits after an interrupted archive', async () => {
  const vault = new MemoryVault(), settings = defaultSettings(), result = { answer: '报告', citations: [], evidence: [], research: metadata() };
  await vault.create('00_INPUT-输入池/Inbox/行业分析.md', 'user note');
  const task: Task = { id: 't', name: '行业分析', sourcePath: '', createdAt: 'now', status: 'review', research: metadata(), analysis: draftAnalysis(result, settings) };
  let writes = 0; await expect(archiveResearch(vault as any, settings, task, async () => { if (++writes === 2) throw new Error('interruption'); })).rejects.toThrow('interruption');
  expect(task.notePath).toContain('(2).md'); task.status = 'failed'; await archiveResearch(vault as any, settings, task, async () => {}); expect(vault.getMarkdownFiles()).toHaveLength(2);
  task.status = 'failed'; await vault.process(vault.getAbstractFileByPath(task.notePath!) as any, () => 'manual edit'); await expect(archiveResearch(vault as any, settings, task, async () => {})).rejects.toThrow('手工修改');
});
