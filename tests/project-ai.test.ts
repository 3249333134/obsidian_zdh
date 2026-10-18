import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryVault } from './obsidian';
import { ProjectStore } from '../src/projects';
import { ProjectAI } from '../src/project-ai';
import { defaultProjectState } from '../src/project-types';
import { defaultSettings } from '../src/config';
import { fingerprint } from '../src/sync-format';
let vault: MemoryVault, store: ProjectStore;
beforeEach(() => { vault = new MemoryVault(); const state = defaultProjectState(); store = new ProjectStore(vault as any, () => state, async () => {}); });
const suggestion = (projectId = '') => JSON.stringify({ projectId, projectTitle: '知识项目', reason: '材料明确说明行动', actions: [{ title: '整理调研报告', reason: '用户明确提出', evidence: '整理调研报告' }] });
it('extracts only source-backed actions, does not create records, and masks all configured credentials', async () => {
  const settings = { ...defaultSettings(), apiKey: 'ai-secret', langSearchApiKey: 'lang-secret', searchApiKey: 'tavily-secret' }, chat = vi.fn(async () => suggestion());
  const ai = new ProjectAI(store, () => settings, () => chat), result = await ai.suggest('接下来整理调研报告 ai-secret lang-secret tavily-secret', '资料.md', 'source-hash');
  expect(result.actions[0].selected).toBe(false); expect(result.status).toBe('pending'); expect(vault.getMarkdownFiles()).toHaveLength(0);
  expect(JSON.stringify(chat.mock.calls)).not.toMatch(/ai-secret|lang-secret|tavily-secret/); expect(chat.mock.calls[0][0]).toContain('不可信数据');
});
it('corrects unknown project identifiers or invented evidence once then fails', async () => {
  const chat = vi.fn(async () => suggestion('unknown-id')), ai = new ProjectAI(store, defaultSettings, () => chat);
  await expect(ai.suggest('整理调研报告', '资料.md', 'hash')).rejects.toThrow('格式或来源无效'); expect(chat).toHaveBeenCalledTimes(2);
  chat.mockClear(); chat.mockResolvedValue(suggestion()); await expect(ai.suggest('只有问候', '资料.md', 'hash')).rejects.toThrow('格式或来源无效'); expect(chat).toHaveBeenCalledTimes(2);
});
it('processes every chunk of long source material including the final action', async () => {
  const text = '开头事实\n' + '普通材料'.repeat(6000) + '\n最后决定整理调研报告';
  const chat = vi.fn(async (system: string, user: string) => system.includes('只输出JSON') ? suggestion() : user.includes('整理调研报告') ? '原文行动：“整理调研报告”' : '资料包含前期事实。');
  const result = await new ProjectAI(store, defaultSettings, () => chat).suggest(text, 'long.md', fingerprint(text));
  expect(result.actions[0].title).toBe('整理调研报告'); expect(chat.mock.calls.length).toBeGreaterThan(3); expect(chat.mock.calls.some(([, payload]) => payload.includes('最后决定整理调研报告'))).toBe(true);
});
it('groups selected legacy documents without changing their contents, rejects unknown source IDs', async () => {
  await vault.create('03_BUILD-项目沉淀/研究.md', '研究资料'); await vault.create('03_BUILD-项目沉淀/决策.md', '方案决策');
  const chat = vi.fn(async () => '{"groups":[{"title":"同一个项目","goal":"研究目标","reason":"主题相同","notes":["N1","N2"]}]}'), ai = new ProjectAI(store, defaultSettings, () => chat);
  const result = await ai.scan(['03_BUILD-项目沉淀/研究.md', '03_BUILD-项目沉淀/决策.md']); expect(result).toHaveLength(1); expect(result[0].paths).toHaveLength(2); expect(store.projects.size).toBe(0);
  chat.mockResolvedValue('{"groups":[{"title":"bad","goal":"goal","reason":"reason","notes":["N99"]}]}'); await expect(ai.scan(['03_BUILD-项目沉淀/研究.md'])).rejects.toThrow('来源无效');
  await expect(ai.scan(['.obsidian/private.md'])).rejects.toThrow('选择');
});
it('reviews actual states and completion dates with source links without executing suggested actions', async () => {
  const p = await store.saveProject({ title: '项目', goal: '交付', status: 'active', category: '工作' });
  await store.saveTask({ title: '尚未完成的工作', projectId: p.id, category: '工作', priority: 'normal', status: 'doing' });
  const chat = vi.fn(async () => '## 本周进展\n任务仍在进行 [S2]。\n## 下周建议\n建议完成核对，不代表已经完成。'), ai = new ProjectAI(store, defaultSettings, () => chat);
  const draft = await ai.review([p.id]); expect(draft.body).toContain('[['); expect(chat.mock.calls[0][1]).toContain('doing'); expect(chat.mock.calls[0][0]).toContain('未完成的不能说完成');
  expect([...store.tasks.values()][0].status).toBe('doing'); expect(vault.getMarkdownFiles()).toHaveLength(2);
  chat.mockResolvedValue('错误引用 [S999]'); await expect(ai.review([p.id])).rejects.toThrow('引用无效');
});
