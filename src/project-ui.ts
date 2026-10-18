import type KnowledgeFlow from './main';
import type { ProjectSuggestion } from './project-types';
export function projectButton(parent: HTMLElement, text: string, action: () => Promise<void> | void, error: HTMLElement, primary = false) {
  const button = parent.createEl('button', { text, cls: primary ? 'mod-cta' : '' });
  button.onclick = () => { button.disabled = true; error.textContent = ''; void Promise.resolve().then(action).catch(e => { error.textContent = e instanceof Error ? e.message : '操作失败，请重试。'; }).finally(() => { button.disabled = false; }); };
  return button;
}
export function projectField(parent: HTMLElement, label: string, value: string, type = 'text') {
  const row = parent.createEl('label', { cls: 'kf-field' }); row.createEl('span', { text: label });
  const input = row.createEl('input', { type }); input.value = value; return input;
}
export function projectSelect(parent: HTMLElement, label: string, values: Array<[string, string]>, value: string) {
  const row = parent.createEl('label', { cls: 'kf-field' }); row.createEl('span', { text: label }); const select = row.createEl('select');
  for (const [id, text] of values) select.createEl('option', { value: id, text }); select.value = value; return select;
}
export function renderSuggestion(parent: HTMLElement, suggestion: ProjectSuggestion, plugin: KnowledgeFlow, refresh: () => void, draft = false) {
  const section = parent.createEl('section', { cls: 'kf-project-suggestion' }); section.createEl('h3', { text: suggestion.status === 'accepted' ? '已接入项目' : '项目关联与行动建议' });
  section.createEl('p', { text: suggestion.reason, cls: 'kf-muted' });
  if (suggestion.status === 'stale') { section.createEl('p', { text: '建议已过期，请根据最新正文重新提取。', cls: 'kf-muted' }); return; }
  if (suggestion.status === 'accepted') { section.createEl('p', { text: '已处理，重复确认不会再次创建任务。', cls: 'kf-muted' }); return; }
  if (suggestion.sourcePath) section.createEl('p', { text: '来源：' + suggestion.sourcePath, cls: 'kf-muted kf-caption' });
  const save = () => { void plugin.persist().catch(() => {}); };
  const project = projectSelect(section, '所属项目', [['', '暂不关联'], ...[...plugin.projects().projects.values()].filter(p => p.status !== 'archived').map(p => [p.id, p.title] as [string, string])], suggestion.projectId || '');
  project.onchange = () => { suggestion.projectId = project.value || undefined; save(); };
  const linkRow = section.createEl('label', { cls: 'kf-toggle' }), linkToggle = linkRow.createEl('input', { type: 'checkbox' }); linkToggle.checked = Boolean(suggestion.selected);
  linkRow.createEl('span', { text: draft ? '确认归档时关联所选项目并创建勾选待办' : '确认关联所选项目' }); linkToggle.onchange = () => { suggestion.selected = linkToggle.checked; save(); };
  for (const action of suggestion.actions) {
    const row = section.createEl('label', { cls: 'kf-toggle' }), check = row.createEl('input', { type: 'checkbox' }); check.checked = action.selected;
    row.createEl('span', { text: action.title }); check.onchange = () => { action.selected = check.checked; save(); };
    section.createEl('p', { text: `${action.reason} · 依据：“${action.evidence}”`, cls: 'kf-muted kf-caption' });
  }
  if (!suggestion.actions.length) section.createEl('p', { text: '没有明确待办，可只关联资料。', cls: 'kf-muted' });
  const error = section.createEl('p', { cls: 'kf-error', attr: { role: 'status' } });
  if (suggestion.projectTitle) {
    const details = section.createEl('details'); details.createEl('summary', { text: '新建候选项目：' + suggestion.projectTitle });
    const name = projectField(details, '项目名称', suggestion.projectTitle), goal = projectField(details, '目标（可编辑）', suggestion.reason);
    projectButton(details, '确认新建项目', async () => { const created = await plugin.projects().saveProject({ id: 'p-' + suggestion.id, title: name.value, goal: goal.value, category: '工作', status: 'planned' }); suggestion.projectId = created.id; await plugin.persist(); refresh(); }, error);
  }
  if (!draft) projectButton(section, '确认关联与勾选待办', async () => { if (!project.value || !linkToggle.checked) throw new Error('请选择项目并勾选确认关联。'); await plugin.projects().accept(suggestion, project.value); refresh(); }, error, true);
}
