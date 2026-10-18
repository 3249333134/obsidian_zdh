import { vi } from 'vitest';
export class TFile { constructor(public path: string) {} }
export class TFolder { constructor(public path: string) {} }
export const requestUrl = vi.fn();
// Fixtures serialize flow-style YAML as JSON. Real Obsidian supplies its public YAML parser.
export const parseYaml = (text: string) => JSON.parse(text);
export const stringifyYaml = (value: unknown) => JSON.stringify(value, null, 2);
export class Notice { constructor(public message: string) {} }
export class MarkdownRenderer { static async render(_app: any, text: string, container: HTMLElement) { container.textContent = text; } }
export class Plugin {
  app: any; saved: any;
  async loadData() { return this.saved; }
  async saveData(data: any) { this.saved = data; }
  registerView() {} addRibbonIcon() {} addCommand() {} registerObsidianProtocolHandler() {}
  registerInterval() {}
}
export class ItemView {
  contentEl: any; app: any;
  constructor(public leaf: any) { this.contentEl = leaf.contentEl; this.app = leaf.app; }
}
export class MemoryVault {
  adapter: any;
  entries = new Map<string, TFile | TFolder>();
  contents = new Map<string, string | ArrayBuffer>();
  failCreate = false;
  getAbstractFileByPath(path: string) { return this.entries.get(path) || null; }
  async createFolder(path: string) { if (this.entries.has(path)) throw new Error('exists'); const folder = new TFolder(path); this.entries.set(path, folder); return folder; }
  async create(path: string, text: string) {
    if (this.failCreate) { this.failCreate = false; throw new Error('disk full'); }
    if (this.entries.has(path)) throw new Error('exists');
    const file = new TFile(path); this.entries.set(path, file); this.contents.set(path, text); return file;
  }
  async createBinary(path: string, data: ArrayBuffer) { const file = new TFile(path); if (this.entries.has(path)) throw new Error('exists'); this.entries.set(path, file); this.contents.set(path, data.slice(0)); return file; }
  async read(file: TFile) { return this.contents.get(file.path) as string; }
  async delete(file: TFile) { this.entries.delete(file.path); this.contents.delete(file.path); }
  async process(file: TFile, update: (old: string) => string) { const next = update(this.contents.get(file.path) as string); this.contents.set(file.path, next); return next; }
  async readBinary(file: TFile) { return (this.contents.get(file.path) as ArrayBuffer).slice(0); }
  async rename(file: TFile, path: string) {
    if (this.entries.has(path)) throw new Error('exists');
    const content = this.contents.get(file.path)!; this.entries.delete(file.path); this.contents.delete(file.path);
    file.path = path; this.entries.set(path, file); this.contents.set(path, content);
  }
  getMarkdownFiles() { return [...this.entries.values()].filter(f => f instanceof TFile && f.path.endsWith('.md')); }
}
