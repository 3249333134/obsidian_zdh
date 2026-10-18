import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const [vaultRoot, from, to] = process.argv.slice(2);
if (!vaultRoot || !from || !to) throw new Error('Usage: vault from to; close Obsidian first');
if (process.platform === 'win32' && /"Obsidian\.exe"/i.test(execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Obsidian.exe', '/FO', 'CSV'], { encoding: 'utf8' }))) throw new Error('Obsidian is still running; exit it completely before importing.');
const require = createRequire(import.meta.url);
const dataPath = path.join(vaultRoot, '.obsidian/plugins/knowledge-flow/data.json');
const state = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
if (state.sync?.modeVersion !== 2) throw new Error('Enable the plugin in Obsidian to migrate legacy records first.');
const backup = dataPath + '.before-history-' + Date.now(); fs.copyFileSync(dataPath, backup);
const resolve = p => {
  const absolute = path.resolve(vaultRoot, p);
  if (!absolute.startsWith(path.resolve(vaultRoot) + path.sep)) throw new Error('Vault boundary');
  return absolute;
};
// Host constructors are exported below by a tiny build entry to preserve instanceof.
await build({ stdin: { contents: "export { SyncEngine } from './src/sync-engine'; export { TFile, TFolder } from 'obsidian'; export { persistentState } from './src/sync-migration';", resolveDir: process.cwd() },
  outfile: '.test-output/history-engine.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['node:*'],
  plugins: [{ name: 'vault-host', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    b.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: 'export class TFile { constructor(path) { this.path = path } }; export class TFolder { constructor(path) { this.path = path } };', loader: 'js' }));
  } }] });

const hostModule = require('../.test-output/history-engine.cjs');
const vault = {
  adapter: { getBasePath: () => vaultRoot },
  getAbstractFileByPath(p) { try { return fs.statSync(resolve(p)).isDirectory() ? new hostModule.TFolder(p) : new hostModule.TFile(p); } catch { return null; } },
  async createFolder(p) { fs.mkdirSync(resolve(p)); },
  async create(p, text) { fs.writeFileSync(resolve(p), text, { flag: 'wx' }); return new hostModule.TFile(p); },
  async read(file) { return fs.readFileSync(resolve(file.path), 'utf8'); },
  async process(file, update) { fs.writeFileSync(resolve(file.path), update(fs.readFileSync(resolve(file.path), 'utf8'))); }
};
const save = async () => { fs.writeFileSync(dataPath + '.tmp', JSON.stringify(hostModule.persistentState(state))); fs.renameSync(dataPath + '.tmp', dataPath); };
const engine = new hostModule.SyncEngine({ vault, state: state.sync, settings: () => state.settings, tasks: () => state.tasks, save, refresh: () => {}, enqueue: () => {} });
await engine.tick(); // Recheck old cursors, including internal-session exclusions.
for (const id of ['codex', 'workbuddy']) {
  await engine.importHistory(id, from, to);
  console.log(JSON.stringify({ source: id, conversations: state.sync.conversations.filter(c => c.sourceId === id && !c.excluded).length, warning: state.sync.sources.find(s => s.id === id).error || null }));
}
const trae = state.sync.sources.find(s => s.id === 'trae');
await engine.saveSource({ ...trae, directory: path.join(vaultRoot, '.obsidian/plugins/knowledge-flow/exports'), enabled: true });
for (const task of state.tasks) {
  const c = state.sync.conversations.find(c => c.key === task.conversationKey);
  if (c && !c.excluded && c.revision === task.revision && task.status === 'failed' && task.error === '处理曾中断，请点击重试。' && !task.notePath) {
    task.status = 'queued'; task.error = undefined;
  }
}
await save();
console.log('History imported; TRAE export monitoring enabled. No AI requests made by this helper.');
