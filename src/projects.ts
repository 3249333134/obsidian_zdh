import {stagePath,ROLE_ROOT} from './role-workflow';
import { TFile, parseYaml, stringifyYaml, type Vault } from 'obsidian';
import { safeName, safePath } from './core';
import { ensureFolder, uniquePath } from './storage';
import { fingerprint } from './sync-format';
import { todoSchema } from './diary-vendor/contracts';
import { PROJECT_ROOT, REVIEW_ROOT, PROJECT_STATUS, PROJECT_TASK_STATUS, dayDate, type Project, type ProjectTask, type ProjectState, type ProjectOperation, type ProjectSuggestion, type ProjectReviewDraft } from './project-types';

const START = '<!-- knowledge-flow:managed:start -->', END = '<!-- knowledge-flow:managed:end -->';
type Frontmatter = Record<string, any>;
const list = (value: unknown): string[] => { if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error('关联资料或来源应为列表。'); return [...new Set(value)]; };
export function noteLink(path: string): string { safePath(path); if (/[\[\]|#\r\n]/.test(path)) throw new Error('关联文件名包含链接特殊字符，请先在 Obsidian 中重命名。'); return `[[${path}]]`; }
function parts(raw: string): { fm: Frontmatter; body: string } {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { fm: {}, body: raw };
  const fm = parseYaml(match[1]); if (!fm || typeof fm !== 'object' || Array.isArray(fm)) throw new Error('笔记属性格式无效。');
  return { fm, body: raw.slice(match[0].length) };
}
function block(body: string): string { return `${START}\n${body}\n${END}`; }
function document(fm: Frontmatter, managed: string, raw?: string): string {
  if (managed.includes(START) || managed.includes(END)) throw new Error('内容包含插件保留的管理区块标记，请移除后重试。');
  let body = raw === undefined ? '' : parts(raw).body;
  if (raw !== undefined) {
    const first = body.indexOf(START), last = body.indexOf(END);
    if (first < 0 || last < first || body.indexOf(START, first + 1) >= 0 || body.indexOf(END, last + 1) >= 0) throw new Error('插件管理区块缺失或重复，请保留原笔记并修复区块后重试。');
    const current = body.slice(first, last + END.length), expected = parts(raw).fm.kf_block_hash;
    if (typeof expected !== 'string' || fingerprint(current) !== expected) throw new Error('管理区块已被手工修改，未覆盖。请把自定义内容移到区块外，并恢复原区块后重试。');
    body = body.slice(0, first) + block(managed) + body.slice(last + END.length);
  } else body = `\n${block(managed)}\n\n## 我的记录\n\n`;
  return `---\n${stringifyYaml({ ...fm, kf_block_hash: fingerprint(block(managed)) }).trimEnd()}\n---\n${body}`;
}
function title(value: string, maximum = 160) { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n]/.test(value)) throw new Error('请填写 1–160 字的单行标题。'); }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[\w-]{8,80}$/.test(value)) throw new Error('项目或任务标识无效。'); }
export function validateTask(task: ProjectTask) {
  id(task.id); if (task.projectId) id(task.projectId); title(task.title, 2000);
  if (!Object.hasOwn(PROJECT_TASK_STATUS, task.status) || !['high', 'normal', 'low'].includes(task.priority)) throw new Error('任务状态或优先级无效。');
  if (!task.category?.trim() || task.category.length > 40) throw new Error('类别名称应为1–40字。');
  if (task.completedAt && !Number.isFinite(Date.parse(task.completedAt))) throw new Error('完成时间无效。');
  for (const date of [task.plannedDate, task.endDate, task.dueDate]) if (date) dayDate(date);
  for (const time of [task.startTime, task.endTime]) if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间应为 HH:mm。');
  if ((task.startTime || task.endTime || task.endDate) && !task.plannedDate) throw new Error('请先选择执行日期。');
  if (task.endTime && !task.startTime) throw new Error('请先填写开始时间。');
  if (task.endDate && task.plannedDate && task.endDate < task.plannedDate) throw new Error('结束日期不能早于开始日期。');
  if (task.endTime && `${task.endDate || task.plannedDate}T${task.endTime}` <= `${task.plannedDate}T${task.startTime}`) throw new Error('结束时间必须晚于开始时间。');
  for (const source of task.sources) noteLink(source);
}
export class ProjectStore {
  projects = new Map<string, Project>(); tasks = new Map<string, ProjectTask>(); issues: Array<{ path: string; message: string }> = [];
  private queue = Promise.resolve(); private loadVersion = 0;
  constructor(readonly vault: Vault, readonly state: () => ProjectState, private persist: () => Promise<void>) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.catch(() => {}).then(work); this.queue = next.then(() => {}, () => {}); return next; }
  async load() {
    const version = ++this.loadVersion, projects = new Map<string, Project>(), tasks = new Map<string, ProjectTask>(), issues: Array<{ path: string; message: string }> = [], duplicates = new Set<string>();
    for (const file of this.vault.getMarkdownFiles().filter(f => f.path.startsWith(PROJECT_ROOT + '/'))) {
      try {
        const raw = await this.vault.read(file), { fm } = parts(raw); if (!['project', 'project-task'].includes(fm.kf_kind)) continue;
        id(fm.kf_id); title(fm.title, fm.kf_kind === 'project-task' ? 2000 : 160); const entity = { id: fm.kf_id, title: fm.title, path: file.path, hash: fingerprint(raw), category: typeof fm.kf_category === 'string' ? fm.kf_category : '工作', createdAt: fm.kf_created_at, updatedAt: fm.kf_updated_at };
        if (typeof entity.createdAt !== 'string' || typeof entity.updatedAt !== 'string' || !Number.isFinite(Date.parse(entity.createdAt)) || !Number.isFinite(Date.parse(entity.updatedAt))) throw new Error('创建或更新时间格式无效。');
        if (projects.has(entity.id) || tasks.has(entity.id)) { duplicates.add(entity.id); issues.push({ path: projects.get(entity.id)?.path || tasks.get(entity.id)!.path, message: '标识重复，已暂停界面编辑。' }); throw new Error('标识重复，已暂停界面编辑。'); }
        if (fm.kf_kind === 'project') {
          if (!Object.hasOwn(PROJECT_STATUS, fm.kf_status) || typeof fm.kf_goal !== 'string' || !entity.category.trim() || entity.category.length > 40) throw new Error('项目状态、类别或目标格式无效。');
          projects.set(entity.id, { ...entity, goal: fm.kf_goal, status: fm.kf_status, notes: list(fm.kf_notes) });
        } else {
          const task: ProjectTask = { ...entity, roleId:typeof fm.kf_role_id==='string'?fm.kf_role_id:undefined, plan: fm.kf_plan ? todoSchema.parse(fm.kf_plan) : undefined, planDate: fm.kf_plan_date || undefined, projectId: fm.kf_project_id || '', status: fm.kf_status, priority: fm.kf_priority, sources: list(fm.kf_sources), actionKey: fm.kf_action_key || undefined };
          for (const [field, key] of [['plannedDate', 'kf_planned_date'], ['startTime', 'kf_start_time'], ['endDate', 'kf_end_date'], ['endTime', 'kf_end_time'], ['dueDate', 'kf_due_date'], ['completedAt', 'kf_completed_at']] as const) { if (fm[key] != null && fm[key] !== '') { if (typeof fm[key] !== 'string') throw new Error(`${key} 应为文本，请使用引号包裹日期或时间。`); task[field] = fm[key]; } }
          validateTask(task); tasks.set(entity.id, task);
        }
      } catch (e) { issues.push({ path: file.path, message: e instanceof Error ? e.message : '无法读取笔记。' }); }
    }
    for (const duplicate of duplicates) { projects.delete(duplicate); tasks.delete(duplicate); }
    for (const task of tasks.values()) if (task.projectId && !projects.has(task.projectId)) issues.push({ path: task.path, message: '所属项目不存在或标识冲突，请修复项目属性。' });
    if (version === this.loadVersion) { this.projects = projects; this.tasks = tasks; this.issues = issues; }
  }
  private allowed(path: string,roleRoot?:string) { safePath(path);if(roleRoot&&(!safePath(roleRoot).startsWith(ROLE_ROOT+'/')||roleRoot.split('/').length!==3))throw Error('岗位复盘目录无效。');if (![PROJECT_ROOT, REVIEW_ROOT,...(roleRoot?[roleRoot]:[])].some(root => path.startsWith(root + '/')) || !path.endsWith('.md')) throw new Error('项目写入路径超出允许范围。'); }
  private async execute(op: ProjectOperation) {
    if (op.status === 'done') return;
    try {
      for (const write of op.writes) {
        this.allowed(write.path,op.roleReviewRoot); const existing = this.vault.getAbstractFileByPath(write.path);
        if (existing instanceof TFile) {
          await this.vault.process(existing, current => {
            if (fingerprint(current) === fingerprint(write.content)) return current;
            if (!write.expectedHash || fingerprint(current) !== write.expectedHash) throw new Error(`${write.path}：文件已有新修改，未覆盖。`);
            return write.content;
          });
        } else {
          if (existing || write.expectedHash) throw new Error(`${write.path}：文件已删除或位置冲突，未创建替代文件。`);
          await ensureFolder(this.vault, write.path.slice(0, write.path.lastIndexOf('/'))); await this.vault.create(write.path, write.content);
        }
      }
      op.status = 'done'; op.error = undefined; op.writes = []; await this.persist();
    } catch (e) { op.error = e instanceof Error ? e.message : '项目写入失败。'; await this.persist(); throw e; }
    finally { await this.load(); }
  }
  private async commit(operationId: string, label: string, writes: ProjectOperation['writes'],roleReviewRoot?:string) {
    let op = this.state().operations.find(o => o.id === operationId);
    if (!op) { op = { id: operationId, label, writes, roleReviewRoot, paths: writes.map(w => w.path), status: 'pending' }; this.state().operations.push(op); await this.persist(); }
    await this.execute(op); return op;
  }
  async resume(operationId: string) { return this.serial(async () => { const op = this.state().operations.find(o => o.id === operationId); if (!op) throw new Error('恢复操作不存在。'); await this.execute(op); }); }
  async renameReferences(oldPath: string, newPath: string) {
    return this.serial(async () => {
      const oldLink = noteLink(oldPath), newLink = noteLink(newPath), writes: ProjectOperation['writes'] = [];
      for (const file of this.vault.getMarkdownFiles().filter(f => f.path.startsWith(PROJECT_ROOT + '/'))) {
        const raw = await this.vault.read(file), { fm, body } = parts(raw); if (!['project', 'project-task'].includes(fm.kf_kind)) continue;
        const first = body.indexOf(START), last = body.indexOf(END); if (first < 0 || last < first) continue;
        const current = body.slice(first, last + END.length), references = [fm.kf_notes, fm.kf_sources].filter(Array.isArray).flat();
        if (!current.includes(oldLink) && !current.includes(newLink) && !references.includes(oldPath)) continue;
        if (fingerprint(current) !== fm.kf_block_hash && fingerprint(current.split(newLink).join(oldLink)) !== fm.kf_block_hash) continue;
        const next = current.split(oldLink).join(newLink); for (const key of ['kf_notes', 'kf_sources']) if (Array.isArray(fm[key])) fm[key] = fm[key].map((path: string) => path === oldPath ? newPath : path);
        const content = `---\n${stringifyYaml({ ...fm, kf_block_hash: fingerprint(next) }).trimEnd()}\n---\n${body.slice(0, first) + next + body.slice(last + END.length)}`;
        if (content !== raw) writes.push({ path: file.path, content, expectedHash: fingerprint(raw) });
      }
      if (writes.length) await this.commit('rename:' + fingerprint(oldPath + ':' + newPath + ':' + this.state().operations.length + ':' + writes.map(w => w.expectedHash).join(',')), '更新项目资料链接', writes); else await this.load();
      for (const suggestion of this.state().suggestions) if (suggestion.sourcePath === oldPath) suggestion.sourcePath = newPath;
      await this.persist();
    });
  }
  async renameCategory(old: string, name: string) {
    return this.serial(async () => {
      name = name.trim(); if (!name || name.length > 40) throw new Error('类别名称应为1–40字。'); await this.load();
      if (old === name) return;
      const writes: ProjectOperation['writes'] = [];
      for (const entity of [...this.projects.values(), ...this.tasks.values()].filter(e => e.category === old)) { const raw = await this.raw(entity), { fm, body } = parts(raw); writes.push({ path: entity.path, expectedHash: entity.hash, content: `---\n${stringifyYaml({ ...fm, kf_category: name }).trimEnd()}\n---\n${body}` }); }
      this.state().categories = [...new Set(this.state().categories.map(c => c === old ? name : c).concat(name))];
        await this.commit('category:' + fingerprint(old + ':' + name + ':' + this.state().operations.length), `类别：${old} → ${name}`, writes);
    });
  }
  private async raw(entity: { path: string; hash: string }) {
    const file = this.vault.getAbstractFileByPath(entity.path); if (!(file instanceof TFile)) throw new Error('笔记已删除，请刷新。');
    const raw = await this.vault.read(file); if (fingerprint(raw) !== entity.hash) throw new Error('笔记已在其他位置修改，请刷新后重试。'); return raw;
  }
  private projectBody(project: Project, tasks: ProjectTask[]) {
    tasks=tasks.filter(t=>!t.plan?.deletedAt&&!t.plan?.occurrenceSuppressed);
    return `# ${project.title}\n\n## 项目目标\n\n${project.goal || '尚未填写目标'}\n\n## 项目任务\n\n${tasks.map(t => `- ${noteLink(t.path)} · ${PROJECT_TASK_STATUS[t.status]}`).join('\n') || '暂无任务，可在项目管理中添加。'}\n\n## 关联资料与成果\n\n${project.notes.filter(path => !path.startsWith(REVIEW_ROOT + '/')).map(path => '- ' + noteLink(path)).join('\n') || '关联研究、方法、案例和交付成果，保留原笔记位置。'}\n\n## 项目复盘\n\n${project.notes.filter(path => path.startsWith(REVIEW_ROOT + '/')).map(path => '- ' + noteLink(path)).join('\n') || '暂无已确认复盘。'}`;
  }
  private projectFM(p: Project): Frontmatter { return { kf_kind: 'project', kf_id: p.id, title: p.title, kf_goal: p.goal, kf_category: p.category, kf_status: p.status, kf_created_at: p.createdAt, kf_updated_at: p.updatedAt, kf_notes: p.notes }; }
  private taskFM(t: ProjectTask): Frontmatter { return { kf_role_id:t.roleId,kf_stage:t.roleId?'build':undefined,kf_kind: 'project-task', kf_plan: t.plan || null, kf_plan_date: t.planDate || '', kf_id: t.id, title: t.title, kf_project_id: t.projectId, kf_category: t.category, kf_status: t.status, kf_priority: t.priority, kf_planned_date: t.plannedDate || '', kf_start_time: t.startTime || '', kf_end_date: t.endDate || '', kf_end_time: t.endTime || '', kf_due_date: t.dueDate || '', kf_created_at: t.createdAt, kf_updated_at: t.updatedAt, kf_completed_at: t.completedAt || '', kf_sources: t.sources, kf_action_key: t.actionKey || '' }; }
  private async projectWrite(p: Project, tasks: ProjectTask[], creating = false) {
    const raw = creating ? undefined : await this.raw(p), fm = raw === undefined ? {} : parts(raw).fm;
    return { path: p.path, content: document({ ...fm, ...this.projectFM(p) }, this.projectBody(p, tasks), raw), expectedHash: creating ? undefined : p.hash };
  }
  async saveProject(input: Partial<Project> & Pick<Project, 'title' | 'goal' | 'category' | 'status'>): Promise<Project> {
    return this.serial(async () => {
      await this.load(); title(input.title); if (!Object.hasOwn(PROJECT_STATUS, input.status)) throw new Error('项目状态无效。');
      if (!input.category.trim() || input.category.length > 40) throw new Error('类别名称应为1–40字。');
      const projectId = input.id || crypto.randomUUID(); id(projectId); const old = this.projects.get(projectId);
      if (old && input.hash && old.hash !== input.hash) throw new Error('项目已更新，请重新打开编辑。');
      if (!old && input.path) throw new Error('项目已删除或标识冲突，未重建。');
      const now = new Date().toISOString(), project: Project = { ...old, ...input, id: projectId, path: old?.path || uniquePath(this.vault, `${PROJECT_ROOT}/${safeName(input.title)}-${projectId.slice(0, 8)}`, '项目主页.md'), hash: old?.hash || '', createdAt: old?.createdAt || now, updatedAt: now, notes: input.notes || old?.notes || [] };
      project.notes.forEach(noteLink);
      await this.commit(`project:${projectId}:${old?.hash || 'create'}:${fingerprint(JSON.stringify(input))}`, `保存项目：${project.title}`, [await this.projectWrite(project, [...this.tasks.values()].filter(t => t.projectId === projectId), !old)]);
      return this.projects.get(projectId)!;
    });
  }
  async saveTask(input: Partial<ProjectTask> & Pick<ProjectTask, 'title' | 'projectId' | 'category' | 'status' | 'priority'>): Promise<ProjectTask> {
    return this.serial(async () => {
      await this.load(); const taskId = input.id || crypto.randomUUID(), old = this.tasks.get(taskId), project = this.projects.get(input.projectId);
      if (!project && input.projectId) throw new Error('请选择有效项目。');
      if (old && input.hash && old.hash !== input.hash) throw new Error('任务已更新，请重新打开编辑。');
      if (!old && input.path) throw new Error('任务已删除或标识冲突，未重建。');
      const now = new Date().toISOString(), task: ProjectTask = { ...old, ...input, id: taskId, path: old?.path || uniquePath(this.vault, (project ? project.path.slice(0, project.path.lastIndexOf('/')) : PROJECT_ROOT + '/独立计划') + '/任务', input.title + '.md'), hash: old?.hash || '', createdAt: old?.createdAt || now, updatedAt: now, sources: input.sources || old?.sources || [], completedAt: input.status === 'done' ? input.completedAt || old?.completedAt || now : undefined };
      validateTask(task); const raw = old ? await this.raw(old) : undefined, fm = raw ? parts(raw).fm : {};
      const writes: ProjectOperation['writes'] = [{ path: task.path, expectedHash: old?.hash, content: document({ ...fm, ...this.taskFM(task) }, `# ${task.title}\n\n所属项目：${(project ? noteLink(project.path) : '未关联项目')}\n\n## 说明\n\n${task.plan?.description || ''}\n\n${task.plan?.subtasks.map(s => '- [' + (s.done ? 'x' : ' ') + '] ' + s.title).join('\n') || ''}\n\n## 行动来源\n\n${task.sources.map(path => '- ' + noteLink(path)).join('\n') || '手动创建'}`, raw) }];
      const next = [...this.tasks.values()].filter(t => t.id !== taskId).concat(task);
      for (const projectId of new Set([task.projectId, old?.projectId].filter((v): v is string => Boolean(v)))) { const p = this.projects.get(projectId); if (p) writes.push(await this.projectWrite(p, next.filter(t => t.projectId === projectId))); }
      await this.commit(`task:${taskId}:${old?.hash || 'create'}:${fingerprint(JSON.stringify(input))}`, `保存任务：${task.title}`, writes); return this.tasks.get(taskId)!;
    });
  }
  async accept(suggestion: ProjectSuggestion, projectId: string) {
    if (suggestion.status === 'accepted') return;
    const source = this.vault.getAbstractFileByPath(suggestion.sourcePath);
    if (!(source instanceof TFile) || fingerprint(await this.vault.read(source)) !== suggestion.sourceHash) throw new Error('来源笔记已变化，请重新提取行动。');
    await this.load(); let project = this.projects.get(projectId);
    if (!project) throw new Error('请选择已有项目，或先确认新建项目。');
    if (!project.notes.includes(suggestion.sourcePath)) project = await this.saveProject({ ...project, notes: [...project.notes, suggestion.sourcePath] });
    for (const action of suggestion.actions.filter(a => a.selected)) {
      const actionKey = fingerprint(`${projectId}:${suggestion.sourcePath}:${action.title.trim().replace(/\s+/g, ' ')}`);
      await this.load(); if ([...this.tasks.values()].some(t => t.actionKey === actionKey)) continue;
      await this.saveTask({ roleId:suggestion.roleContext?.roleId,id: actionKey.slice(0, 32), title: action.title, projectId, category: project.category, status: 'todo', priority: 'normal', sources: [suggestion.sourcePath], actionKey });
    }
    suggestion.status = 'accepted'; suggestion.projectId = projectId; await this.persist();
  }
  async saveReview(draft: ProjectReviewDraft) {
    return this.serial(async () => {
      if (draft.notePath) { const existing = this.vault.getAbstractFileByPath(draft.notePath); if (existing instanceof TFile) return draft.notePath; throw new Error('已保存的复盘被移除，请从原笔记恢复。'); }
      const prior = this.state().operations.find(o => o.id === 'review:' + draft.id);
      if (prior) { await this.execute(prior); draft.notePath = prior.paths[0]; await this.persist(); return draft.notePath; }
      for (const source of draft.sources) { const file = this.vault.getAbstractFileByPath(source.path); if (!(file instanceof TFile) || fingerprint(await this.vault.read(file)) !== source.hash) throw new Error('复盘依据已变化，请重新生成或核对后重试。'); }
      const existing = this.state().operations.find(o => o.id === 'review:' + draft.id), path = existing?.paths[0] || uniquePath(this.vault, draft.roleContext?stagePath(draft.roleContext,'output'):REVIEW_ROOT, draft.title + '.md');
      const fm = { kf_role_id:draft.roleContext?.roleId,kf_stage:draft.roleContext?'output':undefined,kf_kind: 'project-review', kf_id: draft.id, title: draft.title, kf_project_ids: draft.projectIds, kf_week_from: draft.from, kf_week_to: draft.to, kf_created_at: draft.createdAt };
      const writes: ProjectOperation['writes'] = [{ path, content: `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n# ${draft.title}\n\n${draft.body}\n\n## 依据\n\n${draft.sources.map(s => '- ' + noteLink(s.path)).join('\n')}\n` }];
      await this.load(); for (const projectId of draft.projectIds) { const p = this.projects.get(projectId); if (p) writes.push(await this.projectWrite({ ...p, notes: [...new Set(p.notes.concat(path))] }, [...this.tasks.values()].filter(t => t.projectId === p.id))); }
      await this.commit('review:' + draft.id, '保存项目周复盘', writes,draft.roleContext?stagePath(draft.roleContext,'output'):undefined);
      draft.notePath = path; await this.persist(); return path;
    });
  }
}
