import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type KnowledgeFlow from './main';
import { PROVIDERS, VIEW_TYPE } from './config';
import { normalizeTags } from './core';
import type { Settings, Task, SyncSource } from './types';
import { renderSuggestion } from './project-ui';

const STATUS: Record<Task['status'], string> = { queued: '等待提炼', parsing: '准备材料', analyzing: '正在提炼', review: '待确认', archiving: '正在归档', done: '已归档', failed: '失败', retained: '无需入库', superseded: '已有更新' };
export class Workbench extends ItemView {
  tab = 'import'; private selected?: string;
  private error = ''; private busy = false; private draft?: Settings;
  private syncDraft?: SyncSource[];
  private syncUpdates: Array<() => void> = [];
  constructor(leaf: WorkspaceLeaf, private plugin: KnowledgeFlow) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '知流工作台'; }
  getIcon() { return 'waypoints'; }
  async onOpen() { if (!this.plugin.state.settings.initialized) this.tab = 'settings'; this.render(); }
  async onClose() {}
  previewTask(task: Task) { this.selected = task.id; this.tab = 'review'; this.render(); }
  refresh() {
    if (this.tab === 'sync') this.syncUpdates.forEach(update => update());
    else if (this.tab === 'review' && this.plugin.state.tasks.some(t => t.id === this.selected && t.status === 'review')) return;
    else if (this.tab !== 'settings') this.render();
  }
  private button(parent: HTMLElement, text: string, run: () => void | Promise<void>, primary = false): HTMLButtonElement {
    const button = parent.createEl('button', { text, cls: primary ? 'mod-cta' : '' });
    button.addEventListener('click', () => { void Promise.resolve().then(run).catch(error => { new Notice(error instanceof Error ? error.message : '操作失败，请重试。'); }); });
    return button;
  }
  private field(parent: HTMLElement, label: string, value: string, update: (value: string) => void, multiline = false, type = 'text'): HTMLInputElement | HTMLTextAreaElement {
    const row = parent.createEl('label', { cls: 'kf-field' }); row.createEl('span', { text: label });
    const input = multiline ? row.createEl('textarea') : row.createEl('input', { type });
    input.value = value; input.addEventListener('input', () => update(input.value)); return input;
  }
  render() {
    this.syncUpdates = [];
    const root = this.contentEl; root.empty(); root.addClass('kf-root');
    const header = root.createDiv({ cls: 'kf-header' });
    header.createEl('h1', { text: '知流工作台' });
    header.createEl('p', { text: '把文档变成可复用的知识。', cls: 'kf-subtitle' });
    if(this.plugin.currentRole?.())header.createEl('p',{text:'当前岗位：'+this.plugin.currentRole()!.name+' · 新材料按本岗工作流整理',cls:'kf-muted'});
    const entry = header.createDiv({ cls: 'kf-workbench-entry' });
    this.button(entry, '项目管理', () => this.plugin.openProjects(), true);
    const plansEntry=this.button(header, '计划与日程 · 双端同步', () => this.plugin.openDiaryPlans());plansEntry.classList.add('kf-plan-main-entry');
    this.button(entry, '搜索与问答', () => this.plugin.openKnowledge());
    this.button(entry, '公司工作台', () => this.plugin.openCompany());
    const nav = root.createEl('nav', { cls: 'kf-nav', attr: { 'aria-label': '工作台导航' } });
    const pending = this.plugin.state.tasks.filter(t => t.status === 'review').length;
    for (const [id, label] of [['import', '导入'], ['review', '待确认'], ['history', '记录'], ['sync', '同步'], ['settings', '配置']]) {
      const button = this.button(nav, label, () => { this.tab = id; this.selected = undefined; this.error = ''; this.render(); });
      button.setAttribute('aria-current', this.tab === id ? 'page' : 'false');
      if (id === 'review' && pending) { button.setAttribute('aria-label', `待确认，${pending}份文档`); button.createEl('span', { text: String(pending), cls: 'kf-pending-count' }); }
    }
    const body = root.createDiv({ cls: 'kf-body' });
    if (this.tab === 'settings') this.renderSettings(body);
    else if (this.tab === 'sync') this.renderSync(body);
    else if (this.tab === 'review') this.renderReview(body);
    else { if (this.tab === 'import') this.renderImport(body); this.renderTasks(body); }
  }
  private renderImport(parent: HTMLElement) {
    parent.createEl('h2', { text: '导入一份新材料' });
    parent.createEl('p', { text: '先提取全文，再由 AI 整理。你确认后，笔记才会归入目标库。', cls: 'kf-muted' });
    if (!this.plugin.state.settings.initialized) {
      this.button(parent, '配置 AI 并初始化', () => { this.tab = 'settings'; this.render(); }, true); return;
    }
    const zone = parent.createDiv({ cls: 'kf-drop' });
    zone.createEl('h3', { text: '把文件拖到这里' });
    zone.createEl('p', { text: 'Markdown · TXT · 文本 PDF · DOCX，每份不超过 50 MB' });
    const picker = zone.createEl('input', { type: 'file', attr: { accept: '.md,.txt,.pdf,.docx', multiple: '', 'aria-label': '选择待分析文档' } });
    picker.hidden = true;
    const choose = this.button(zone, '选择文件', () => picker.click(), true);
    choose.disabled = this.busy;
    const importFiles = async (files: File[]) => { this.busy = true; choose.disabled = true; try { await this.plugin.importFiles(files); } finally { this.busy = false; this.render(); } };
    picker.addEventListener('change', () => { void importFiles(Array.from(picker.files || [])); });
    zone.addEventListener('dragover', event => { event.preventDefault(); zone.addClass('is-over'); });
    zone.addEventListener('dragleave', () => zone.removeClass('is-over'));
    zone.addEventListener('drop', event => { event.preventDefault(); zone.removeClass('is-over'); if (!this.busy) void importFiles(Array.from(event.dataTransfer?.files || [])); });
    parent.createEl('p', { text: '提取的文档内容会发送至你配置的 AI 服务。扫描件暂不支持，原文件始终保留。', cls: 'kf-muted kf-caption' });
  }
  private renderTasks(parent: HTMLElement) {
    parent.createEl('h2', { text: this.tab === 'history' ? '处理记录' : '最近导入' });
    const tasks = [...this.plugin.state.tasks].reverse().filter(t => !t.conversationKey || (t.status !== 'superseded' && !this.plugin.sync.conversations.find(c => c.key === t.conversationKey)?.excluded));
    const retryable = tasks.filter(t => t.status === 'failed' && t.conversationKey && !t.notePath && !this.plugin.sync.conversations.find(c => c.key === t.conversationKey)?.excluded);
    if (retryable.length) this.button(parent, '重试失败的对话分析', async () => { for (const task of retryable) await this.plugin.retry(task); });
    if (!tasks.length) { parent.createEl('p', { text: '还没有导入记录。先选择一份文档，完成后可在「待确认」中检查标签与归档位置。', cls: 'kf-empty' }); return; }
    const list = parent.createDiv({ cls: 'kf-tasks' });
    for (const task of tasks) {
      const row = list.createDiv({ cls: 'kf-task' });
      const info = row.createDiv(); info.createEl('strong', { text: task.name });
      info.createEl('p', { text: this.sourceLabel(task), cls: 'kf-muted kf-caption kf-source' });
      info.createEl('p', { text: task.error || task.progress || STATUS[task.status], cls: task.error ? 'kf-error' : 'kf-muted', attr: { 'aria-live': 'polite' } });
      const actions = row.createDiv({ cls: 'kf-actions' }); actions.createEl('span', { text: STATUS[task.status], cls: 'kf-status' });
      if (task.status === 'review') this.button(actions, '预览', () => { this.selected = task.id; this.tab = 'review'; this.render(); });
      if (task.status === 'failed') this.button(actions, task.notePath ? '继续归档' : '重试', () => this.plugin.retry(task));
      if (task.status === 'done' && task.notePath) this.button(actions, '打开笔记', () => this.app.workspace.openLinkText(task.notePath!, '', false));
      if (task.status === 'done' && task.notePath) this.button(actions, '提取项目行动', () => this.plugin.openProjects(task.notePath));
    }
  }
  private sourceLabel(task: Task): string {
    if (task.research) return `来源：研究问答 · ${task.research.mode === 'mixed' ? '本地＋网络' : '本地与通用框架'}`;
    if (!task.conversationKey) return `来源：文档导入 · ${task.name}`;
    const conversation = this.plugin.sync.conversations.find(c => c.key === task.conversationKey);
    const source = this.plugin.sync.sources.find(s => s.id === conversation?.sourceId);
    return `来源：${conversation?.appName || (source?.kind === 'codex' ? '来源未识别' : source?.name || '未知（来源记录缺失）')} · 对话提炼`;
  }
  private renderSource(parent: HTMLElement, task: Task) {
    parent.createEl('p', { text: this.sourceLabel(task), cls: 'kf-muted kf-caption kf-source' });
    const conversation = this.plugin.sync.conversations.find(c => c.key === task.conversationKey);
    if (task.research) parent.createEl('p', { text: `研究时间：${task.research.createdAt}`, cls: 'kf-muted kf-caption' });
    if (conversation) {
      parent.createEl('p', { text: `会话：${conversation.sessionId}`, cls: 'kf-muted kf-caption' });
      const dates = [conversation.firstMessageAt, conversation.lastMessageAt].filter(Boolean);
      if (dates.length) parent.createEl('p', { text: `时间范围：${dates.join(' — ')}`, cls: 'kf-muted kf-caption' });
    }
  }
  private renderReview(parent: HTMLElement) {
    const tasks = this.plugin.state.tasks.filter(t => t.status === 'review');
    parent.createEl('h2', { text: '确认后，知识才会归档' });
    if (!tasks.length) { parent.createEl('p', { text: '暂无待确认文档。AI 分析完成后，摘要、标签和归档建议会出现在这里。', cls: 'kf-empty' }); return; }
    const select = parent.createEl('select', { attr: { 'aria-label': '选择待确认文档' } });
    for (const task of tasks) select.createEl('option', { text: task.name, value: task.id });
    const task = tasks.find(t => t.id === this.selected) || tasks[0]; this.selected = task.id; select.value = task.id;
    select.addEventListener('change', () => { this.selected = select.value; this.render(); });
    if (!task.analysis) return;
    this.renderSource(parent, task);
    const a = task.analysis;
    if (task.conversationKey) parent.createEl('p', { text: '仅保存主要信息、过程和公开思路。新消息生成更新建议，确认后才更新知识笔记；不保留逐字对话或原文附件。', cls: 'kf-muted' });
    const save = () => { void this.plugin.persist().catch(() => new Notice('修改未能保存，请检查磁盘空间。')); };
    this.field(parent, '笔记标题', a.title, value => { a.title = value; save(); });
    if (!task.conversationKey && !task.research) this.field(parent, '摘要', a.summary, value => { a.summary = value; save(); }, true);
    this.field(parent, '标签（用逗号分隔）', a.tags.join(', '), value => { a.tags = normalizeTags(value.split(/[,，]/)); save(); });
    const row = parent.createEl('label', { cls: 'kf-field' }); row.createEl('span', { text: '归档到' });
    const destination = row.createEl('select');
    for (const d of (typeof this.plugin.taskSettings==='function'?this.plugin.taskSettings(task):this.plugin.state.settings).destinations.filter(d => d.enabled)) destination.createEl('option', { value: d.id, text: `${d.name} · ${d.path}` });
    destination.value = a.destinationId;
    destination.addEventListener('change', () => { a.destinationId = destination.value; save(); });
    parent.createEl('p', { text: '分类理由：' + a.reason, cls: 'kf-muted' });
    if (!task.conversationKey && !task.research) this.field(parent, '关键要点（每行一条）', a.keyPoints.join('\n'), value => { a.keyPoints = value.split('\n').filter(Boolean); save(); }, true);
    this.field(parent, '整理正文 · Markdown', a.body, value => { a.body = value; save(); }, true).addClass('kf-editor');
    if (typeof this.plugin.projects === 'function') {
      const projects = parent.createEl('section', { cls: 'kf-project-suggestion' }); projects.createEl('h3', { text: '把知识连接到项目' });
      projects.createEl('p', { text: 'AI 只提供项目与行动建议，勾选后随归档确认；也可以跳过。正文修改后应重新提取。', cls: 'kf-muted' });
      this.button(projects, 'AI 推荐项目与待办', async () => { await this.plugin.suggestProjectTask(task); this.render(); });
      for (const suggestion of this.plugin.projectState.suggestions.filter(s => task.projectProposalIds?.includes(s.id))) renderSuggestion(projects, suggestion, this.plugin, () => this.render(), true);
    }
    const footer = parent.createDiv({ cls: 'kf-footer' });
    footer.createEl('p', { text: task.research ? '确认后保存研究笔记、本地章节链接与网络来源，不保存网页全文或完整聊天。' : task.conversationKey ? '确认后仅归档这份提炼笔记，保留软件来源、会话与时间范围。' : '原文件保存到资产库，并在整理笔记中提供来源链接。', cls: 'kf-muted' });
    this.button(footer, '确认归档', async () => {
      if (!a.title.trim() || !a.summary.trim() || !a.body.trim()) throw new Error('标题、摘要和正文不能为空。');
      await this.plugin.archive(task); if (task.status === 'done') { this.tab = 'history'; this.render(); }
    }, true);
  }
  private renderSync(parent: HTMLElement) {
    parent.createEl('h2', { text: '让对话进入知识库' });
    parent.createEl('p', { text: 'Obsidian 打开时每 30 秒自动检查。Codex、Work 本轮完成后自动提炼并进入待确认；没有完成标记的来源静默两分钟后提炼。仅保存主要信息、过程与公开思路，确认后归档。TRAE 需先导出至监控目录。', cls: 'kf-muted' });
    if (!this.plugin.state.settings.initialized) parent.createEl('p', { text: '可先收集对话。请在「配置」中测试 AI 连接，完成后才会自动筛选。', cls: 'kf-muted' });
    const drafts = this.syncDraft ||= this.plugin.sync.sources.map(s => ({ ...s, cursors: {} }));
    const act = async (work: () => Promise<void>) => {
      if (this.busy) return;
      this.busy = true; this.error = ''; this.render();
      try { await work(); } catch (error) { this.error = error instanceof Error ? error.message : '操作未完成，请重试。'; }
      finally { this.busy = false; this.render(); }
    };
    const form = parent.createEl('fieldset'); form.disabled = this.busy;
    for (const source of drafts) {
      const current = this.plugin.sync.sources.find(s => s.id === source.id)!;
      const section = form.createEl('section', { cls: 'kf-sync-source' });
      section.createEl('h3', { text: source.name });
      section.createEl('p', { text: source.kind === 'trae' ? '需导出：首版监控聊天导出目录，不读取界面状态数据库。' : '读取本地会话日志；不收集系统指令、内部推理和工具调用。', cls: 'kf-muted kf-caption' });
      this.field(section, '软件路径（可选，用于检测）', source.executablePath, value => { source.executablePath = value; });
      this.field(section, source.kind === 'trae' ? '导出目录（绝对路径）' : '记录目录（可自动检测）', source.directory, value => { source.directory = value; });
      const enabledLabel = section.createEl('label', { cls: 'kf-toggle' });
      const checkbox = enabledLabel.createEl('input', { type: 'checkbox' }); checkbox.checked = source.enabled;
      enabledLabel.createEl('span', { text: '启用此来源' }); checkbox.addEventListener('change', () => { source.enabled = checkbox.checked; });
      const actions = section.createDiv({ cls: 'kf-sync-actions' });
      this.button(actions, '检测来源', () => act(async () => {
        const found = await this.plugin.detectSyncSource(source); source.directory = found.directory; source.detected = found.message;
      }));
      this.button(actions, '保存来源', () => act(async () => {
        await this.plugin.saveSyncSource(source); source.directory = this.plugin.sync.sources.find(s => s.id === source.id)!.directory;
      }), true);
      this.button(actions, '立即同步', () => act(async () => {
        source.enabled = true;
        try { await this.plugin.saveSyncSource(source); source.directory = current.directory; }
        catch (error) { source.enabled = current.enabled; throw error; }
        await this.plugin.syncNow(source.id);
      }));
      this.button(actions, '暂停', () => act(async () => { await this.plugin.pauseSyncSource(source.id); source.enabled = false; }));
      const detection = section.createEl('p', { attr: { 'aria-live': 'polite' } });
      const status = section.createEl('p', { cls: 'kf-muted kf-caption', attr: { 'aria-live': 'polite' } });
      const updateStatus = () => {
        detection.textContent = current.error || source.detected || current.detected || '尚未检测';
        detection.className = current.error ? 'kf-error' : 'kf-muted';
        status.textContent = `${current.enabled ? '同步已启用' : '同步未启用'}${current.lastScanAt ? ' · 上次检查 ' + new Date(current.lastScanAt).toLocaleString() : ''}`;
        if (current.enabled && !this.plugin.sync.conversations.some(c => c.sourceId === current.id)) status.textContent += ' · 等待新消息；已有对话请使用下方历史导入';
      };
      updateStatus(); this.syncUpdates.push(updateStatus);
      const history = section.createEl('details'); history.createEl('summary', { text: '导入已有历史' });
      history.createEl('p', { text: '选择日期范围后提炼历史对话，不保存完整正文。JSON 消息按消息时间，MD/TXT 按文件修改时间。', cls: 'kf-muted kf-caption' });
      const dates = { from: '', to: '' };
      this.field(history, '开始日期', '', value => { dates.from = value; }, false, 'date');
      this.field(history, '结束日期', '', value => { dates.to = value; }, false, 'date');
      this.button(history, '导入所选历史', () => {
        const { from, to } = dates;
        return act(async () => {
          if (source.directory !== current.directory || source.executablePath !== current.executablePath) throw new Error('请先保存来源配置。');
          await this.plugin.importSyncHistory(source.id, from, to);
        });
      });
    }
    if (this.error) parent.createEl('p', { text: this.error, cls: 'kf-error', attr: { role: 'alert' } });
    parent.createEl('p', { text: this.busy ? '正在处理来源，请稍候…' : '明显凭据会先遮蔽。暂停来源不影响其他来源，AI 分析失败可在「记录」中重试。', cls: 'kf-muted', attr: { 'aria-live': 'polite' } });
    const collected = parent.createDiv();
    const updateCollected = () => {
      collected.empty();
      const conversations = this.plugin.sync.conversations.filter(c => !c.excluded && (c.pendingCount || c.knowledge));
      collected.createEl('h3', { text: `提炼会话 · ${conversations.length}` });
      for (const c of [...conversations].reverse().slice(0, 30)) {
        const row = collected.createDiv({ cls: 'kf-task' }); row.createEl('strong', { text: c.title });
        const task = [...this.plugin.state.tasks].reverse().find(t => t.conversationKey === c.key && t.status !== 'superseded');
        const source = this.plugin.sync.sources.find(s => s.id === c.sourceId);
        row.createEl('p', { text: `来源：${c.appName || (source?.kind === 'codex' ? '来源未识别' : source?.name || '未知（来源记录缺失）')}`, cls: 'kf-muted kf-caption kf-source' });
        row.createEl('p', { text: task ? STATUS[task.status] : c.pendingCount ? '等待提炼' : '等待新消息', cls: 'kf-muted' });
        if (task?.status === 'review') this.button(row, '查看提炼', () => { this.selected = task.id; this.tab = 'review'; this.render(); });
        row.createEl('p',{text:'岗位：'+(c.roleContext?.name||'个人通用'),cls:'kf-muted kf-caption'});
        const context=this.plugin.currentRole?.();if(context&&context.roleId!==c.roleContext?.roleId&&c.knowledge?.hasKnowledge){const preview=row.createEl('details');preview.createEl('summary',{text:'预览重新关联岗位'});preview.createEl('p',{text:'从 '+(c.roleContext?.name||'个人通用')+' 改为 '+context.name+'。保留会话标识和原笔记，生成待确认分类；确认归档后才更新笔记。'});this.button(preview,'确认生成岗位更新建议',()=>this.plugin.reassignConversation(c.key));}
        if (c.notePath) this.button(row, '打开知识笔记', () => this.app.workspace.openLinkText(c.notePath!, '', false));
      }
    };
    updateCollected(); this.syncUpdates.push(updateCollected);
    for (const warning of this.plugin.sync.migrationWarnings || []) parent.createEl('p', { text: warning, cls: 'kf-muted kf-caption' });
  }
  private renderSettings(parent: HTMLElement) {
    const settings = this.draft ||= JSON.parse(JSON.stringify(this.plugin.state.settings)) as Settings;
    parent.createEl('h2', { text: this.plugin.state.settings.initialized ? 'AI 与工作流配置' : '选择服务，填入 Key，即可开始' });
    parent.createEl('p', { text: '连接测试成功后，自动补充工作流目录与 Home 首页。已有笔记不会被覆盖。', cls: 'kf-muted' });
    const form = parent.createEl('fieldset'); form.disabled = this.busy;
    const row = form.createEl('label', { cls: 'kf-field' }); row.createEl('span', { text: 'AI 服务' });
    const provider = row.createEl('select');
    for (const [id, data] of Object.entries(PROVIDERS)) provider.createEl('option', { value: id, text: data.name });
    provider.value = settings.provider;
    provider.addEventListener('change', () => {
      settings.provider = provider.value; settings.baseUrl = PROVIDERS[provider.value].baseUrl; settings.model = PROVIDERS[provider.value].model;
      settings.apiKey = ''; this.render();
    });
    this.field(form, 'API Key', settings.apiKey, value => { settings.apiKey = value; }, false, 'password').setAttribute('autocomplete', 'off');
    form.createEl('p', { text: 'Key 保存在此笔记库的插件配置中，不会写入笔记或日志。若同步插件设置，请注意它也可能被同步。文档内容会发送至所选服务。', cls: 'kf-muted kf-caption' });
    if (settings.provider === 'qwen') form.createEl('p', { text: '默认使用北京地域 Key；其他地域请在高级设置更改地址。', cls: 'kf-muted' });
    const searchSettings = form.createEl('details'); searchSettings.open = settings.searchProvider === 'agnes' || settings.searchProvider === 'langsearch'; searchSettings.createEl('summary', { text: '联网研究 · 服务与 Key' });
    const searchRow = searchSettings.createEl('label', { cls: 'kf-field' }); searchRow.createEl('span', { text: '联网服务（独立于回答服务）' });
    const searchProvider = searchRow.createEl('select');
    searchProvider.createEl('option', { value: 'tavily', text: 'Tavily · 网页搜索与正文提取' });
    searchProvider.createEl('option', { value: 'langsearch', text: 'LangSearch · 网页搜索（免费方案）' });
    searchProvider.createEl('option', { value: 'agnes', text: 'Agnes · 原生联网（兼容性检测）' });
    searchProvider.value = settings.searchProvider || 'tavily';
    searchProvider.onchange = () => { settings.searchProvider = searchProvider.value as Settings['searchProvider']; this.render(); };
    if (settings.searchProvider === 'agnes') {
      if (settings.provider === 'agnes') {
        const reuse = searchSettings.createEl('label', { cls: 'kf-toggle' }), toggle = reuse.createEl('input', { type: 'checkbox' }); toggle.checked = settings.agnesSearchUseAIKey !== false;
        reuse.createEl('span', { text: '使用上方已保存的 Agnes AI Key' });
        toggle.onchange = () => { settings.agnesSearchUseAIKey = toggle.checked; this.render(); };
      }
      if (settings.provider !== 'agnes' || settings.agnesSearchUseAIKey === false) this.field(searchSettings, 'Agnes 联网 API Key', settings.agnesSearchKey || '', value => { settings.agnesSearchKey = value; }, false, 'password').setAttribute('autocomplete', 'off');
      this.field(searchSettings, 'Agnes 联网模型', settings.agnesSearchModel || 'agnes-2.5-flash', value => { settings.agnesSearchModel = value; });
      searchSettings.createEl('p', { text: '此入口检测 Agnes Responses 的原生网页搜索能力。普通对话成功不代表可以联网：必须返回搜索完成记录及网页引用。目前本机测试未取得这些记录；官方尚未明确承诺该能力，请以测试结果为准。', cls: 'kf-muted kf-caption' });
    } else if (settings.searchProvider === 'langsearch') {
      this.field(searchSettings, 'LangSearch 搜索 API Key', settings.langSearchApiKey || '', value => { settings.langSearchApiKey = value; }, false, 'password').setAttribute('autocomplete', 'off');
      searchSettings.createEl('a', { text: '申请 LangSearch Key', attr: { href: 'https://langsearch.com/', target: '_blank', rel: 'noopener noreferrer' } });
      searchSettings.createEl('p', { text: 'LangSearch 搜索并提供网页文字，当前 AI 负责综合分析。免费方案有每日用量与速率限制，以官网和账户显示为准；超限会提示，不自动转用其他付费搜索服务。', cls: 'kf-muted kf-caption' });
    } else this.field(searchSettings, 'Tavily 搜索 API Key', settings.searchApiKey || '', value => { settings.searchApiKey = value; }, false, 'password').setAttribute('autocomplete', 'off');
    searchSettings.createEl('p', { text: '各服务的 Key 分别保存，切换时保留原配置。联网服务只接收公开检索词，相关资料交给当前 AI 综合。Key 仅保存在插件本地配置，按服务规则计费。', cls: 'kf-muted kf-caption' });
    const searchStatus = searchSettings.createEl('p', { cls: 'kf-muted kf-caption', attr: { role: 'status', 'aria-live': 'polite' } });
    const saveSearch = async (test: boolean) => {
      saveSearchButton.disabled = testSearchButton.disabled = true;
      searchStatus.classList.remove('kf-error'); searchStatus.textContent = test ? '正在检测真实网页搜索能力…' : '正在保存…';
      try { await this.plugin.saveSearchSettings(settings, test); searchStatus.textContent = test ? '已取得真实网页来源，联网配置已保存。' : '联网配置已保存，尚未验证联网能力。'; }
      catch (error) { searchStatus.classList.add('kf-error'); searchStatus.textContent = (error instanceof Error ? error.message : '联网测试失败。') + ' 本次未更改已保存的联网配置。'; }
      finally { saveSearchButton.disabled = testSearchButton.disabled = false; }
    };
    const saveSearchButton = this.button(searchSettings, '保存联网配置', () => saveSearch(false));
    const testSearchButton = this.button(searchSettings, '测试联网并保存', () => saveSearch(true));
    const advanced = form.createEl('details'); advanced.open = settings.provider === 'custom'; advanced.createEl('summary', { text: '高级设置' });
    this.field(advanced, 'Base URL', settings.baseUrl, value => { settings.baseUrl = value; });
    this.field(advanced, '模型名', settings.model, value => { settings.model = value; });
    this.field(advanced, '分块大小（字符）', String(settings.chunkSize), value => { settings.chunkSize = Number(value); }, false, 'number');
    const libraries = form.createEl('details'); libraries.createEl('summary', { text: '目标库与分类说明' });
    libraries.createEl('p', { text: 'AI 根据用途推荐位置。可添加目标库，路径必须位于当前笔记库内。', cls: 'kf-muted' });
    for (const d of settings.destinations) {
      const block = libraries.createDiv({ cls: 'kf-destination' });
      const toggle = block.createEl('label', { cls: 'kf-toggle' }); const enabled = toggle.createEl('input', { type: 'checkbox' }); enabled.checked = d.enabled;
      toggle.createEl('span', { text: '启用此目标库' }); enabled.addEventListener('change', () => { d.enabled = enabled.checked; });
      this.field(block, '名称', d.name, value => { d.name = value; });
      this.field(block, '目录', d.path, value => { d.path = value; });
      this.field(block, '用途说明', d.description, value => { d.description = value; }, true);
    }
    this.button(libraries, '新增目标库', () => { settings.destinations.push({ id: crypto.randomUUID(), name: '新目标库', path: '06_WIKI-知识库/新目标库', description: '', enabled: true }); this.render(); });
    if (this.error) parent.createEl('p', { text: this.error, cls: 'kf-error', attr: { role: 'alert' } });
    const action = this.button(parent, this.busy ? '正在测试连接…' : this.plugin.state.settings.initialized ? '测试连接并保存' : '测试连接并开始使用', async () => {
      if (this.busy) return;
      this.busy = true; this.error = ''; this.render();
      try { await this.plugin.configure(JSON.parse(JSON.stringify(settings))); this.draft = undefined; this.tab = 'import'; new Notice('配置成功，工作流已就绪。'); }
      catch (error) { this.error = error instanceof Error ? error.message : '配置失败，请重试。'; }
      finally { this.busy = false; this.render(); }
    }, true);
    action.disabled = this.busy;
    if (!this.plugin.state.settings.initialized) this.button(parent, '稍后配置', () => { this.tab = 'import'; this.render(); });
  }
}
