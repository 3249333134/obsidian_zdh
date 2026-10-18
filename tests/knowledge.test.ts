import { describe, expect, it, vi } from 'vitest';
import { KnowledgeIndex, KnowledgeQA, parseRelations, sections } from '../src/knowledge';
import { MemoryVault } from './obsidian';

async function fixture() {
  const vault = new MemoryVault(), metadata = new Map<string, any>();
  const app: any = { vault: Object.assign(vault, { cachedRead: vault.read.bind(vault) }), metadataCache: {
    getFileCache: (f: any) => metadata.get(f.path), getFirstLinkpathDest: (link: string, source: string) => vault.getMarkdownFiles().find(f => f.path === link || f.path === link + '.md' || f.path === source.slice(0, source.lastIndexOf('/') + 1) + link + '.md')
  } };
  const add = async (id: string, text: string, cache: any = {}) => { const f: any = await vault.create(id, text); f.basename = id.split('/').at(-1)!.replace(/\.md$/, ''); metadata.set(id, cache); return f; };
  const tasks: any[] = [], index = new KnowledgeIndex(app, () => tasks);
  return { vault, app, add, index, metadata, tasks };
}
describe('knowledge index', () => {
  it('searches Chinese titles, body, tags and properties while excluding managed materials', async () => {
    const f = await fixture();
    await f.add('项目/发布.md', '发布过程采用阶段验收', { frontmatter: { title: '产品发布方案', owner: '小明', tags: ['增长'] } });
    await f.add('其他/发布.md', '测试知识库搜索');
    await f.add('00_INPUT-输入池/对话记录/旧.md', '产品发布方案');
    await f.add('05_ASSETS-资产库/原始文档/原文.md', '产品发布方案');
    await f.add('.obsidian/plugins/secret.md', '产品发布方案');
    await f.add('备份/副本.md', '产品发布方案');
    await f.add('00_INPUT-输入池/sources/待确认.md', '产品发布方案');
    f.tasks.push({ status: 'review', sourcePath: '00_INPUT-输入池/sources/待确认.md' });
    await f.index.build();
    expect(f.index.notes.size).toBe(2);
    expect(f.index.search('产品发布')[0].note.id).toBe('项目/发布.md');
    expect(f.index.search('阶段验收')[0].note.id).toBe('项目/发布.md');
    expect(f.index.search('增长')).toHaveLength(1); expect(f.index.search('小明')).toHaveLength(1);
    expect(f.index.search('不存在的关键词')).toHaveLength(0);
    expect(f.index.search('发布')).toHaveLength(2);
  });
  it('updates content, tags, renames and removals without stale results', async () => {
    const f = await fixture(), note = await f.add('旧.md', 'legacy-only'); await f.index.build();
    await f.vault.process(note, () => 'new-only'); await f.index.update(note);
    expect(f.index.search('legacy-only')).toHaveLength(0);
    expect(f.index.search('new-only')).toHaveLength(1);
    f.index.remove('旧.md'); await f.vault.rename(note, '新.md'); await f.index.update(note);
    expect(f.index.search('new-only')[0].note.id).toBe('新.md');
    f.index.remove('新.md'); expect(f.index.search('new-only')).toHaveLength(0);
  });
  it('resolves links and tags, keeps isolated hits, and bounds the initial graph', async () => {
    const f = await fixture();
    await f.add('a.md', '主题', { links: [{ link: 'b#标题' }], tags: [{ tag: '#相同' }] });
    await f.add('b.md', '资料'); await f.add('c.md', '主题', { frontmatter: { tags: ['相同'] } });
    await f.add('孤立.md', '主题');
    for (let i = 0; i < 160; i++) await f.add(`其他${i}.md`, '主题', { tags: [{ tag: '#相同' }] });
    await f.index.build(); const graph = f.index.graph(f.index.search('主题'), 50);
    expect(graph.nodes.length).toBeLessThanOrEqual(150);
    expect(f.index.relations()).toContainEqual({ from: 'a.md', to: 'b.md', type: 'link', reason: '笔记中的已有链接' });
    expect(f.index.neighbors('a.md').find(n => n.id === 'c.md')?.type).toBe('tag');
    expect(f.index.graph(f.index.search('主题').filter(h => h.note.id === '孤立.md'), 50).nodes).toHaveLength(1);
  });
});
describe('graph grounded AI', () => {
  it('rejects unknown nodes and invalid formats', () => {
    expect(parseRelations(JSON.stringify({ relations: [{ from: 'a', to: 'missing', reason: '猜测' }, { from: 'a', to: 'b', reason: '' }, { from: 'a', to: 'b', reason: '共同方法' }] }), new Set(['a', 'b']))).toEqual([{ from: 'a', to: 'b', type: 'ai', reason: '共同方法' }]);
    expect(() => parseRelations('{}', new Set())).toThrow();
    const excerpts = new Map([['a', '通过游标去重'], ['b', '采用游标去重方法']]);
    expect(parseRelations(JSON.stringify({ relations: [{ from: 'a', to: 'b', reason: '同一方法', evidenceFrom: '游标去重', evidenceTo: '游标去重' }, { from: 'a', to: 'b', reason: '虚构依据', evidenceFrom: '不存在证据', evidenceTo: '游标去重' }] }), new Set(['a', 'b']), excerpts)).toHaveLength(1);
  });
  it('caches associations by content and model, sends at most 20 notes and redacts credentials', async () => {
    const f = await fixture(); for (let i = 0; i < 25; i++) await f.add(`${i}.md`, '同步方法 api_key=super-secret-value'); await f.index.build();
    const chat = vi.fn(async () => '{"relations":[]}'), save = vi.fn(async () => {}); let model = 'model1';
    const qa = new KnowledgeQA(f.index, {}, save, () => chat, () => model, () => ''); const notes = [...f.index.notes.values()];
    await qa.associate(notes, '同步'); await qa.associate(notes, '同步'); expect(chat).toHaveBeenCalledTimes(1);
    expect(JSON.parse(chat.mock.calls[0][1]).notes).toHaveLength(12); expect(chat.mock.calls[0][1]).not.toContain('super-secret-value');
    notes[0].hash = 'changed'; await qa.associate(notes, '同步'); model = 'model2'; await qa.associate(notes, '同步'); expect(chat).toHaveBeenCalledTimes(3);
  });
  it('traverses two graph layers and prioritizes explicit links', async () => {
    const f = await fixture(); await f.add('a.md', '同步策略', { links: [{ link: 'b' }] }); await f.add('b.md', '中间方法', { links: [{ link: 'c' }] }); await f.add('c.md', '完整过程', { links: [{ link: 'd' }] }); await f.add('d.md', '第三层'); await f.index.build();
    const qa = new KnowledgeQA(f.index, {}, async () => {}, () => vi.fn(), () => 'm', () => '');
    const evidence = qa.evidence('同步', f.index.search('同步'), []);
    expect([...new Set(evidence.map(e => e.id))]).toEqual(['a.md', 'b.md', 'c.md']);
  });
  it('selects relevant long-note chapters, repairs citation errors once and preserves valid references', async () => {
    const f = await fixture(); await f.add('方案.md', '# 前言\n' + '无关'.repeat(2500) + '\n# 同步方案\n关键原因是避免重复写入。'); await f.index.build();
    const chat = vi.fn().mockResolvedValueOnce('{"answer":"虚构 [1]","citations":[{"id":"不存在.md","heading":""}]}').mockResolvedValueOnce('{"answer":"避免重复写入 [1]","citations":[{"id":"方案.md","heading":"同步方案"}]}');
    const qa = new KnowledgeQA(f.index, {}, async () => {}, () => chat, () => 'm', () => '');
    const result = await qa.answer('同步方案原因', [], [], () => true);
    expect(result.citations[0].id).toBe('方案.md'); expect(chat).toHaveBeenCalledTimes(2);
    expect(result.evidence.some(e => e.heading === '同步方案')).toBe(true);
    expect(sections(f.index.notes.get('方案.md')!.text).every(s => s.text.length <= 1800)).toBe(true);
  });
  it('does not call AI without evidence and rejects late or twice-invalid answers', async () => {
    const f = await fixture(); await f.add('a.md', '有效知识'); await f.index.build(); const chat = vi.fn(async () => '{}');
    const qa = new KnowledgeQA(f.index, {}, async () => {}, () => chat, () => 'm', () => '');
    expect((await qa.answer('未知领域', [], [], () => true)).citations).toEqual([]); expect(chat).not.toHaveBeenCalled();
    await expect(qa.answer('有效知识', [], [], () => false)).rejects.toThrow('已停止');
    chat.mockClear(); await expect(qa.answer('有效知识', [], [], () => true)).rejects.toThrow('格式无效'); expect(chat).toHaveBeenCalledTimes(2);
  });
  it('maps short evidence codes and Chinese citation markers to real chapters', async () => {
    const f = await fixture(); await f.add('项目/中文 长路径.md', '# 方案取舍\n采用增量索引以减少重复读取。'); await f.index.build();
    const chat = vi.fn(async () => '以下是结果：\n{"answer":"增量索引减少重复读取【1】","citations":["E1"]}');
    const qa = new KnowledgeQA(f.index, {}, async () => {}, () => chat, () => 'm', () => ''); const answer = await qa.answer('增量索引', [], [], () => true);
    expect(answer.answer).toContain('[1]'); expect(answer.citations).toEqual([{ id: '项目/中文 长路径.md', heading: '方案取舍' }]);
    expect(JSON.parse(chat.mock.calls[0][1]).evidence[0].evidenceId).toBe('E1'); expect(chat.mock.calls[0][1]).not.toContain('项目/中文 长路径.md');
  });
  it('uses original evidence markers without mixing evidence IDs with citation order', async () => {
    const f = await fixture(); await f.add('a.md', '# 方法\n核对交付进度'); await f.add('b.md', '# 结果\n阶段验收减少问题累积'); await f.index.build();
    const chat = vi.fn(async () => '采用阶段验收 [E2]，再核对实际交付 [E1]。');
    const qa = new KnowledgeQA(f.index, {}, async () => {}, () => chat, () => 'm', () => '');
    const result = await qa.answer('核对交付进度 阶段验收', [], [], () => true);
    expect(result.answer).toBe('采用阶段验收 [1]，再核对实际交付 [2]。'); expect(result.citations).toHaveLength(2);
    const unknown = new KnowledgeQA(f.index, {}, async () => {}, () => vi.fn(async () => '虚构事实 [E99]'), () => 'm', () => '');
    await expect(unknown.answer('核对交付进度', [], [], () => true)).rejects.toThrow('引用格式无效');
  });
});
