import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryVault, TFile } from './obsidian';
import { ProjectStore } from '../src/projects';
import { defaultProjectState, PROJECT_ROOT, completion, weekStart, taskMatches, moveSchedule, onDay, type ProjectSuggestion, type ProjectTask } from '../src/project-types';
import { fingerprint } from '../src/sync-format';
let vault: MemoryVault, store: ProjectStore, state: ReturnType<typeof defaultProjectState>;
beforeEach(() => { vault = new MemoryVault(); state = defaultProjectState(); store = new ProjectStore(vault as any, () => state, async () => {}); });
const project = () => store.saveProject({ title: '知识 工作流', goal: '把资料转为行动', category: '工作', status: 'active' });
const raw = (path: string) => vault.contents.get(path) as string;
function changeFM(path: string, patch: Record<string, any>) { const text = raw(path), match = text.match(/^---\n([\s\S]*?)\n---/)!; vault.contents.set(path, text.replace(match[0], '---\n' + JSON.stringify({ ...JSON.parse(match[1]), ...patch }) + '\n---')); }
it('stores projects and tasks as linked Markdown and reconstructs the index', async () => {
  const p = await project(); const t = await store.saveTask({ title: '整理研究依据', projectId: p.id, category: '工作', status: 'todo', priority: 'high', dueDate: '2026-10-20' });
  expect(p.path).toContain(PROJECT_ROOT + '/知识 工作流-'); expect(raw(p.path)).toContain(t.path); expect(raw(t.path)).toContain(p.path);
  const reopened = new ProjectStore(vault as any, () => state, async () => {}); await reopened.load(); expect(reopened.projects.size).toBe(1); expect(reopened.tasks.get(t.id)?.dueDate).toBe('2026-10-20');
});
it('updates status and completion timestamps, excludes canceled tasks and preserves unknown properties and user text', async () => {
  const p = await project(); let t = await store.saveTask({ title: '任务', projectId: p.id, category: '工作', status: 'todo', priority: 'normal' });
  changeFM(t.path, { custom: 'keep' }); vault.contents.set(t.path, raw(t.path) + '\n用户手写记录'); await store.load(); t = store.tasks.get(t.id)!;
  t = await store.saveTask({ ...t, status: 'done' }); expect(t.completedAt).toBeDefined(); expect(raw(t.path)).toContain('用户手写记录'); expect(raw(t.path)).toContain('keep'); expect(completion([t])).toBe(100);
  t = await store.saveTask({ ...t, status: 'todo' }); expect(t.completedAt).toBeUndefined(); expect(completion([t, { ...t, status: 'canceled' }])).toBe(0);
});
it('protects concurrent edits and manually changed managed sections', async () => {
  let p = await project(); vault.contents.set(p.path, raw(p.path) + '\n新的编辑'); await expect(store.saveProject({ ...p, goal: 'new' })).rejects.toThrow('已更新');
  await store.load(); p = store.projects.get(p.id)!; vault.contents.set(p.path, raw(p.path).replace('## 项目目标\n\n把资料转为行动', '## 项目目标\n\n用户修改了管理内容'));
  await store.load(); p = store.projects.get(p.id)!; await expect(store.saveProject({ ...p, goal: 'new' })).rejects.toThrow('手工修改');
  expect(raw(p.path)).toContain('用户修改了管理内容');
});
it('reports duplicate IDs, invalid fields and orphan tasks instead of silently editing', async () => {
  const p = await project(); await vault.create(PROJECT_ROOT + '/副本.md', raw(p.path)); await store.load(); expect(store.projects.size).toBe(0); expect(store.issues).toHaveLength(2);
  await vault.delete(vault.getAbstractFileByPath(PROJECT_ROOT + '/副本.md') as TFile); await store.load();
  const t = await store.saveTask({ title: '孤立任务', projectId: p.id, category: '工作', status: 'todo', priority: 'normal' });
  await vault.delete(vault.getAbstractFileByPath(p.path) as TFile); await store.load(); expect(store.issues.some(i => i.message.includes('所属项目'))).toBe(true);
  changeFM(t.path, { kf_due_date: '2026-02-30' }); await store.load(); expect(store.tasks.size).toBe(0); expect(store.issues[0].message).toContain('日期');
});
it('uses stable IDs after renaming a task and does not recreate a deleted task', async () => {
  const p = await project(); const t = await store.saveTask({ title: '任务', projectId: p.id, category: '工作', status: 'todo', priority: 'normal' });
  const renamed = t.path.replace('任务.md', '新名字.md'); await vault.rename(vault.getAbstractFileByPath(t.path) as TFile, renamed); await store.renameReferences(t.path, renamed); expect(store.tasks.get(t.id)?.path).toBe(renamed); expect(raw(p.path)).toContain(renamed);
  await vault.delete(vault.getAbstractFileByPath(renamed) as TFile); await expect(store.saveTask({ ...t, path: renamed, status: 'done' })).rejects.toThrow('已删除');
});
it('persists operations before writes and resumes partial multi-file writes without duplicates', async () => {
  const p = await project(), original = vault.process.bind(vault); let fail = true;
  vi.spyOn(vault, 'process').mockImplementation(async (file, update) => { if (file.path === p.path && fail) { fail = false; throw new Error('模拟中断'); } return original(file, update); });
  await expect(store.saveTask({ id: 'stable-task-id', title: '中断任务', projectId: p.id, category: '工作', status: 'todo', priority: 'normal' })).rejects.toThrow('模拟中断');
  const pending = state.operations.find(op => op.status === 'pending')!; expect(pending.writes).toHaveLength(2);
  const restored = new ProjectStore(vault as any, () => state, async () => {}); await restored.resume(pending.id); await restored.resume(pending.id);
  expect(vault.getMarkdownFiles()).toHaveLength(2); expect(raw(p.path)).toContain('中断任务.md'); expect(pending.writes).toEqual([]);
});
it('refuses a recovered operation when a target was edited after interruption', async () => {
  const p = await project(); const op = { id: 'unsafe-op', label: '恢复', status: 'pending' as const, paths: [p.path], writes: [{ path: p.path, content: 'replacement', expectedHash: p.hash }] }; state.operations.push(op);
  vault.contents.set(p.path, raw(p.path) + '\nmanual'); await expect(store.resume(op.id)).rejects.toThrow('新修改'); expect(raw(p.path)).toContain('manual');
  op.writes[0].path = '../outside.md'; await expect(store.resume(op.id)).rejects.toThrow('目录');
});
it('accepts only selected proposed actions and de-duplicates later suggestions from the same source', async () => {
  const p = await project(); await vault.create('资料.md', '明确行动：整理调研报告'); const suggestion: ProjectSuggestion = { id: 'suggestion-id', sourcePath: '资料.md', sourceHash: fingerprint('明确行动：整理调研报告'), reason: '公开行动', actions: [{ title: '整理调研报告', reason: '明确提出', evidence: '整理调研报告', selected: true }, { title: '不创建这个', reason: '', evidence: '', selected: false }], status: 'pending', createdAt: 'now' };
  await store.accept(suggestion, p.id); await store.accept(suggestion, p.id); await store.accept({ ...suggestion, id: 'another-id', status: 'pending' }, p.id);
  expect(store.tasks.size).toBe(1); expect(raw(p.path)).toContain('资料.md'); expect(raw('资料.md')).toBe('明确行动：整理调研报告');
  const task = [...store.tasks.values()][0]; expect(task.plannedDate).toBeUndefined(); expect(task.dueDate).toBeUndefined(); expect(task.status).toBe('todo');
});
it('rejects stale suggestions before linking or creating anything', async () => {
  const p = await project(); await vault.create('资料.md', 'new'); const s: ProjectSuggestion = { id: 's-id', sourcePath: '资料.md', sourceHash: fingerprint('old'), reason: '', actions: [], status: 'pending', createdAt: 'now' };
  await expect(store.accept(s, p.id)).rejects.toThrow('已变化'); expect(store.projects.get(p.id)?.notes).toEqual([]);
});
it('saves one review, links it from project home, and protects its manual edits on repeated confirmation', async () => {
  const p = await project(), draft = { id: 'review-id', title: '本周复盘', body: '根据任务记录复盘', from: '2026-10-12', to: '2026-10-18', projectIds: [p.id], sources: [{ path: p.path, hash: p.hash }], createdAt: new Date().toISOString() };
  const path = await store.saveReview(draft); expect(raw(p.path)).toContain(path); vault.contents.set(path, raw(path) + '\n手工补充'); await store.saveReview(draft);
  expect(vault.getMarkdownFiles()).toHaveLength(2); expect(raw(path)).toContain('手工补充');
});
it('renames category properties while preserving bodies and other metadata', async () => {
  const p = await project(); const t = await store.saveTask({ title: '任务', projectId: p.id, category: '工作', status: 'todo', priority: 'normal' });
  const before = raw(t.path).split('\n---\n')[1]; await store.renameCategory('工作', '事业'); expect(store.tasks.get(t.id)?.category).toBe('事业'); expect(raw(t.path).split('\n---\n')[1]).toBe(before);
  await store.renameCategory('事业', '工作'); await store.renameCategory('工作', '事业'); expect(store.tasks.get(t.id)?.category).toBe('事业');
});
it('filters locally and moves timed, cross-day and all-day plans without changing deadlines', () => {
  const task = { id: 'test-task', projectId: 'test-project', title: '跨日', plannedDate: '2026-10-15', startTime: '23:00', endDate: '2026-10-16', endTime: '01:00', dueDate: '2026-10-20', status: 'todo' } as ProjectTask;
  const moved = moveSchedule(task, '2026-10-18', '09:00'); expect(moved).toMatchObject({ plannedDate: '2026-10-18', startTime: '09:00', endDate: '2026-10-18', endTime: '11:00', dueDate: '2026-10-20' });
  expect(weekStart('2026-10-18')).toBe('2026-10-12'); expect(taskMatches(task, 'today', '2026-10-15')).toBe(true); expect(taskMatches(task, 'overdue', '2026-10-21')).toBe(true);
  expect(onDay(task, '2026-10-16')).toBe(true); expect(onDay({ ...task, endTime: '00:00' }, '2026-10-16')).toBe(false);
  expect(taskMatches({ ...task, status: 'canceled' }, 'canceled')).toBe(true); expect(taskMatches(task, 'today', '2026-10-16')).toBe(true);
  const allDay = moveSchedule({ ...task, startTime: undefined, endTime: undefined }, '2026-11-01'); expect(allDay.endDate).toBe('2026-11-02'); expect(allDay.startTime).toBeUndefined();
});
