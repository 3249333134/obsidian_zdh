import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from 'obsidian';
import type KnowledgeFlow from './main';
import { KNOWLEDGE_VIEW, type Answer, type KnowledgeNote, type Relation, type SearchHit } from './knowledge';
import { greeting } from './research';
import { requireSearch } from './web-research';

export class SearchView extends ItemView {
  private hits: SearchHit[] = []; private edges: Relation[] = []; private count = 50; private query = '';
  private searchVersion = 0; private answerVersion = 0; private selected?: string;
  private history: Array<{ question: string; answer: string }> = []; private turns: Array<{ question: string; result: Answer }> = [];
  private results!: HTMLElement; private graph!: HTMLElement; private detail!: HTMLElement; private answerPanel!: HTMLElement;
  private status!: HTMLElement; private relationStatus!: HTMLElement; private question!: HTMLTextAreaElement; private asking = false;
  private askStatus!: HTMLElement; private askButton!: HTMLButtonElement; private stopButton!: HTMLButtonElement;
  private online = true; private researchInfo!: HTMLElement;
  private projectContext?: { title: string; paths: string[] }; private projectBanner?: HTMLElement;
  setProjectContext(title: string, paths: string[]) { this.projectContext = { title, paths }; this.drawProjectContext(); this.contentEl.setAttribute('data-pane', '问答'); }
  private drawProjectContext() { if (!this.projectBanner) return; this.projectBanner.empty(); if (this.projectContext) { this.projectBanner.createEl('p', { text: '项目资料优先：' + this.projectContext.title, cls: 'kf-project-badge' }); this.button(this.projectBanner, '取消项目范围', () => { this.projectContext = undefined; this.drawProjectContext(); }); } }
  private types = new Set<Relation['type']>(['link', 'ai']);
  constructor(leaf: WorkspaceLeaf, private plugin: KnowledgeFlow) { super(leaf); }
  getViewType() { return KNOWLEDGE_VIEW; } getDisplayText() { return '知识搜索与问答'; } getIcon() { return 'search'; }
  roleChanged(){this.searchVersion++;this.answerVersion++;this.history=[];this.turns=[];this.hits=[];this.edges=[];this.query='';this.selected=undefined;this.projectContext=undefined;this.setAsking(false);void this.onOpen();}
  async onClose() { this.searchVersion++; this.answerVersion++; }
  private report(message: string) { this.status.textContent = message; if (this.askStatus) this.askStatus.textContent = message; }
  private setAsking(busy: boolean) { this.asking = busy; if (this.askButton) { this.askButton.disabled = busy; this.askButton.textContent = busy ? '正在查证…' : '查证并回答'; } if (this.stopButton) this.stopButton.disabled = !busy; }
  private button(parent: HTMLElement, label: string, action: () => void | Promise<void>, primary = false) {
    const b = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
    b.onclick = () => { void Promise.resolve().then(action).catch(e => { this.status.textContent = e instanceof Error ? e.message : '操作失败，请重试。'; }); }; return b;
  }
  async onOpen() {
    const root = this.contentEl; root.empty(); root.addClass('kf-search-root');
    root.createEl('h1', { text: '知识搜索与问答' });
    root.createEl('p', { text: '从笔记发现关联，让答案有据可查。'+(this.plugin.currentRole?.()?' 当前岗位：'+this.plugin.currentRole()!.name+'，本岗优先，按需扩展授权资料。':''), cls: 'kf-muted kf-search-intro' });
    this.projectBanner = root.createDiv(); this.drawProjectContext();
    const form = root.createEl('form', { cls: 'kf-search-form' });
    const label = form.createEl('label', { text: '搜索知识库', attr: { for: 'kf-search-query' } });
    const input = form.createEl('input', { type: 'search', attr: { id: 'kf-search-query', placeholder: '输入关键词，例如：产品发布、同步方案' } });
    const submit = form.createEl('button', { text: '搜索', type: 'submit', cls: 'mod-cta' });
    label.classList.add('kf-search-label'); form.onsubmit = e => { e.preventDefault(); void this.search(input.value); };
    this.status = root.createEl('p', { cls: 'kf-muted', attr: { role: 'status', 'aria-live': 'polite' } });
    const tabs = root.createEl('nav', { cls: 'kf-search-tabs', attr: { 'aria-label': '搜索页面区域' } });
    const layout = root.createDiv({ cls: 'kf-search-layout' });
    const left = layout.createEl('section', { cls: 'kf-search-results' }); left.createEl('h2', { text: '相关笔记' }); this.results = left.createDiv();
    const right = layout.createEl('section', { cls: 'kf-search-graph' }); right.createEl('h2', { text: '相关关系图谱' });
    const filters = right.createDiv({ cls: 'kf-graph-controls' });
    for (const [type, name] of [['link', '已有链接（实线）'], ['tag', '共同标签（点线）'], ['ai', 'AI 建议（虚线）']] as const) {
      const field = filters.createEl('label'); const check = field.createEl('input', { type: 'checkbox' }); check.checked = this.types.has(type); field.createEl('span', { text: name });
      check.onchange = () => { check.checked ? this.types.add(type) : this.types.delete(type); this.renderGraph(); };
    }
    this.button(filters, '重置视图', () => this.renderGraph());
    this.button(filters, '放大查看', () => { right.classList.toggle('is-expanded'); this.renderGraph(); });
    this.graph = right.createDiv({ cls: 'kf-graph-canvas' }); this.detail = right.createDiv({ cls: 'kf-graph-detail' });
    this.relationStatus = right.createEl('p', { cls: 'kf-muted', attr: { role: 'status' } });
    this.button(right, '重试 AI 关联', () => this.associate(this.searchVersion));
    const qa = root.createEl('section', { cls: 'kf-search-qa' }); root.insertBefore(qa, layout); qa.createEl('h2', { text: '向知识库提问' });
    qa.createEl('p', { text: '结合本地知识、网络证据和综合分析，形成可归档的研究回答。', cls: 'kf-muted' });
    const webToggle = qa.createEl('label', { cls: 'kf-toggle' }); const webCheckbox = webToggle.createEl('input', { type: 'checkbox' }); webCheckbox.checked = this.online;
    webToggle.createEl('span', { text: '联网研究 · 本地知识＋真实网页＋综合分析' }); webCheckbox.onchange = () => { this.online = webCheckbox.checked; };
    this.button(qa, '配置联网搜索', () => this.plugin.openSettings());
    this.researchInfo = qa.createDiv({ cls: 'kf-research-info' });
    const questionLabel = qa.createEl('label', { text: '你的问题', cls: 'kf-field' }); this.question = questionLabel.createEl('textarea', { attr: { placeholder: '例如：产品发布有哪些关键步骤？为什么采用这个方案？', 'aria-label': '你的问题' } });
    const actions = qa.createDiv({ cls: 'kf-actions' }); this.askButton = this.button(actions, '查证并回答', () => this.ask(), true);
    this.stopButton = this.button(actions, '停止等待', () => { this.answerVersion++; this.setAsking(false); this.report('已停止等待；服务端可能仍处理已发送的请求。'); }); this.stopButton.disabled = true;
    this.button(actions, '新建问答', () => { this.answerVersion++; this.setAsking(false); this.history = []; this.turns = []; this.question.value = ''; this.answerPanel.empty(); this.askStatus.textContent = '开始新的问答。'; this.renderGraph(); });
    this.button(actions, '重试问答', () => this.ask()); this.answerPanel = qa.createDiv({ cls: 'kf-answer' });
    this.askStatus = qa.createEl('p', { cls: 'kf-qa-status', attr: { role: 'status', 'aria-live': 'polite' } }); qa.insertBefore(this.askStatus, this.answerPanel);
    qa.createEl('p', { text: '所选联网服务仅接收公开检索词；相关笔记和网页片段交给当前 AI。回答可预览后归档，网页全文与完整聊天不永久保存。', cls: 'kf-muted kf-caption' });
    for (const [name, pane] of [['搜索图谱', '图谱'], ['AI 问答', '问答']] as const) { const b = this.button(tabs, name, () => { root.setAttribute('data-pane', pane); for (const button of Array.from(tabs.querySelectorAll('button'))) button.setAttribute('aria-current', button === b ? 'page' : 'false'); root.scrollTop = 0; }); b.setAttribute('aria-current', pane === '图谱' ? 'page' : 'false'); }
    root.setAttribute('data-pane', '图谱');
    input.disabled = submit.disabled = true;
    try { await this.plugin.knowledge().index.build((done, total) => { this.status.textContent = `正在建立本地索引 ${done}/${total}…`; }); this.status.textContent = `已索引 ${this.plugin.knowledge().index.notes.size} 份笔记。输入关键词开始搜索。`; }
    catch { this.status.textContent = '索引读取失败，请重新打开页面重试。'; }
    finally { input.disabled = submit.disabled = false; }
  }
  private async search(query: string) {
    this.answerVersion++; this.setAsking(false);
    this.query = query.trim(); const version = ++this.searchVersion; this.edges = []; this.count = 50; this.selected = undefined;
    this.hits = this.plugin.knowledge().index.search(this.query); this.status.textContent = this.query ? `找到 ${this.hits.length} 份相关笔记。` : '请输入关键词。';
    this.renderResults(); this.renderGraph(); this.detail.empty();
    if (this.hits.length) await this.associate(version);
  }
  private async associate(version: number) {
    if (!this.hits.length) return; this.relationStatus.textContent = '正在生成 AI 建议关联；已有链接和标签已可查看。';
    try {
      const edges: Relation[] = [];
      for (let start = Math.max(0, this.count - 50); start < Math.min(this.count - 50 + 12, this.hits.length); start += 12) {
        if (version !== this.searchVersion) return;
        edges.push(...await this.plugin.knowledge().associate(this.hits.slice(start, start + 12).map(h => h.note), this.query));
      }
      if (version !== this.searchVersion) return;
      this.edges = edges; this.relationStatus.textContent = `AI 建议关联 ${edges.length} 条。建议用于发现材料，事实请核对原笔记。`; this.renderGraph();
    } catch (e) { if (version === this.searchVersion) this.relationStatus.textContent = `AI 关联失败：${e instanceof Error ? e.message : '请重试'}。本地结果仍可使用。`; }
  }
  private renderResults() {
    this.results.empty(); this.results.createEl('p', { text: `匹配 ${this.hits.length} 份 · 已展示 ${Math.min(this.count, this.hits.length)} 份`, cls: 'kf-muted' });
    if (!this.hits.length) this.results.createEl('p', { text: '没有匹配笔记。尝试缩短关键词，或检查知识是否已归档。', cls: 'kf-empty' });
    for (const hit of this.hits.slice(0, this.count)) {
      const row = this.results.createEl('article', { cls: 'kf-search-hit' });
      this.button(row, hit.note.title, () => { this.selected = hit.note.id; this.showDetail(hit.note); this.renderGraph(); });
      row.createEl('p', { text: hit.note.id.includes('/') ? hit.note.id.slice(0, hit.note.id.lastIndexOf('/')) : '笔记库根目录', cls: 'kf-muted kf-caption', attr: { title: hit.note.id } }); row.createEl('p', { text: hit.excerpt.replace(/^#{1,6}\s*/gm, '').replace(/`+/g, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1').slice(0, 180), cls: 'kf-search-excerpt' });
      this.button(row, '打开笔记', () => this.app.workspace.openLinkText(hit.note.id, '', false));
    }
    if (this.count < this.hits.length) this.button(this.results, '加载更多', async () => { this.count += 50; this.renderResults(); this.renderGraph(); await this.associate(this.searchVersion); });
  }
  private showDetail(note: KnowledgeNote) {
    this.detail.empty(); this.detail.createEl('h3', { text: note.title }); this.detail.createEl('p', { text: note.id, cls: 'kf-muted kf-caption' });
    this.detail.createEl('p', { text: this.plugin.knowledge().index.search(this.query).find(h => h.note.id === note.id)?.excerpt || note.text.slice(0, 300) });
    for (const edge of this.plugin.knowledge().index.neighbors(note.id, this.edges)) this.detail.createEl('p', { text: `${edge.reason} → ${this.plugin.knowledge().index.notes.get(edge.id)?.title || edge.id}`, cls: 'kf-muted kf-caption' });
    this.button(this.detail, '打开原笔记', () => this.app.workspace.openLinkText(note.id, '', false));
  }
  private renderGraph() {
    this.graph.empty(); const index = this.plugin.knowledge().index;
    const current = this.hits.slice(Math.max(0, this.count - 50), this.count);
    const data = index.graph(current, 50, this.edges); const evidenceIds = new Set(this.turns.at(-1)?.result.citations.map(e => e.id) || []);
    this.graph.createEl('p', { text: `当前结果批次 ${current.length} 份 · 图谱 ${data.nodes.length} 个节点 · 引用节点以外圈标记`, cls: 'kf-muted kf-caption' });
    if (!data.nodes.length) { this.graph.createEl('p', { text: '搜索后显示相关图谱。', cls: 'kf-empty' }); return; }
    const width = Math.max(360, this.graph.clientWidth || 650), height = 520;
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('aria-label', '相关笔记关系图谱'); svg.setAttribute('role', 'img'); svg.classList.add('kf-graph-svg'); this.graph.appendChild(svg);
    const group = document.createElementNS(ns, 'g'); svg.appendChild(group);
    const positions = new Map(data.nodes.map((n, i) => { const angle = i * 2.399963, radius = 25 + Math.sqrt(i / Math.max(1, data.nodes.length)) * (Math.min(width, height) / 2 - 60); return [n.id, { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius }]; }));
    const displayedEdges = data.edges.filter(e => this.types.has(e.type));
    for (let step = 0; step < 60; step++) {
      const delta = new Map(data.nodes.map(n => [n.id, { x: 0, y: 0 }]));
      for (let i = 0; i < data.nodes.length; i++) for (let j = i + 1; j < data.nodes.length; j++) { const a = positions.get(data.nodes[i].id)!, b = positions.get(data.nodes[j].id)!, dx = a.x - b.x, dy = a.y - b.y, distance = Math.max(10, Math.hypot(dx, dy)), force = 150 / (distance * distance); delta.get(data.nodes[i].id)!.x += dx * force; delta.get(data.nodes[i].id)!.y += dy * force; delta.get(data.nodes[j].id)!.x -= dx * force; delta.get(data.nodes[j].id)!.y -= dy * force; }
      for (const e of displayedEdges) { const a = positions.get(e.from)!, b = positions.get(e.to)!, dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy)), force = (distance - 100) * .008; delta.get(e.from)!.x += dx / distance * force; delta.get(e.from)!.y += dy / distance * force; delta.get(e.to)!.x -= dx / distance * force; delta.get(e.to)!.y -= dy / distance * force; }
      for (const n of data.nodes) { const p = positions.get(n.id)!, d = delta.get(n.id)!; p.x = Math.max(35, Math.min(width - 35, p.x + d.x)); p.y = Math.max(35, Math.min(height - 35, p.y + d.y)); }
    }
    const lines: Array<{ element: SVGLineElement; edge: Relation }> = [];
    for (const edge of displayedEdges) { const line = document.createElementNS(ns, 'line'); line.classList.add('kf-edge', `kf-edge-${edge.type}`); const title = document.createElementNS(ns, 'title'); title.textContent = edge.reason; line.appendChild(title); group.appendChild(line); lines.push({ element: line, edge }); }
    const nodes: Array<{ element: SVGGElement; id: string }> = [];
    const update = () => { for (const { element, edge } of lines) { const a = positions.get(edge.from)!, b = positions.get(edge.to)!; for (const [attr, value] of [['x1', a.x], ['y1', a.y], ['x2', b.x], ['y2', b.y]] as const) element.setAttribute(attr, String(value)); } for (const n of nodes) { const p = positions.get(n.id)!; n.element.setAttribute('transform', `translate(${p.x},${p.y})`); } };
    let scale = 1, panX = 0, panY = 0; const transform = () => group.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
    const point = (event: PointerEvent) => { const p = svg.createSVGPoint(); p.x = event.clientX; p.y = event.clientY; return p.matrixTransform(svg.getScreenCTM()!.inverse()); };
    let dragging: string | 'pan' | undefined, last = { x: 0, y: 0 }, moved = false;
    for (const note of data.nodes) {
      const node = document.createElementNS(ns, 'g'); node.classList.add('kf-node'); if (evidenceIds.has(note.id)) node.classList.add('is-evidence'); if (this.selected === note.id) node.classList.add('is-selected');
      node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button'); node.setAttribute('aria-label', `查看笔记：${note.title}`);
      const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('r', evidenceIds.has(note.id) ? '9' : '6'); node.appendChild(circle);
      const text = document.createElementNS(ns, 'text'); text.setAttribute('y', '20'); text.setAttribute('text-anchor', 'middle'); text.textContent = note.title.length > 16 ? note.title.slice(0, 16) + '…' : note.title; if (data.nodes.length > 30 && !evidenceIds.has(note.id) && this.selected !== note.id && !current.slice(0, 8).some(h => h.note.id === note.id)) text.classList.add('kf-node-label-secondary'); node.appendChild(text);
      const title = document.createElementNS(ns, 'title'); title.textContent = note.title; node.appendChild(title); group.appendChild(node); nodes.push({ element: node, id: note.id });
      node.onpointerdown = e => { e.stopPropagation(); dragging = note.id; moved = false; last = point(e); svg.setPointerCapture(e.pointerId); };
      node.onclick = () => { if (!moved) { this.selected = note.id; this.showDetail(note); } };
      node.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.showDetail(note); } };
    }
    svg.onpointerdown = e => { dragging = 'pan'; last = point(e); moved = false; svg.setPointerCapture(e.pointerId); };
    svg.onpointermove = e => { if (!dragging) return; const p = point(e), dx = p.x - last.x, dy = p.y - last.y; if (Math.abs(dx) + Math.abs(dy) > 2) moved = true; if (dragging === 'pan') { panX += dx; panY += dy; transform(); } else { const pos = positions.get(dragging)!; pos.x += dx / scale; pos.y += dy / scale; update(); } last = p; };
    svg.onpointerup = () => { if (dragging && dragging !== 'pan' && !moved) this.showDetail(index.notes.get(dragging)!); dragging = undefined; }; svg.onpointercancel = () => { dragging = undefined; };
    svg.addEventListener('wheel', e => { e.preventDefault(); scale = Math.max(.25, Math.min(4, scale * (e.deltaY > 0 ? .9 : 1.1))); transform(); }, { passive: false }); update();
  }
  private async ask() {
    if (this.asking) return; const question = this.question.value.trim(); if (!question) { this.status.textContent = '请先输入问题。'; return; }
    this.searchVersion++;
    const version = ++this.answerVersion; const active = () => version === this.answerVersion; this.setAsking(true); this.edges = []; this.report('1/3 正在检索笔记并沿图谱查找证据…');
    try {
      const service = this.plugin.knowledge(), query = [...this.history.slice(-2).map(h => h.question), question].join(' ');
      this.query = query; this.hits = service.index.search(query); this.count = 50; this.renderResults(); this.renderGraph();
      if (!greeting(question) && typeof this.plugin.research === 'function' && this.online) requireSearch(this.plugin.state.settings);
      try { const edges = greeting(question) ? [] : await service.associate(this.hits.slice(0, 20).map(h => h.note), query); if (!active()) return; this.edges = edges; this.relationStatus.textContent = `AI 建议关联 ${edges.length} 条`; }
      catch { if (!active()) return; this.relationStatus.textContent = 'AI 关联暂不可用，本次沿已有链接与标签查证。'; }
      if (!active()) return; this.report('2/3 已找到相关材料，AI 正在依据笔记回答…');
      const result = typeof this.plugin.research === 'function' ? await this.plugin.research().answer(question, this.history, this.edges, this.online, active, value => {
        if (!active()) return; this.report(value.phase); this.researchInfo.empty();
        if (value.queries?.length) { const detail = this.researchInfo.createEl('details'); detail.createEl('summary', { text: `检索词 ${value.queries.length} 条 · 网络候选来源 ${value.sources || 0} 个` }); for (const q of value.queries) detail.createEl('p', { text: q, cls: 'kf-muted kf-caption' }); }
      }, this.projectContext?.paths) : await service.answer(question, this.history, this.edges, active); if (!active()) return;
      this.history.push({ question, answer: result.answer }); this.turns.push({ question, result }); this.question.value = ''; this.renderGraph();
      const turn = this.answerPanel.createEl('article', { cls: 'kf-answer-turn' }); turn.createEl('h3', { text: question }); const content = turn.createDiv();
      const safeAnswer = result.answer.replace(/!\[\[[\s\S]*?\]\]/g, '[嵌入已省略]').replace(/!\[/g, '[').replace(/<[^>]*>/g, '');
      await MarkdownRenderer.render(this.app, safeAnswer, content, '', this);
      // Rendered model links are not actionable; only verified citations below can navigate.
      for (const anchor of Array.from(content.querySelectorAll('a'))) anchor.replaceWith(document.createTextNode(anchor.textContent || ''));
      if (result.research) {
        turn.createEl('p', { text: result.research.mode === 'mixed' ? '研究模式：本地＋网络＋综合分析' : result.research.mode === 'greeting' ? '知识助手' : '研究模式：本地与通用框架（未完成联网研究）', cls: 'kf-muted kf-caption' });
        for (const warning of result.research.warnings) turn.createEl('p', { text: warning, cls: 'kf-muted kf-caption' });
      }
      turn.createEl('h4', { text: '笔记引用' });
      if (!result.citations.some(c => c.kind !== 'web')) turn.createEl('p', { text: '本次没有引用本地笔记。', cls: 'kf-muted' });
      result.citations.forEach((c, i) => { if (c.kind !== 'web') { const title = service.index.notes.get(c.id)?.title || c.id; this.button(turn, `[${i + 1}] ${title}${c.heading ? ' · ' + c.heading : ''}`, () => this.app.workspace.openLinkText(c.id + (c.heading ? '#' + c.heading : ''), '', false)); } });
      if (result.citations.some(c => c.kind === 'web')) { turn.createEl('h4', { text: '网络来源' }); result.citations.forEach((c, i) => { if (c.kind === 'web' && c.url) { turn.createEl('a', { text: `[${i + 1}] ${c.title || c.url}`, attr: { href: c.url, target: '_blank', rel: 'noopener noreferrer' } }); turn.createEl('p', { text: `发布：${c.publishedDate || '未提供'} · 检索：${c.fetchedAt || ''}`, cls: 'kf-muted kf-caption' }); } }); }
      if (result.research && result.research.mode !== 'greeting') { const archive = this.button(turn, '归档到知识库', async () => { archive.disabled = true; archive.textContent = '准备归档预览…'; try { await this.plugin.previewResearch(result); archive.textContent = '查看归档草稿'; } catch (e) { archive.textContent = '归档到知识库'; throw e; } finally { archive.disabled = false; } }, true); }
      this.report('3/3 回答完成。可继续追问，或打开引用核对。');
    } catch (e) { if (active()) this.report(`问答失败：${e instanceof Error ? e.message : '请重试'}`); }
    finally { if (active()) this.setAsking(false); }
  }
}
