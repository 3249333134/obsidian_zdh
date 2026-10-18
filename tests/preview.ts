import { Workbench } from '../src/view';
import { defaultSettings } from '../src/config';
import { analysis } from './fixtures';
import type { SyncState } from '../src/types';
const proto = HTMLElement.prototype as any;
proto.empty = function () { this.replaceChildren(); };
proto.addClass = function (...names: string[]) { this.classList.add(...names); };
proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
proto.createEl = function (tag: string, options: any = {}) {
  const element = document.createElement(tag); if (options.text) element.textContent = options.text;
  if (options.cls) element.className = options.cls; if (options.type) element.setAttribute('type', options.type);
  if (options.value !== undefined) element.setAttribute('value', options.value); for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value as string);
  this.appendChild(element); return element;
};
proto.createDiv = function (options: any) { return this.createEl('div', options); };
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') document.body.classList.add('dark');
const settings = defaultSettings(); settings.initialized = params.get('screen') !== 'settings';
const plugin: any = {
  sync: { sources: [{ id: 'codex', kind: 'codex', name: 'Codex / Work 本地会话', executablePath: '', directory: '', enabled: false, initialized: false, cursors: {} },
    { id: 'workbuddy', kind: 'workbuddy', name: 'WorkBuddy', executablePath: '', directory: '', enabled: false, initialized: false, cursors: {} },
    { id: 'trae', kind: 'trae', name: 'TRAE 导出目录', executablePath: '', directory: '', enabled: false, initialized: false, cursors: {} }], conversations: [] } satisfies SyncState,
  state: { settings, tasks: [{ id: 'demo', name: '知识管理方法.docx', sourcePath: '00_INPUT-输入池/sources/知识管理方法.docx', createdAt: '2026-10-14', status: 'review', progress: '等待确认', analysis: { ...analysis,
    title: '从输入到输出：个人知识整理方法', summary: '用输入池承接材料，提取核心方法与案例，通过标签和明确的目标库逐步建立可复用的知识资产。', keyPoints: ['先保留原始材料，避免信息丢失。','按用途归类，而不是只按文件类型。','确认归档前检查 AI 生成的摘要和标签。'], tags: ['知识管理','方法','工作流'], body: '## 收集与理解\n\n把新文档放入输入池，阅读并提取核心概念。\n\n## 整理与复用\n\n将可执行步骤整理到方法库，将具体实践放入案例库。保留来源链接，以便随时回溯。' } }] },
  persist: async () => {}, importFiles: async () => {}, configure: async () => { throw new Error('界面测试不连接 AI，请使用正式插件。'); }, retry: async () => {},
  detectSyncSource: async () => ({ directory: 'C:\\示例\\记录目录', message: '模拟检测 · 正式插件将检测本机目录' }),
  saveSyncSource: async () => {}, syncNow: async () => {}, pauseSyncSource: async () => {}, importSyncHistory: async () => {},
  archive: async (task: any) => { task.status = 'done'; task.notePath = '01_UNDERSTAND-理解层/方法库/示例.md'; }
};
if (params.get('screen') === 'projects') {
  void import('../src/project-view').then(async ({ ProjectView }) => {
    const { localDay, addDays, defaultProjectState } = await import('../src/project-types'); const today = localDay();
    const project = { id: 'preview-project', path: '示例/项目主页.md', hash: '', title: '示例 · 知识产品规划', goal: '把研究证据、产品决策与每周行动放到同一个项目中。此处仅为界面测试数据。', category: '工作', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), notes: [] };
    const tasks = new Map(['核对研究资料的时间与口径', '整理产品功能与优先级', '完成首版交互方案', '复盘本周推进与待办'].map((title, i) => [`preview-task-${i}`, { id: `preview-task-${i}`, path: `示例/任务${i}.md`, hash: '', title, projectId: project.id, category: '工作', status: i === 2 ? 'done' : 'todo', priority: i === 0 ? 'high' : 'normal', plannedDate: i === 3 ? undefined : today, startTime: i === 1 ? '09:00' : undefined, dueDate: addDays(today, i - 1), completedAt: i === 2 ? new Date().toISOString() : undefined, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sources: [] }]));
    const store = { projects: new Map([[project.id, project]]), tasks, issues: [], load: async () => {}, saveTask: async (task: any) => { tasks.set(task.id, task); return task; } };
    const previewPlugin: any = { projects: () => store, projectState: defaultProjectState(), persist: async () => {}, open: async () => {}, openKnowledge: async () => {}, projectAI: () => ({ review: async () => { throw new Error('示例页面不连接 AI 服务。'); } }) };
    const view = new ProjectView({ contentEl: document.getElementById('app'), app: { workspace: { openLinkText: async () => {} } } } as any, previewPlugin); await view.onOpen();
    if (params.get('pane') === 'week') { (view as any).pane = 'week'; view.render(); }
  });
} else {
  const view = new Workbench({ contentEl: document.getElementById('app'), app: { workspace: { openLinkText: async () => {} } } } as any, plugin);
  void view.onOpen().then(() => { if (params.get('screen')) { view.tab = params.get('screen')!; view.render(); } });
}
