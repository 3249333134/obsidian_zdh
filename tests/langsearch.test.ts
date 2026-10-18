import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestUrl } from './obsidian';
import { defaultSettings } from '../src/config';
import { LangSearch, requireSearch, searchClient, searchKey } from '../src/web-research';
import { KnowledgeIndex, KnowledgeQA } from '../src/knowledge';
import { ResearchService, researchBody } from '../src/research';

beforeEach(() => requestUrl.mockReset());
afterEach(() => vi.useRealTimers());
const response = (rows: unknown[]) => ({ status: 200, json: { code: 200, data: { webPages: { value: rows } } } });
const page = (n: number) => ({ name: `行业报告 ${n}`, url: `https://example.org/report-${n}`, text: '可核对的网页文字', datePublished: '2026-10-01' });
it('uses a separate LangSearch key and preserves legacy provider behavior', () => {
  const settings = { ...defaultSettings(), apiKey: 'ai-secret', searchApiKey: 'tavily-secret', searchProvider: 'langsearch' as const, langSearchApiKey: '  lang-secret  ' };
  expect(searchKey(settings)).toBe('lang-secret'); expect(searchClient(settings)).toBeInstanceOf(LangSearch);
  expect(searchKey({ ...settings, searchProvider: undefined })).toBe('tavily-secret');
  expect(() => requireSearch({ ...settings, langSearchApiKey: '' })).toThrow('LangSearch');
});
it('uses the official endpoint, bounded full text and source dates without extra extraction calls', async () => {
  requestUrl.mockResolvedValueOnce(response([page(1)])); const client = new LangSearch('lang-secret');
  const sources = await client.search('公开行业分析 lang-secret');
  const options = requestUrl.mock.calls[0][0], body = JSON.parse(options.body!);
  expect(options.url).toBe('https://api.langsearch.com/v1/web-search'); expect(options.headers!.Authorization).toBe('Bearer lang-secret');
  expect(body).toMatchObject({ count: 5, freshness: 'noLimit', contents: { text: { maxCharacters: 3000 } } });
  expect(body.query).not.toContain('lang-secret'); expect(body).not.toHaveProperty('model');
  expect(sources[0]).toMatchObject({ url: page(1).url, title: page(1).name, publishedDate: page(1).datePublished, status: 'read' });
  expect((await client.extract(sources, '行业'))[0].text).toBe(page(1).text); expect(requestUrl).toHaveBeenCalledOnce();
  expect(await client.extract(Array.from({ length: 12 }, () => sources[0]), '公开')).toHaveLength(8);
});
it('rejects unsafe URLs, deduplicates sources, redacts credentials and labels missing text accurately', async () => {
  requestUrl.mockResolvedValueOnce(response([
    { ...page(1), url: 'https://example.org/report-1?utm_source=test', text: 'lang-secret ' + '中'.repeat(4000), name: 'lang-secret' },
    page(1), { ...page(2), url: 'http://127.0.0.1/private' },
    { ...page(3), text: undefined, snippet: '搜索摘要', datePublished: 'invalid' },
    { name: '仅有网址', url: 'https://example.org/info' }
  ]));
  const sources = await new LangSearch('lang-secret').search('公开'); expect(sources).toHaveLength(3);
  expect(sources[0].text.length).toBeLessThanOrEqual(3000); expect(JSON.stringify(sources)).not.toContain('lang-secret');
  expect(sources[1]).toMatchObject({ text: '搜索摘要', status: 'excerpt', publishedDate: undefined });
  expect(sources[2]).toMatchObject({ text: '', status: 'unreadable' });
});
it.each([401, 403, 429, 503])('reports HTTP %s errors without exposing server bodies or keys', async status => {
  requestUrl.mockResolvedValueOnce({ status, json: { message: 'private-body lang-secret' } });
  const error = await new LangSearch('lang-secret').search('public').catch(e => e);
  expect(error.message).toContain(`LangSearch ${status}`); expect(error.message).not.toMatch(/lang-secret|private-body/);
});
it('rejects application errors, invalid shapes and empty connection-test results', async () => {
  const client = new LangSearch('lang-secret');
  requestUrl.mockResolvedValueOnce({ status: 200, json: { code: '401', message: 'lang-secret' } });
  await expect(client.test()).rejects.toThrow('Key 无效');
  requestUrl.mockResolvedValueOnce({ status: 200, json: { code: 200, data: {} } });
  await expect(client.test()).rejects.toThrow('格式无效');
  requestUrl.mockResolvedValueOnce(response([])); expect(await client.search('public')).toEqual([]);
  requestUrl.mockResolvedValueOnce(response([])); await expect(client.test()).rejects.toThrow('未取得可用网页内容');
  requestUrl.mockRejectedValueOnce(new Error('Bearer lang-secret')); await expect(client.test()).rejects.toThrow('无法连接 LangSearch');
});
it('times out and ignores a delayed response', async () => {
  vi.useFakeTimers(); requestUrl.mockReturnValueOnce(new Promise(() => {}));
  const pending = new LangSearch('lang-secret').test(); const rejected = expect(pending).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(45000); await rejected;
});
function research() {
  const settings = { ...defaultSettings(), provider: 'agnes', apiKey: 'private-ai-key', searchApiKey: 'private-tavily-key', searchProvider: 'langsearch' as const, langSearchApiKey: 'private-lang-key' };
  const index = new KnowledgeIndex({} as any, () => []);
  const chat = vi.fn(async (system: string) => system.includes('queries') ? '{"queries":["中国行业规模公开报告","行业用户结构","国际行业竞争对照"]}' : '依据公开报告的综合分析 [E1]。');
  const local = new KnowledgeQA(index, {}, async () => {}, () => chat, () => 'agnes', () => settings.apiKey);
  return { settings, chat, service: new ResearchService(local, () => settings, () => chat) };
}
it('routes research through LangSearch and carries verified URLs into the archive body', async () => {
  const h = research(); requestUrl.mockResolvedValue(response([page(1), page(2), page(3), page(4)]));
  const result = await h.service.answer('行业分析 private-lang-key', [], [], true, () => true, vi.fn());
  expect(requestUrl).toHaveBeenCalledTimes(3); expect(requestUrl.mock.calls.every(([options]) => options.url === 'https://api.langsearch.com/v1/web-search')).toBe(true);
  expect(result.citations[0]).toMatchObject({ kind: 'web', url: page(1).url, publishedDate: '2026-10-01' });
  expect(researchBody(result)).toContain(page(1).url); expect(researchBody(result)).not.toContain('private-lang-key');
  expect(JSON.stringify(h.chat.mock.calls)).not.toContain('private-lang-key');
});
it('stops on quota errors without switching providers or pretending research succeeded', async () => {
  const h = research(); requestUrl.mockResolvedValue({ status: 429, json: { message: 'private-lang-key' } });
  h.chat.mockImplementation(async system => system.includes('queries') ? '{"queries":["行业规模","用户结构","国际对照"]}' : '联网失败，资料不足。以下仅提供通用框架。');
  const result = await h.service.answer('行业分析', [], [], true, () => true, vi.fn());
  expect(requestUrl).toHaveBeenCalledOnce(); expect(result.research?.mode).toBe('degraded');
  expect(result.research?.warnings.join('')).toMatch(/LangSearch 429/); expect(result.citations).toHaveLength(0);
});
