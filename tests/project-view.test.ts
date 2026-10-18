// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import { ProjectView } from '../src/project-view';
import { ProjectStore } from '../src/projects';
import { defaultProjectState } from '../src/project-types';
import { MemoryVault } from './obsidian';

beforeAll(() => {
  const p = HTMLElement.prototype as any; p.empty = function () { this.replaceChildren(); }; p.addClass = function (...names: string[]) { this.classList.add(...names); };
  p.createEl = function (tag: string, o: any = {}) { const el = document.createElement(tag); if (o.text) el.textContent = o.text; if (o.cls) el.className = o.cls; if (o.type) el.setAttribute('type', o.type); if (o.value !== undefined) el.setAttribute('value', o.value); for (const [key, value] of Object.entries(o.attr || {})) el.setAttribute(key, String(value)); this.appendChild(el); return el; }; p.createDiv = function (o: any) { return this.createEl('div', o); };
});
async function setup() {
  const root = document.createElement('div'); document.body.replaceChildren(root); const vault = new MemoryVault(), state = defaultProjectState(), store = new ProjectStore(vault as any, () => state, async () => {});
  const app = { vault, workspace: { openLinkText: vi.fn(async () => {}) } }, plugin: any = { projectState: state, projects: () => store, persist: vi.fn(async () => {}), open: vi.fn(), openKnowledge: vi.fn(),openDiaryPlans:vi.fn() };
  const view = new ProjectView({ contentEl: root, app } as any, plugin); await view.onOpen();
  const click = async (label: string) => { [...root.querySelectorAll('button')].find(b => b.textContent === label)!.click(); await Promise.resolve(); };
  const input = (label: string, value: string) => { const row = [...root.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label)!; const control = row.querySelector('input,textarea,select')! as HTMLInputElement; control.value = value; control.dispatchEvent(new Event('input')); return control; };
  return { root, vault, store, view, click, input, app,plugin };
}
it('creates a real project and task through the editor and preserves an unsaved editor during background refresh', async () => {
  const h = await setup(); expect(h.root.textContent).toContain('从一个目标开始'); await h.click('＋ 新建项目'); h.input('项目名称', '真实项目'); h.input('项目目标', '形成知识闭环');
  const editor = h.root.querySelector('.kf-project-editor'); h.view.refresh(); expect(h.root.querySelector('.kf-project-editor')).toBe(editor);
  await h.click('保存项目'); await vi.waitFor(() => expect(h.store.projects.size).toBe(1)); await vi.waitFor(() => expect(h.root.textContent).toContain('进入项目'));
  await h.click('任务列表'); await h.click('＋ 新建任务'); h.input('任务标题', '核对资料'); h.input('独立截止日期（当天结束前）', '2026-10-20'); await h.click('保存任务');
  await vi.waitFor(() => expect(h.store.tasks.size).toBe(1)); await vi.waitFor(() => expect(h.root.textContent).toContain('截止：2026-10-20'));
  expect(h.vault.getMarkdownFiles()).toHaveLength(2);
});
it('opens the canonical Diary week view with the selected project instead of a second calendar rule', async () => {
  const h = await setup(), p = await h.store.saveProject({ title: '项目', goal: '', category: '工作', status: 'active' });
  const task = await h.store.saveTask({ title: '安排执行', projectId: p.id, category: '工作', status: 'todo', priority: 'normal', dueDate: '2026-10-20' });
  h.view.render();h.input('选择项目',p.id).dispatchEvent(new Event('change'));await h.click('周日程');expect(h.plugin.openDiaryPlans).toHaveBeenCalledWith('week',p.id);expect(h.store.tasks.get(task.id)?.dueDate).toBe('2026-10-20');expect(h.store.tasks.get(task.id)?.plannedDate).toBeUndefined();
});
it('finds canceled tasks by their own category and reopens them through the form', async () => {
  const h = await setup(), p = await h.store.saveProject({ title: '工作项目', goal: '', category: '工作', status: 'active' });
  const task = await h.store.saveTask({ title: '重新确认行动', projectId: p.id, category: '个人生活', status: 'canceled', priority: 'normal' });
  h.view.render(); await h.click('任务列表');
  h.input('类别', '个人生活').dispatchEvent(new Event('change'));
  h.input('状态筛选', 'canceled').dispatchEvent(new Event('change'));
  expect(h.root.textContent).toContain(task.title);
  await h.click('编辑'); h.input('任务状态', 'todo'); await h.click('保存任务');
  await vi.waitFor(() => expect(h.store.tasks.get(task.id)?.status).toBe('todo'));
});
