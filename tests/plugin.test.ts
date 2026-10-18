import { beforeEach, describe, it, expect, vi } from 'vitest';
import KnowledgeFlow from '../src/main';
import { MemoryVault, requestUrl } from './obsidian';
import { defaultSettings } from '../src/config';
import { analysis } from './fixtures';
beforeEach(() => { vi.stubGlobal('window', { setInterval: () => 1 }); });
function plugin() {
  const p = new KnowledgeFlow({} as any, {} as any); const vault = new MemoryVault();
  (p as any).app = { vault, metadataCache: { getFileCache: () => ({ tags: [{ tag: '#已有标签' }] }) }, workspace: { getLeavesOfType: () => [], onLayoutReady: () => {} } };
  return { p, vault };
}
async function settle(p: KnowledgeFlow) {
  for (let n = 0; n < 100; n++) { if (!p.state.tasks.some(t => ['queued','parsing','analyzing'].includes(t.status))) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Queue did not settle');
}
describe('plugin integration', () => {
  it('archives knowledge, links a confirmed project and creates selected actions exactly once', async () => {
    const { p, vault } = plugin(); p.state.settings.initialized = true;
    const project = await p.projects().saveProject({ title: '测试项目', goal: '连接研究与行动', category: '工作', status: 'active' });
    const a = { ...analysis, title: '项目研究', body: '下一步核对研究资料' };
    const task: any = { id: 'research-task', name: '项目研究', status: 'review', sourcePath: '', createdAt: new Date().toISOString(), analysis: a, projectProposalIds: ['proposal-id'], research: { id: 'answer-id', question: '研究', createdAt: 'now', scope: '模拟', queries: [], mode: 'local-general', warnings: [], citations: [] } };
    const { fingerprint } = await import('../src/sync-format');
    p.projectState.suggestions.push({ id: 'proposal-id', draftTaskId: task.id, sourcePath: '', sourceHash: '', materialHash: fingerprint(a.title + '\n' + a.body), projectId: project.id, selected: true, status: 'pending', reason: '用户确认', actions: [{ title: '核对研究资料', reason: '明确行动', evidence: '核对研究资料', selected: true }], createdAt: 'now' });
    p.state.tasks.push(task); await p.archive(task); expect(task.status).toBe('done'); expect(p.projects().tasks.size).toBe(1); expect(p.projectState.suggestions[0].status).toBe('accepted');
    expect(await vault.read(vault.getAbstractFileByPath(project.path) as any)).toContain(task.notePath);
    await p.archive(task); expect(p.projects().tasks.size).toBe(1); expect((p as any).saved.projects.operations.every((op: any) => op.status === 'done')).toBe(true);
  });
  it('tests and saves LangSearch independently, preserves other keys and keeps prior settings after failure', async () => {
    const { p } = plugin(); p.state.settings = { ...defaultSettings(), provider: 'agnes', apiKey: 'agnes-ai-key', searchApiKey: 'tavily-key', agnesSearchKey: 'agnes-search-key' };
    const settings = { ...p.state.settings, searchProvider: 'langsearch' as const, langSearchApiKey: ' lang-key ' };
    requestUrl.mockResolvedValueOnce({ status: 200, json: { code: 200, data: { webPages: { value: [{ url: 'https://example.org/', name: '公开测试', text: '测试正文' }] } } } });
    await p.saveSearchSettings(settings, true);
    expect((p as any).saved.settings).toMatchObject({ provider: 'agnes', apiKey: 'agnes-ai-key', searchProvider: 'langsearch', langSearchApiKey: 'lang-key', searchApiKey: 'tavily-key', agnesSearchKey: 'agnes-search-key' });
    requestUrl.mockResolvedValueOnce({ status: 401, json: {} });
    await expect(p.saveSearchSettings({ ...settings, langSearchApiKey: 'wrong-key' }, true)).rejects.toThrow('Key 无效');
    expect(p.state.settings.langSearchApiKey).toBe('lang-key');
    await p.saveSearchSettings({ ...p.state.settings, searchProvider: 'tavily' }); expect(p.state.settings.langSearchApiKey).toBe('lang-key');
  });
  it('preserves separate search keys, notes and tasks and does not save a failed Agnes test', async () => {
    const { p } = plugin(); p.state.settings = { ...defaultSettings(), provider: 'agnes', apiKey: 'saved-ai', searchApiKey: 'saved-tavily' };
    const settings = { ...p.state.settings, searchProvider: 'agnes' as const, agnesSearchUseAIKey: false, agnesSearchKey: 'separate-agnes' };
    requestUrl.mockResolvedValueOnce({ status: 200, json: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'No actual search' }] }] } });
    await expect(p.saveSearchSettings(settings, true)).rejects.toThrow('未返回');
    expect(p.state.settings.searchProvider).toBeUndefined(); expect(p.state.settings.apiKey).toBe('saved-ai');
    await p.saveSearchSettings(settings);
    expect((p as any).saved.settings).toMatchObject({ searchProvider: 'agnes', agnesSearchKey: 'separate-agnes', searchApiKey: 'saved-tavily', apiKey: 'saved-ai' });
    await p.saveSearchSettings({ ...p.state.settings, searchProvider: 'tavily' });
    expect(p.state.settings.agnesSearchKey).toBe('separate-agnes'); expect(p.state.settings.searchApiKey).toBe('saved-tavily');
    expect(p.state.tasks).toHaveLength(0);
  });
  it('creates one durable research draft and confirms it without an original attachment', async () => {
    const { p, vault } = plugin(); p.state.settings.initialized = true; p.state.settings.apiKey = 'mock-key';
    vi.spyOn(p, 'open').mockResolvedValue();
    requestUrl.mockResolvedValue({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '{"title":"行业研究报告","tags":["行业研究"],"destinationId":"business","reason":"行业观察"}' } }] } });
    const result: any = { answer: '模拟研究结论 [1]', evidence: [], citations: [{ kind: 'web', id: 'https://example.org/', heading: '', title: '模拟资料', url: 'https://example.org/', fetchedAt: '2026-10-15' }], research: { id: 'r1', question: '行业分析', createdAt: '2026-10-15', scope: '模拟', queries: ['公开报告'], mode: 'mixed', warnings: [], citations: [] } }; result.research.citations = result.citations;
    const [a, b] = await Promise.all([p.previewResearch(result), p.previewResearch(result)]);
    expect(a).toBe(b); expect(p.state.tasks).toHaveLength(1); expect((p as any).saved.tasks[0].research.id).toBe('r1');
    expect(vault.getMarkdownFiles()).toHaveLength(0); await p.archive(a);
    expect(a.status).toBe('done'); expect(a.notePath).toContain('商业观察库'); expect(vault.getMarkdownFiles()).toHaveLength(1);
    expect(a.originalPath).toBeUndefined(); expect(await vault.read(vault.getAbstractFileByPath(a.notePath!) as any)).toContain('https://example.org/');
  });
  it('opens knowledge search in the main area and frees space by collapsing the sidebar', async () => {
    const { p } = plugin(); const leaf = { setViewState: vi.fn(async () => {}) }, collapse = vi.fn();
    (p as any).app.workspace = { getLeavesOfType: () => [], getLeaf: vi.fn(() => leaf), revealLeaf: vi.fn(async () => {}), leftSplit: { collapse } };
    await p.openKnowledge(); expect(leaf.setViewState).toHaveBeenCalledWith({ type: 'knowledge-flow-search', active: true }); expect(collapse).toHaveBeenCalledOnce();
  });
  it('preserves jobs that were queued but had not started on restart', async () => {
    const { p } = plugin(); (p as any).saved = { version: 1, settings: defaultSettings(), tasks: [{ id: 'waiting', status: 'queued' }] };
    await p.onload(); expect(p.state.tasks[0].status).toBe('queued');
  });
  it('opens a new left sidebar tab and preserves file explorer and center note', async () => {
    const { p } = plugin(); const leftSplit = {}; const leaves: any[] = [];
    const leftLeaf = { getRoot: () => leftSplit, detach: vi.fn(), setViewState: vi.fn(async () => { leaves.push(leftLeaf); }) };
    const explorer = { detach: vi.fn() }, note = { detach: vi.fn() };
    const workspace = { leftSplit, getLeavesOfType: () => leaves, getLeftLeaf: vi.fn(() => leftLeaf), getLeaf: vi.fn(), revealLeaf: vi.fn(async () => {}) };
    (p as any).app.workspace = workspace;
    await Promise.all([p.open(), p.open()]); await p.open();
    expect(workspace.getLeftLeaf).toHaveBeenCalledExactlyOnceWith(false); expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(leftLeaf.setViewState).toHaveBeenCalledTimes(1); expect(workspace.revealLeaf).toHaveBeenCalledTimes(2);
    expect(explorer.detach).not.toHaveBeenCalled(); expect(note.detach).not.toHaveBeenCalled();
  });
  it('moves the old center workbench entry into the left sidebar', async () => {
    const { p } = plugin(); const leftSplit = {};
    const oldLeaf = { getRoot: () => ({}), detach: vi.fn() };
    const leftLeaf = { getRoot: () => leftSplit, setViewState: vi.fn(async () => {}) };
    (p as any).app.workspace = { leftSplit, getLeavesOfType: () => [oldLeaf], getLeftLeaf: vi.fn(() => leftLeaf), revealLeaf: vi.fn(async () => {}) };
    await p.open(); expect(oldLeaf.detach).toHaveBeenCalledOnce(); expect(leftLeaf.setViewState).toHaveBeenCalledOnce();
  });
  it('fills Key, initializes, imports and confirms into a note', async () => {
    const { p, vault } = plugin();
    vi.mocked(requestUrl).mockImplementation(async options => {
      const input = JSON.parse((options as any).body);
      return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: input.messages[1].content.includes('连接成功') ? '连接成功' : JSON.stringify(analysis) } }] } } as any;
    });
    await p.configure({ ...defaultSettings(), apiKey: 'test-key' });
    expect(p.state.settings.initialized).toBe(true);
    await p.importFiles([{ name: '用户文档.txt', size: 10, arrayBuffer: async () => new TextEncoder().encode('全文内容').buffer } as File]);
    await settle(p); const task = p.state.tasks[0]; expect(task.status).toBe('review');
    expect([...vault.entries.keys()].some(path => path.endsWith('测试方法.md'))).toBe(false);
    task.analysis!.title = '我修改的标题'; await p.archive(task);
    expect(task.status).toBe('done'); expect(task.notePath).toContain('我修改的标题.md');
    expect(vault.contents.get(task.notePath!)).not.toContain('test-key');
    const saved = (p as any).saved; expect(saved.tasks[0].status).toBe('done');
  });
  it('recovers interrupted jobs without automatically resending documents', async () => {
    const { p } = plugin(); (p as any).saved = { version: 1, settings: defaultSettings(), tasks: [{ id: 't', status: 'analyzing' }] };
    await p.onload(); expect(p.state.tasks[0].status).toBe('failed'); expect(p.state.tasks[0].error).toContain('中断');
  });
  it('refuses incompatible persisted data instead of overwriting it', async () => {
    const { p } = plugin(); (p as any).saved = { version: 2, secret: 'keep' };
    await expect(p.onload()).rejects.toThrow('版本'); expect((p as any).saved.secret).toBe('keep');
  });
  it('preserves a long filename extension in source storage', async () => {
    const { p } = plugin(); p.state.settings.initialized = true;
    await p.importFiles([{ name: '长'.repeat(150) + '.txt', size: 4, arrayBuffer: async () => new TextEncoder().encode('text').buffer } as File]);
    expect(p.state.tasks[0].sourcePath.endsWith('.txt')).toBe(true); await settle(p);
  });
  it('marks a conversation with no reusable knowledge as retained', async () => {
    const { p } = plugin(); p.state.settings = { ...defaultSettings(), initialized: true, apiKey: 'mock' };
    const c = { key: 'workbuddy:conversation', sourceId: 'workbuddy', sessionId: 'conversation', title: '问候', messages: [], transcriptPath: 'input.md', revision: 1, analyzedRevision: 0, lastChangedAt: 0, pendingSince: 0 };
    p.sync.conversations.push(c);
    (p as any).syncEngine = { material: () => '你好', complete: async () => { c.analyzedRevision = 1; } };
    const task = { id: 'task', name: '问候.md', sourcePath: 'input.md', createdAt: 'now', status: 'failed' as const, conversationKey: c.key, revision: 1, transcriptText: '你好' };
    p.state.tasks.push(task);
    vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '{"hasKnowledge":false,"reason":"只有问候"}' } }] } } as any);
    await p.retry(task); await settle(p); expect(p.state.tasks[0].status).toBe('retained'); expect(c.analyzedRevision).toBe(1);
  });
  it('does not expose an analysis of an older revision as current review', async () => {
    const { p } = plugin(); p.state.settings = { ...defaultSettings(), initialized: true, apiKey: 'mock' };
    const c = { key: 'workbuddy:conversation', sourceId: 'workbuddy', sessionId: 'conversation', title: '更新对话', messages: [], transcriptPath: 'input.md', revision: 1, analyzedRevision: 0, lastChangedAt: 0, pendingSince: 0 };
    p.sync.conversations.push(c);
    (p as any).syncEngine = { material: () => '第一版', complete: async () => { c.analyzedRevision = 1; } };
    const task = { id: 'task', name: '更新.md', sourcePath: 'input.md', createdAt: 'now', status: 'failed' as const, conversationKey: c.key, revision: 1, transcriptText: '第一版' };
    p.state.tasks.push(task);
    vi.mocked(requestUrl).mockImplementation(async () => {
      c.revision = 2;
      return { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...analysis, hasKnowledge: true, goal: '目标', process: [], reasoning: [], results: [], todos: [] }) } }] } } as any;
    });
    await p.retry(task); await settle(p); expect(p.state.tasks[0].status).toBe('superseded');
  });
});
