import { ItemView, TFile, type WorkspaceLeaf } from 'obsidian';
import type KnowledgeFlow from './main';
import { PROJECT_VIEW, PROJECT_STATUS, PROJECT_TASK_STATUS, completion, taskMatches, overdue, localDay, addDays, weekStart, type Project, type ProjectTask, type ProjectReviewDraft } from './project-types';
import { projectButton, projectField, projectSelect, renderSuggestion } from './project-ui';

export class ProjectView extends ItemView {
  private pane = 'overview'; private projectId = ''; private filter = 'all'; private category = '';
  private archived = false; private editing = false; private closed = false; private error = ''; private mobile = 'content';
  private body!: HTMLElement; private status!: HTMLElement;
  constructor(leaf: WorkspaceLeaf, private plugin: KnowledgeFlow) { super(leaf); }
  getViewType() { return PROJECT_VIEW; } getDisplayText() { return '项目管理'; } getIcon() { return 'calendar-check'; }
  async onOpen() { this.closed = false; await this.reload(); }
  async onClose() { this.closed = true; }
  refresh() { if (!this.closed && !this.editing) void this.reload(); }
  private async reload() { await this.plugin.projects().load(); if (!this.closed) this.render(); }
  private button(parent: HTMLElement, text: string, action: () => Promise<void> | void, primary = false) { return projectButton(parent, text, action, this.status, primary); }
  private scopeProjects() { return [...this.plugin.projects().projects.values()].filter(p => (this.archived || p.status !== 'archived') && (!this.category || p.category === this.category)); }
  private scopeTasks() { const ids = new Set([...this.plugin.projects().projects.values()].filter(p => this.archived || p.status !== 'archived').map(p => p.id)); return [...this.plugin.projects().tasks.values()].filter(t => !t.plan?.deletedAt&&!t.plan?.occurrenceSuppressed&&ids.has(t.projectId) && (!this.projectId || t.projectId === this.projectId) && (!this.category || t.category === this.category)); }
  private change(pane: string) { this.pane = pane; this.mobile = 'content'; this.editing = false; this.render(); }
  render() {
    const root = this.contentEl; root.empty(); root.addClass('kf-project-root'); root.setAttribute('data-mobile', this.mobile);
    const top = root.createDiv({ cls: 'kf-project-top' }); top.createEl('h1', { text: '项目与计划' });
    top.createEl('p', { text: '让知识成为行动，让进展沉淀为知识。', cls: 'kf-muted' });
    this.status = top.createEl('p', { cls: 'kf-error', text: this.error, attr: { role: 'status', 'aria-live': 'polite' } });
    const mobileNav = top.createDiv({ cls: 'kf-project-mobile-nav' });
    for (const [id, text] of [['filters', '筛选'], ['content', '项目与任务'], ['insights', '本周与资料']]) this.button(mobileNav, text, () => { this.mobile = id; this.render(); });
    const layout = root.createDiv({ cls: 'kf-project-layout' }), nav = layout.createEl('nav', { cls: 'kf-project-sidebar', attr: { 'aria-label': '项目管理导航' } });
    this.button(nav, '＋ 新建项目', () => this.projectForm(), true); this.button(nav, '返回工作台', () => this.plugin.open()); this.button(nav, '知识搜索与问答', () => this.plugin.openKnowledge());
    this.button(nav, '计划与日程 · 双端同步', () => this.plugin.openDiaryPlans());
    nav.createEl('h2', { text: '管理视图' });
    for (const [id, name] of [['overview', '项目总览'], ['tasks', '任务列表'], ['week', '周日程'], ['suggestions', 'AI 建议'], ['reviews', '周复盘草稿']]) { const b = this.button(nav, name, () => id==='week'?this.plugin.openDiaryPlans('week',this.projectId):this.change(id)); b.setAttribute('aria-current', this.pane === id ? 'page' : 'false'); }
    nav.createEl('h2', { text: '项目' });
    const project = projectSelect(nav, '选择项目', [['', '全部项目'], ...this.scopeProjects().map(p => [p.id, p.title] as [string, string])], this.projectId);
    project.onchange = () => { this.projectId = project.value; this.render(); };
    const archivedRow = nav.createEl('label', { cls: 'kf-toggle' }), archived = archivedRow.createEl('input', { type: 'checkbox' }); archived.checked = this.archived; archivedRow.createEl('span', { text: '包含已归档项目' }); archived.onchange = () => { this.archived = archived.checked; this.projectId = ''; this.render(); };
    const categories = [...new Set([...this.plugin.projectState.categories, ...this.plugin.projects().projects.values()].map(c => typeof c === 'string' ? c : c.category).concat([...this.plugin.projects().tasks.values()].map(t => t.category)))];
    const category = projectSelect(nav, '类别', [['', '全部类别'], ...categories.map(c => [c, c] as [string, string])], this.category); category.onchange = () => { this.category = category.value; this.projectId = ''; this.render(); };
    this.button(nav, '管理类别', () => this.categoryForm(categories)); this.button(nav, '扫描已有项目资料', () => this.scanForm());
    this.body = layout.createEl('main', { cls: 'kf-project-main' });
    const tasks = this.scopeTasks(), stats = this.body.createDiv({ cls: 'kf-project-stats' });
    for (const [filter, name] of [['all', '全部任务'], ['overdue', '逾期'], ['today', '今日'], ['upcoming', '即将截止'], ['done', '已完成']]) {
      const b = this.button(stats, `${tasks.filter(t => taskMatches(t, filter)).length} · ${name}`, () => { this.filter = filter; this.pane = 'tasks'; this.render(); }); b.classList.add('kf-stat-' + filter); b.setAttribute('aria-current', this.filter === filter && this.pane === 'tasks' ? 'page' : 'false');
    }
    const toolbar = this.body.createDiv({ cls: 'kf-project-toolbar' });
    const selected = this.plugin.projects().projects.get(this.projectId); toolbar.createEl('h2', { text: selected?.title || ({ overview: '我的项目', tasks: '我的任务', week: '本周执行计划', suggestions: '项目行动建议', reviews: '待确认周复盘' } as Record<string, string>)[this.pane] });
    if (selected) { this.button(toolbar, '编辑项目', () => this.projectForm(selected)); this.button(toolbar, '基于本项目提问', () => this.plugin.openProjectQuestion(selected.id)); }
    this.button(toolbar, '＋ 新建任务', () => this.taskForm(), true);
    this.button(toolbar, '生成周复盘', () => this.generateReview());
    const content = this.body.createDiv({ cls: 'kf-project-content' });
    if (this.pane === 'overview') this.overview(content);
    else if (this.pane === 'suggestions') this.suggestions(content);
    else if (this.pane === 'reviews') this.reviews(content);
    else this.taskList(content, tasks);
    const aside = layout.createEl('aside', { cls: 'kf-project-insights' });
    const weekEnd = addDays(weekStart(), 6), completed = tasks.filter(t => t.completedAt && localDay(new Date(t.completedAt)) >= weekStart() && localDay(new Date(t.completedAt)) <= weekEnd && t.status === 'done');
    const summary = aside.createEl('section'); summary.createEl('h2', { text: '本周推进' }); summary.createEl('p', { text: `已完成 ${completed.length} 项 · 逾期 ${tasks.filter(t => overdue(t)).length} 项` }); summary.createEl('p', { text: `任务完成率 ${completion(tasks)}%`, cls: 'kf-muted' });
    const review = aside.createEl('section'); review.createEl('h2', { text: 'AI 周复盘' }); review.createEl('p', { text: '依据任务记录与项目资料生成，预览后保存为独立知识笔记。', cls: 'kf-muted' });
    this.button(review, '生成本周复盘', () => this.generateReview(), true);
    const notes = aside.createEl('section'); notes.createEl('h2', { text: '关联资料' });
    const linked = selected ? selected.notes : [...new Set(this.scopeProjects().flatMap(p => p.notes))];
    if (!linked.length) notes.createEl('p', { text: '关联研究回答、方法和成果，即可从项目追溯依据。', cls: 'kf-muted' });
    for (const path of linked.slice(0, 12)) { this.button(notes, path.split('/').at(-1) || path, () => this.app.workspace.openLinkText(path, '', false)); this.button(notes, '提取行动', () => this.extractPath(path)); }
    const pending = this.plugin.projectState.operations.filter(o => o.status === 'pending');
    for (const op of pending) { const box = aside.createEl('section'); box.createEl('h3', { text: op.label }); box.createEl('p', { text: op.error || '写入曾中断，可安全继续。', cls: 'kf-error' }); this.button(box, '继续未完成写入', async () => { await this.plugin.projects().resume(op.id); await this.reload(); }); }
    for (const issue of this.plugin.projects().issues) { const box = aside.createEl('section'); box.createEl('p', { text: `${issue.path}：${issue.message}`, cls: 'kf-error' }); this.button(box, '打开问题笔记', () => this.app.workspace.openLinkText(issue.path, '', false)); }
  }
  private overview(parent: HTMLElement) {
    const projects = this.scopeProjects().filter(p => !this.projectId || p.id === this.projectId);
    if (!projects.length) { this.empty(parent, '从一个目标开始', '新建项目，或扫描已有项目资料；原笔记保留原位置。'); return; }
    const grid = parent.createDiv({ cls: 'kf-project-grid' });
    for (const p of projects) {
      const card = grid.createEl('article', { cls: 'kf-project-card' }), tasks = [...this.plugin.projects().tasks.values()].filter(t => t.projectId === p.id&&!t.plan?.deletedAt&&!t.plan?.occurrenceSuppressed), ratio = completion(tasks);
      card.createEl('span', { text: `${p.category} · ${PROJECT_STATUS[p.status]}`, cls: 'kf-project-badge' });
      card.createEl('h3', { text: p.title }); card.createEl('p', { text: p.goal || '尚未填写项目目标', cls: 'kf-muted' });
      const bar = card.createEl('progress', { attr: { max: '100', value: String(ratio), 'aria-label': `${p.title}任务完成率${ratio}%` } }); bar.value = ratio;
      card.createEl('p', { text: `${tasks.filter(t => t.status === 'done').length}/${tasks.filter(t => t.status !== 'canceled').length} 项完成 · ${ratio}%` });
      const due = tasks.filter(t => t.dueDate && !['done', 'canceled'].includes(t.status)).map(t => t.dueDate!).sort()[0]; if (due) card.createEl('p', { text: '下一截止日期：' + due, cls: 'kf-muted' });
      this.button(card, '进入项目', () => { this.projectId = p.id; this.pane = 'tasks'; this.render(); }); this.button(card, '打开项目主页', () => this.app.workspace.openLinkText(p.path, '', false)); this.button(card, '编辑', () => this.projectForm(p));
    }
  }
  private taskList(parent: HTMLElement, tasks: ProjectTask[]) {
    const filters = parent.createDiv({ cls: 'kf-project-toolbar' });
    const filter = projectSelect(filters, '状态筛选', [['all', '全部'], ['today', '今日'], ['upcoming', '即将截止'], ['overdue', '逾期'], ['todo', '待办'], ['doing', '进行中'], ['done', '已完成'], ['canceled', '已取消']], this.filter);
    filter.onchange = () => { this.filter = filter.value; this.render(); };
    const visible = tasks.filter(t => taskMatches(t, this.filter)).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    if (!visible.length) this.empty(parent, '这个范围暂无任务', '可以直接添加任务，也可以从已归档笔记提取行动建议。');
    for (const task of visible) this.taskRow(parent, task);
  }
  private taskRow(parent: HTMLElement, task: ProjectTask, compact = false) {
    const row = parent.createEl('article', { cls: `kf-project-task ${overdue(task) ? 'is-overdue' : ''} ${compact ? 'is-compact' : ''}` }); row.draggable = true;
    row.ondragstart = e => { e.dataTransfer?.setData('application/x-knowledge-flow-task', task.id); };
    const check = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `完成任务：${task.title}` } }); check.checked = task.status === 'done';
    check.onchange = () => { check.disabled = true; void this.plugin.projects().saveTask({ ...task, status: check.checked ? 'done' : 'todo' }).then(() => this.reload()).catch(e => { this.status.textContent = e.message; check.checked = task.status === 'done'; check.disabled = false; }); };
    const info = row.createDiv(); info.createEl('h3', { text: task.title });
    if (compact) info.createEl('p', { text: `${task.startTime || '全天'}${task.endTime ? '–' + task.endTime : ''} · ${PROJECT_TASK_STATUS[task.status]}`, cls: 'kf-muted kf-caption' });
    else {
      info.createEl('p', { text: `${this.plugin.projects().projects.get(task.projectId)?.title || '项目缺失'} · ${PROJECT_TASK_STATUS[task.status]} · ${task.priority === 'high' ? '高优先级' : task.priority === 'low' ? '低优先级' : '普通优先级'}`, cls: 'kf-muted kf-caption' });
      info.createEl('p', { text: `执行：${task.plannedDate || '未排期'}${task.startTime ? ' ' + task.startTime : ''}${task.endTime ? ' → ' + (task.endDate && task.endDate !== task.plannedDate ? task.endDate + ' ' : '') + task.endTime : ''} · 截止：${task.dueDate || '未设置'}${overdue(task) ? ' · 已逾期' : ''}`, cls: 'kf-muted kf-caption' });
    }
    this.button(row, '编辑', () => this.taskForm(task)); if (!compact) this.button(row, '打开笔记', () => this.app.workspace.openLinkText(task.path, '', false));
  }
  private empty(parent: HTMLElement, title: string, text: string) { const empty = parent.createDiv({ cls: 'kf-project-empty' }); empty.createEl('h3', { text: title }); empty.createEl('p', { text }); }
  private editor(title: string) { this.editing = true; this.mobile = 'content'; this.contentEl.setAttribute('data-mobile', 'content'); this.body.empty(); this.body.createEl('h2', { text: title }); const form = this.body.createEl('form', { cls: 'kf-project-editor' }); form.onsubmit = e => e.preventDefault(); return form; }
  private projectForm(project?: Project) {
    const form = this.editor(project ? '编辑项目' : '新建项目'), id = project?.id || crypto.randomUUID();
    const name = projectField(form, '项目名称', project?.title || ''), goalRow = form.createEl('label', { cls: 'kf-field' }); goalRow.createEl('span', { text: '项目目标' }); const goal = goalRow.createEl('textarea'); goal.value = project?.goal || '';
    const category = projectSelect(form, '类别', [...new Set(this.plugin.projectState.categories.concat(project?.category || []))].map(c => [c, c]), project?.category || this.plugin.projectState.categories[0] || '工作');
    const status = projectSelect(form, '项目状态', Object.entries(PROJECT_STATUS), project?.status || 'planned');
    const notePaths = projectField(form, '关联资料路径（每行一篇）', ''); const notesRow = notePaths.parentElement!; notePaths.remove(); const notes = notesRow.createEl('textarea'); notes.value = project?.notes.join('\n') || '';
    this.button(form, '保存项目', async () => { const p = await this.plugin.projects().saveProject({ ...project, id, title: name.value, goal: goal.value, category: category.value, status: status.value as Project['status'], notes: notes.value.split('\n').map(v => v.trim()).filter(Boolean) }); this.projectId = p.id; this.editing = false; await this.reload(); }, true);
    this.button(form, '取消编辑', () => { this.editing = false; this.render(); });
  }
  private taskForm(task?: ProjectTask) {
    if (!this.plugin.projects().projects.size) { this.status.textContent = '请先新建项目，再添加任务。'; return; }
    const form = this.editor(task ? '编辑任务与排期' : '新建任务'), id = task?.id || crypto.randomUUID();
    const name = projectField(form, '任务标题', task?.title || ''), project = projectSelect(form, '所属项目', [...this.plugin.projects().projects.values()].map(p => [p.id, p.title]), task?.projectId || this.projectId || [...this.plugin.projects().projects.keys()][0]);
    const category = projectSelect(form, '类别', [...new Set(this.plugin.projectState.categories.concat(task?.category || this.plugin.projects().projects.get(project.value)?.category || []))].map(c => [c, c]), task?.category || this.plugin.projects().projects.get(project.value)?.category || '工作');
    const status = projectSelect(form, '任务状态', Object.entries(PROJECT_TASK_STATUS), task?.status || 'todo'), priority = projectSelect(form, '优先级', [['high', '高'], ['normal', '普通'], ['low', '低']], task?.priority || 'normal');
    const dates = form.createDiv({ cls: 'kf-project-dates' }), date = projectField(dates, '计划执行日期', task?.plannedDate || '', 'date'), start = projectField(dates, '开始时间（可空）', task?.startTime || '', 'time'), endDate = projectField(dates, '结束日期（跨日可填）', task?.endDate || '', 'date'), end = projectField(dates, '结束时间（可空）', task?.endTime || '', 'time'), due = projectField(form, '独立截止日期（当天结束前）', task?.dueDate || '', 'date');
    form.createEl('p', { text: '执行日期与截止日期分别保存。可以只填写执行日期作为全天任务，也可以暂不排期。', cls: 'kf-muted' });
    const sourceRow = form.createEl('label', { cls: 'kf-field' }); sourceRow.createEl('span', { text: '来源笔记路径（每行一篇，可空）' }); const sources = sourceRow.createEl('textarea'); sources.value = task?.sources.join('\n') || '';
    this.button(form, '保存任务', async () => { await this.plugin.projects().saveTask({ ...task, id, title: name.value, projectId: project.value, category: category.value, status: status.value as ProjectTask['status'], priority: priority.value as ProjectTask['priority'], plannedDate: date.value || undefined, startTime: start.value || undefined, endDate: endDate.value || undefined, endTime: end.value || undefined, dueDate: due.value || undefined, sources: sources.value.split('\n').map(v => v.trim()).filter(Boolean) }); this.editing = false; await this.reload(); }, true);
    this.button(form, '取消编辑', () => { this.editing = false; this.render(); });
  }
  private categoryForm(categories: string[]) {
    const form = this.editor('管理类别');
    const name = projectField(form, '新类别名称', ''); this.button(form, '新增类别', async () => { const value = name.value.trim(); if (!value || value.length > 40) throw new Error('类别名称应为1–40字。'); this.plugin.projectState.categories = [...new Set(this.plugin.projectState.categories.concat(value))]; await this.plugin.persist(); this.editing = false; this.render(); });
    const old = projectSelect(form, '要重命名的类别', categories.map(c => [c, c]), categories[0]), replacement = projectField(form, '替换为', '');
    this.button(form, '确认重命名类别', async () => { await this.plugin.projects().renameCategory(old.value, replacement.value); this.category = ''; this.editing = false; await this.reload(); }); this.button(form, '返回', () => { this.editing = false; this.render(); });
  }
  private suggestions(parent: HTMLElement) {
    const pending = this.plugin.projectState.suggestions.filter(s => !s.draftTaskId && s.status === 'pending'); if (!pending.length) this.empty(parent, '暂无待确认建议', '在笔记菜单选择“提取项目行动”，或从归档预览中生成建议。');
    for (const s of pending) renderSuggestion(parent, s, this.plugin, () => { void this.reload(); });
    const row = parent.createDiv({ cls: 'kf-project-toolbar' }); const path = projectField(row, '从已归档笔记提取行动 · 路径', ''); this.button(row, '提取项目行动', () => this.extractPath(path.value));
  }
  async extractPath(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile) || !path.endsWith('.md')) throw new Error('请选择当前笔记库中的 Markdown 笔记。');
    this.status.textContent = '正在提取行动，完成后需确认…'; const suggestion = await this.plugin.suggestProjectNote(path); if (this.closed) return;
    this.editing = false; this.pane = 'suggestions'; this.render(); this.status.textContent = suggestion.actions.length ? '建议已生成，尚未创建任务。' : '没有发现明确待办，可只关联资料。';
  }
  private scanForm() {
    const form = this.editor('扫描已有项目资料'); form.createEl('p', { text: '先选择最多20篇资料，再发送摘要给当前 AI 建议分组；确认前不会创建项目，原笔记不会移动。', cls: 'kf-muted' });
    const selected = new Set<string>(); const candidates = this.plugin.projectAI().candidates();
    if (!candidates.length) form.createEl('p', { text: '项目沉淀目录中暂无可接入的旧资料。', cls: 'kf-muted' });
    for (const file of candidates) { const row = form.createEl('label', { cls: 'kf-toggle' }), check = row.createEl('input', { type: 'checkbox' }); row.createEl('span', { text: file.path }); check.onchange = () => { if (check.checked) selected.add(file.path); else selected.delete(file.path); }; }
    const groups = form.createDiv();
    this.button(form, '分析所选资料并预览分组', async () => {
      const result = await this.plugin.projectAI().scan([...selected]); groups.empty();
      if (!result.length) groups.createEl('p', { text: '未发现明确项目分组，可手动创建。', cls: 'kf-muted' });
      for (const group of result) {
        const id = crypto.randomUUID(), section = groups.createEl('section', { cls: 'kf-project-suggestion' }), title = projectField(section, '候选项目名称', group.title), goal = projectField(section, '目标', group.goal);
        section.createEl('p', { text: group.reason, cls: 'kf-muted' }); for (const path of group.paths) section.createEl('p', { text: path, cls: 'kf-caption' });
        const existing = projectSelect(section, '接入到', [['', '新建此项目'], ...[...this.plugin.projects().projects.values()].map(p => [p.id, p.title] as [string, string])], '');
        this.button(section, '确认项目分组与资料链接', async () => { const old = this.plugin.projects().projects.get(existing.value); await this.plugin.projects().saveProject(old ? { ...old, notes: [...new Set(old.notes.concat(group.paths))] } : { id, title: title.value, goal: goal.value, category: '工作', status: 'planned', notes: group.paths }); section.replaceChildren(); section.createEl('p', { text: '已接入，原笔记保留原位置。可在关联资料中继续提取行动。' }); }, true);
      }
    }, true);
    this.button(form, '返回项目管理', () => { this.editing = false; this.render(); });
  }
  private async generateReview() {
    const ids = this.projectId ? [this.projectId] : this.scopeProjects().filter(p => p.status !== 'archived').map(p => p.id);
    this.status.textContent = '正在依据本周记录生成复盘…'; const draft = await this.plugin.projectAI().review(ids); this.plugin.projectState.reviews.push(draft); await this.plugin.persist(); this.reviewForm(draft);
  }
  private reviews(parent: HTMLElement) {
    const drafts = this.plugin.projectState.reviews.filter(d => !this.projectId || d.projectIds.includes(this.projectId));
    if (!drafts.length) this.empty(parent, '暂无周复盘草稿', '点击右侧“生成本周复盘”，先核对再写入知识库。');
    for (const draft of drafts) { const row = parent.createEl('section', { cls: 'kf-project-card' }); row.createEl('h3', { text: draft.title }); row.createEl('p', { text: `${draft.from} — ${draft.to} · ${draft.notePath ? '已保存' : '待确认'}`, cls: 'kf-muted' }); this.button(row, draft.notePath ? '打开复盘笔记' : '预览复盘', () => draft.notePath ? this.app.workspace.openLinkText(draft.notePath, '', false) : this.reviewForm(draft)); }
  }
  private reviewForm(draft: ProjectReviewDraft) {
    const form = this.editor('确认本周复盘'), title = projectField(form, '复盘标题', draft.title), label = form.createEl('label', { cls: 'kf-field' }); label.createEl('span', { text: '复盘正文 · Markdown' }); const body = label.createEl('textarea', { cls: 'kf-editor' }); body.value = draft.body;
    const save = () => { draft.title = title.value; draft.body = body.value; void this.plugin.persist(); }; title.oninput = body.oninput = save;
    for (const source of draft.sources) this.button(form, '核对：' + source.path.split('/').at(-1), () => this.app.workspace.openLinkText(source.path, '', false));
    this.button(form, '确认保存周复盘', async () => { if (!draft.title.trim() || !draft.body.trim()) throw new Error('请填写标题与正文。'); const path = await this.plugin.projects().saveReview(draft); this.editing = false; await this.reload(); await this.app.workspace.openLinkText(path, '', false); }, true);
    this.button(form, '保留草稿并返回', () => { this.editing = false; this.change('reviews'); });
  }
}
