// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import { Workbench } from '../src/view';
import { defaultSettings } from '../src/config';

beforeAll(() => {
  const p = HTMLElement.prototype as any;
  p.empty = function () { this.replaceChildren(); }; p.addClass = function (...names: string[]) { this.classList.add(...names); };
  p.createEl = function (tag: string, options: any = {}) { const el = document.createElement(tag); if (options.text) el.textContent = options.text; if (options.cls) el.className = options.cls; if (options.type) el.setAttribute('type', options.type); if (options.value !== undefined) el.setAttribute('value', options.value); for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, String(value)); this.appendChild(el); return el; };
  p.createDiv = function (o: any) { return this.createEl('div', o); };
});
it('shows masked LangSearch configuration, preserves draft keys on switching, and displays test errors inline', async () => {
  const root = document.createElement('div'); document.body.replaceChildren(root);
  const plugin = { state: { settings: { ...defaultSettings(), initialized: true, searchProvider: 'langsearch', langSearchApiKey: 'lang-old', searchApiKey: 'tavily-old' }, tasks: [] }, saveSearchSettings: vi.fn(async () => {}) };
  const view = new Workbench({ contentEl: root, app: {} } as any, plugin as any); view.tab = 'settings'; view.render();
  const provider = () => [...root.querySelectorAll('select')][1];
  const field = (label: string) => [...root.querySelectorAll('label')].find(el => el.querySelector('span')?.textContent === label)!.querySelector('input')!;
  expect(provider().value).toBe('langsearch'); expect(field('LangSearch 搜索 API Key').type).toBe('password');
  expect(root.querySelector('a')!.href).toBe('https://langsearch.com/');
  field('LangSearch 搜索 API Key').value = 'lang-new'; field('LangSearch 搜索 API Key').dispatchEvent(new Event('input'));
  provider().value = 'tavily'; provider().dispatchEvent(new Event('change')); expect(field('Tavily 搜索 API Key').value).toBe('tavily-old');
  provider().value = 'langsearch'; provider().dispatchEvent(new Event('change')); expect(field('LangSearch 搜索 API Key').value).toBe('lang-new');
  plugin.saveSearchSettings.mockRejectedValueOnce(new Error('LangSearch 401：搜索 Key 无效。'));
  const test = [...root.querySelectorAll('button')].find(b => b.textContent === '测试联网并保存')!; test.click();
  await vi.waitFor(() => expect(root.querySelector('[role=status]')!.textContent).toContain('LangSearch 401'));
  expect(root.querySelector('[role=status]')!.textContent).toContain('未更改'); expect(test.disabled).toBe(false);
  expect(plugin.saveSearchSettings).toHaveBeenCalledWith(expect.objectContaining({ langSearchApiKey: 'lang-new', searchProvider: 'langsearch' }), true);
});
