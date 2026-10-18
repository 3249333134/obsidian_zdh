// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import { Workbench } from '../src/view';
import { defaultSettings } from '../src/config';
import { defaultSync } from '../src/sync-engine';
import { analysis } from './fixtures';
beforeAll(() => {
  const p = HTMLElement.prototype as any;
  p.empty = function () { this.replaceChildren(); };
  p.addClass = function (...names: string[]) { this.classList.add(...names); };
  p.createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
    if (options.text) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    if (options.type) el.setAttribute('type', options.type);
    for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, String(value));
    this.appendChild(el); return el;
  };
  p.createDiv = function (options: any) { return this.createEl('div', options); };
});
function setup() {
  const root = document.createElement('div'); document.body.replaceChildren(root);
  const plugin: any = { sync: defaultSync(), state: { settings: defaultSettings(), tasks: [] }, syncNow: vi.fn() };
  plugin.saveSyncSource = vi.fn(async (source: any) => Object.assign(plugin.sync.sources.find((s: any) => s.id === source.id), source));
  const view = new Workbench({ contentEl: root, app: { workspace: { openLinkText: vi.fn() } } } as any, plugin);
  view.tab = 'sync'; view.render(); return { root, plugin, view };
}
it('updates sync status and collected count without replacing unsaved inputs', () => {
  const { root, plugin, view } = setup();
  const input = root.querySelector('input')!; input.value = 'unsaved path'; input.dispatchEvent(new Event('input'));
  plugin.sync.sources[0].enabled = true; plugin.sync.sources[0].lastScanAt = new Date().toISOString();
  plugin.sync.conversations.push({ sourceId: 'codex', title: 'New conversation', pendingCount: 1, transcriptPath: 'test.md' });
  view.refresh();
  expect(root.textContent).toContain('同步已启用'); expect(root.textContent).toContain('提炼会话 · 1');
  expect(root.textContent).toContain('New conversation'); expect(root.querySelector('input')).toBe(input);
  expect(input.value).toBe('unsaved path');
});
it('immediate sync saves and enables the source before scanning', async () => {
  const { root, plugin } = setup();
  [...root.querySelectorAll('button')].find(b => b.textContent === '立即同步')!.click();
  await vi.waitFor(() => expect(plugin.syncNow).toHaveBeenCalledWith('codex'));
  expect(plugin.sync.sources[0].enabled).toBe(true);
  expect(plugin.saveSyncSource.mock.invocationCallOrder[0]).toBeLessThan(plugin.syncNow.mock.invocationCallOrder[0]);
});
it('preserves the selected review editor while other analyses refresh', () => {
  const { root, plugin, view } = setup();
  plugin.persist = vi.fn(async () => {});
  const task = { id: 'review', name: '主题', status: 'review', analysis: { ...analysis } };
  plugin.state.tasks = [task]; view.tab = 'review'; view.render();
  const editor = root.querySelector('textarea')!; editor.value = '用户正在编辑的文字';
  view.refresh(); expect(root.querySelector('textarea')).toBe(editor); expect(editor.value).toBe('用户正在编辑的文字');
  task.status = 'superseded'; view.refresh(); expect(root.querySelector('textarea')).toBeNull();
});
it('distinguishes each conversation source and document imports in history', () => {
  const { root, plugin, view } = setup();
  for (const source of plugin.sync.sources) {
    plugin.sync.conversations.push({ key: source.id, sourceId: source.id, sessionId: 'session-' + source.id, appName: source.id === 'codex' ? 'Work' : undefined });
    plugin.state.tasks.push({ id: source.id, name: '同一个主题', status: 'review', conversationKey: source.id, analysis: { ...analysis } });
  }
  plugin.state.tasks.push({ id: 'document', name: '原始材料.pdf', status: 'done' });
  plugin.state.tasks.push({ id: 'missing', name: '旧记录', status: 'done', conversationKey: 'missing' });
  view.tab = 'history'; view.render();
  for (const source of plugin.sync.sources) expect(root.textContent).toContain(`来源：${source.id === 'codex' ? 'Work' : source.name} · 对话提炼`);
  expect(root.textContent).toContain('来源：文档导入 · 原始材料.pdf');
  expect(root.textContent).toContain('来源：未知（来源记录缺失）');
});
it('shows provenance and the complete session identifier in preview', () => {
  const { root, plugin, view } = setup();
  plugin.sync.conversations.push({ key: 'test', sourceId: 'workbuddy', sessionId: 'complete-session-id', firstMessageAt: '2026-10-08', lastMessageAt: '2026-10-14' });
  plugin.state.tasks.push({ id: 'test', name: '主题', status: 'review', conversationKey: 'test', analysis: { ...analysis } });
  view.tab = 'review'; view.render();
  expect(root.textContent).toContain('来源：WorkBuddy');
  expect(root.textContent).toContain('会话：complete-session-id');
  expect(root.textContent).toContain('时间范围：2026-10-08 — 2026-10-14');
});
