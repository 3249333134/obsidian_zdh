// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import { SearchView } from '../src/search-view';
beforeAll(() => {
  const p = HTMLElement.prototype as any;
  p.empty = function () { this.replaceChildren(); }; p.addClass = function (...names: string[]) { this.classList.add(...names); };
  p.createEl = function (tag: string, options: any = {}) { const el = document.createElement(tag); if (options.text) el.textContent = options.text; if (options.cls) el.className = options.cls; if (options.type) el.setAttribute('type', options.type); for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, String(value)); this.appendChild(el); return el; };
  p.createDiv = function (o: any) { return this.createEl('div', o); };
});
async function setup() {
  const root = document.createElement('div'); document.body.replaceChildren(root);
  const note = { id: '方法.md', title: '同步方法', text: '方法过程', tags: [], links: [], hash: 'hash' };
  const index = { notes: new Map([[note.id, note]]), build: vi.fn(async () => {}), search: vi.fn(() => [{ note, score: 1, excerpt: '方法过程' }]), neighbors: vi.fn(() => []), graph: vi.fn(() => ({ nodes: [note], edges: [] })) };
  const service = { index, associate: vi.fn(async () => []), answer: vi.fn(async () => ({ answer: '依据笔记 [1]', citations: [{ id: note.id, heading: '步骤' }], evidence: [] })) };
  const app = { workspace: { openLinkText: vi.fn() } }, view = new SearchView({ contentEl: root, app } as any, { knowledge: () => service } as any);
  await view.onOpen();
  const click = (label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label)!.click();
  return { root, service, view, click, app };
}
it('keeps local search and graph usable when AI associations fail', async () => {
  const { root, service } = await setup(); service.associate.mockRejectedValueOnce(new Error('网络失败'));
  root.querySelector('input')!.value = '同步'; root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('AI 关联失败'));
  expect(root.textContent).toContain('同步方法'); expect(root.querySelector('svg')).not.toBeNull();
});
it('renders verified citations and opens the original chapter', async () => {
  const { root, click, app } = await setup(); root.querySelector('textarea')!.value = '同步方法是什么'; click('查证并回答');
  await vi.waitFor(() => expect(root.textContent).toContain('回答完成'));
  click('[1] 同步方法 · 步骤'); await vi.waitFor(() => expect(app.workspace.openLinkText).toHaveBeenCalledWith('方法.md#步骤', '', false));
  click('新建问答'); await vi.waitFor(() => expect(root.querySelector('.kf-answer')!.textContent).toBe(''));
});
it('ignores a late answer after stopping', async () => {
  const { root, service, click } = await setup(); let resolve: (v: any) => void = () => {};
  service.answer.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  root.querySelector('textarea')!.value = '同步'; click('查证并回答'); await vi.waitFor(() => expect(service.answer).toHaveBeenCalled());
  click('停止等待'); await vi.waitFor(() => expect(root.textContent).toContain('已停止等待'));
  resolve({ answer: '迟到内容', citations: [], evidence: [] }); await new Promise(r => setTimeout(r, 0));
  expect(root.textContent).not.toContain('迟到内容');
});
it('shows web sources separately and opens a research archive preview', async () => {
  const { root, service, click, view } = await setup(); const preview = vi.fn(async () => ({}));
  (view as any).plugin.previewResearch = preview;
  service.answer.mockResolvedValueOnce({ answer: '研究报告 [1]', citations: [{ id: 'https://example.org/', heading: '', kind: 'web', url: 'https://example.org/', title: '官方报告', fetchedAt: '2026-10-15' }], evidence: [], research: { id: 'r1', mode: 'mixed', warnings: [], question: '研究' } } as any);
  root.querySelector('textarea')!.value = '研究'; click('查证并回答'); await vi.waitFor(() => expect(root.textContent).toContain('网络来源'));
  expect(root.querySelector('a')!.href).toBe('https://example.org/'); click('归档到知识库'); await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce());
  expect(root.textContent).toContain('查看归档草稿');
});
