import { beforeEach, describe, it, expect, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { analyzeDocument, createChat } from '../src/ai';
import { defaultDestinations, defaultSettings } from '../src/config';
import { analysis } from './fixtures';
beforeEach(() => vi.mocked(requestUrl).mockReset());
describe('AI transport', () => {
  it('shows sanitized provider diagnostics for an unavailable model', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ status: 503, json: { error: { message: 'No channel for model agnes-1.5-flash; secret-key; Bearer abcdefghijklmnop' } } } as any);
    try { await createChat({ ...defaultSettings(), apiKey: 'secret-key' })('test', 'test'); }
    catch (e) {
      expect(String(e)).toContain('No channel for model agnes-1.5-flash');
      expect(String(e)).not.toContain('secret-key'); expect(String(e)).not.toContain('abcdefghijklmnop');
      return;
    }
    throw new Error('Expected unavailable-model error');
  });
  it.each([401, 403, 404, 429, 500])('explains HTTP %s without leaking key or response body', async status => {
    vi.mocked(requestUrl).mockResolvedValue({ status, json: { error: 'secret-key' } } as any);
    await expect(createChat({ ...defaultSettings(), apiKey: 'secret-key' })('test', 'test')).rejects.toThrow(String(status));
    try { await createChat({ ...defaultSettings(), apiKey: 'secret-key' })('test', 'test'); } catch (e) { expect(String(e)).not.toContain('secret-key'); }
  });
  it('handles transport failure and truncated output', async () => {
    const chat = createChat({ ...defaultSettings(), apiKey: 'key' });
    vi.mocked(requestUrl).mockRejectedValue(new Error('key')); await expect(chat('test', 'test')).rejects.toThrow('无法连接');
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { choices: [{ finish_reason: 'length', message: { content: '{}' } }] } } as any);
    await expect(chat('test', 'test')).rejects.toThrow('截断');
  });
  it('sends correct configured endpoint', async () => {
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { choices: [{ message: { content: '成功' }, finish_reason: 'stop' }] } } as any);
    await createChat({ ...defaultSettings(), apiKey: 'key' })('system', 'user');
    expect(vi.mocked(requestUrl).mock.calls[0][0]).toMatchObject({ url: 'https://api.deepseek.com/chat/completions', throw: false });
  });
});
describe('analysis orchestration', () => {
  it('repairs an invalid document format once without accepting an invented destination',async()=>{const chat=vi.fn().mockResolvedValueOnce('# 非结构化回答').mockResolvedValueOnce(JSON.stringify(analysis)),progress=vi.fn(async()=>{});expect((await analyzeDocument('合成事实','材料',defaultDestinations(),[],12000,chat,progress)).title).toBe(analysis.title);expect(chat).toHaveBeenCalledTimes(2);expect(progress).toHaveBeenCalledWith('补正归档建议格式（1/1）');const bad=vi.fn(async()=>JSON.stringify({...analysis,destinationId:'outside'}));await expect(analyzeDocument('材料','材料',defaultDestinations(),[],12000,bad,async()=>{})).rejects.toThrow('未配置');expect(bad).toHaveBeenCalledTimes(2);});
  it('reads all chunks and includes tail in final synthesis', async () => {
    const calls: string[] = [];
    const chat = vi.fn(async (system: string, user: string) => {
      calls.push(user);
      if (system.includes('只输出一个 JSON')) return JSON.stringify(analysis);
      const data = JSON.parse(user); return data.untrustedDocument.includes('尾部结论') ? '尾部结论摘要' : '第一部分摘要';
    });
    const text = 'a'.repeat(2300) + '尾部结论';
    await analyzeDocument(text, 'doc', defaultDestinations(), [], 1000, chat, async () => {});
    expect(chat).toHaveBeenCalledTimes(4); expect(calls.at(-1)).toContain('尾部结论摘要');
    expect(calls.slice(0, 3).map(c => JSON.parse(c).untrustedDocument).join('')).toBe(text);
  });
  it('does not complete if any chunk fails', async () => {
    const chat = vi.fn().mockResolvedValueOnce('摘要').mockRejectedValueOnce(new Error('失败'));
    await expect(analyzeDocument('x'.repeat(2400), 'doc', defaultDestinations(), [], 1000, chat, async () => {})).rejects.toThrow('失败');
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('recursively reduces many summaries without dropping later summaries', async () => {
    let final = ''; const text = 'x'.repeat(11000) + '最后';
    const chat = async (system: string, user: string) => {
      const data = JSON.parse(user);
      if (system.includes('只输出一个 JSON')) { final = data.untrustedDocument; return JSON.stringify(analysis); }
      if (data.untrustedSummaries) return data.untrustedSummaries.join('').includes('末尾') ? '保留末尾' : '汇总';
      return '摘要'.repeat(100) + (data.untrustedDocument.includes('最后') ? '末尾' : '');
    };
    await analyzeDocument(text, 'doc', defaultDestinations(), [], 1000, chat, async () => {});
    expect(final).toContain('末尾');
  });
});
