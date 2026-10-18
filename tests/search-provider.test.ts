import { beforeEach, expect, it } from 'vitest';
import { requestUrl } from './obsidian';
import { defaultSettings } from '../src/config';
import { AgnesSearch, AGNES_SEARCH_UNAVAILABLE, searchKey, searchClient } from '../src/web-research';

beforeEach(() => requestUrl.mockReset());
const response = () => ({ status: 200, json: { status: 'completed', output: [
  { type: 'web_search_call', status: 'completed' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Obsidian has official documentation [source]', annotations: [{ type: 'url_citation', url: 'https://help.obsidian.md/', title: 'Official help', start_index: 36, end_index: 43 }] }] }
] } });
it('keeps legacy Tavily settings and uses independent provider keys', () => {
  const settings = { ...defaultSettings(), provider: 'agnes', apiKey: 'ai-key', searchApiKey: 'tavily-key', agnesSearchKey: 'search-key' };
  expect(searchKey(settings)).toBe('tavily-key');
  expect(searchKey({ ...settings, searchProvider: 'agnes' })).toBe('ai-key');
  expect(searchKey({ ...settings, searchProvider: 'agnes', agnesSearchUseAIKey: false })).toBe('search-key');
  expect(searchKey({ ...settings, provider: 'openai', searchProvider: 'agnes' })).toBe('search-key');
  expect(() => searchClient({ ...settings, searchProvider: 'agnes', agnesSearchUseAIKey: false, agnesSearchKey: '' })).toThrow('Agnes');
});
it('requires completed native search and real structured citations, never model URLs alone', async () => {
  const client = new AgnesSearch('saved-key');
  requestUrl.mockResolvedValueOnce(response());
  const sources = await client.search('public question');
  expect(sources[0].url).toBe('https://help.obsidian.md/'); expect(sources[0].status).toBe('excerpt');
  const options = requestUrl.mock.calls[0][0], body = JSON.parse(options.body!);
  expect(options.url).toBe('https://apihub.agnes-ai.com/v1/responses'); expect(body.tools).toEqual([{ type: 'web_search_preview' }]); expect(body.store).toBe(false);
  expect(body.input).not.toContain('saved-key');
  const plain = response(); plain.json.output.shift(); requestUrl.mockResolvedValueOnce(plain);
  await expect(client.test()).rejects.toThrow(AGNES_SEARCH_UNAVAILABLE);
  const noAnnotations = response(); noAnnotations.json.output[1].content![0].annotations = []; requestUrl.mockResolvedValueOnce(noAnnotations);
  await expect(client.test()).rejects.toThrow(AGNES_SEARCH_UNAVAILABLE);
});
it('rejects incomplete results, unsafe source URLs and out-of-bounds citations', async () => {
  const client = new AgnesSearch('secret-key');
  const incomplete = response(); incomplete.json.status = 'incomplete'; requestUrl.mockResolvedValueOnce(incomplete);
  await expect(client.test()).rejects.toThrow(AGNES_SEARCH_UNAVAILABLE);
  const unsafe = response(); unsafe.json.output[1].content![0].annotations[0].url = 'http://127.0.0.1/private'; requestUrl.mockResolvedValueOnce(unsafe);
  await expect(client.test()).rejects.toThrow(AGNES_SEARCH_UNAVAILABLE);
  const invalid = response(); invalid.json.output[1].content![0].annotations[0].end_index = 10000; requestUrl.mockResolvedValueOnce(invalid);
  await expect(client.test()).rejects.toThrow(AGNES_SEARCH_UNAVAILABLE);
});
it('reports unsupported search and auth failures without server body or credentials', async () => {
  requestUrl.mockResolvedValueOnce({ status: 400, json: { error: 'secret-key' } });
  await expect(new AgnesSearch('secret-key').test()).rejects.toThrow('不支持');
  requestUrl.mockResolvedValueOnce({ status: 401, json: { error: 'secret-key' } });
  await expect(new AgnesSearch('secret-key').test()).rejects.toThrow('Key 无效');
});
