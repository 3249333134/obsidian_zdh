// Live AI compatibility check with synthetic sources and an in-memory vault.
// No user note is read, no real web search is made, and nothing is written to the user vault.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const vaultPath = process.argv[2];
if (!vaultPath) throw new Error('Provide the authorized vault path for its existing AI configuration.');
const settings = { ...JSON.parse(await fs.readFile(path.join(vaultPath, '.obsidian/plugins/knowledge-flow/data.json'), 'utf8')).settings, searchApiKey: 'simulation-only-not-a-real-key' };
const bundled = await build({ stdin: { contents: "export * from './src/knowledge'; export * from './src/research'; export {createChat} from './src/ai';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian', 'node:*'] });
const nativeRequire = createRequire(import.meta.url), module = { exports: {} };
class TFile { constructor(path) { this.path = path; } }
class TFolder { constructor(path) { this.path = path; } }
let aiRequests = 0, searches = 0;
const requestUrl = async options => {
  if (!options.url.includes('/chat/completions')) throw new Error('This smoke test must not call a live search API.');
  aiRequests++;
  const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body, signal: AbortSignal.timeout(120000) });
  const json = await response.json(); console.log(JSON.stringify({ aiStatus: response.status, finish: json.choices?.[0]?.finish_reason, characters: json.choices?.[0]?.message?.content?.length }));
  return { status: response.status, json };
};
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(name => name === 'obsidian' ? { TFile, TFolder, requestUrl } : nativeRequire(name), module, module.exports);
const { KnowledgeIndex, KnowledgeQA, ResearchService, createChat, archiveResearch, draftAnalysis } = module.exports;
const chat = createChat(settings, { maxTokens: 8192, timeoutMs: 120000 }), index = new KnowledgeIndex({}, () => []);
const local = new KnowledgeQA(index, {}, async () => {}, () => chat, () => settings.model, () => settings.apiKey);
const sources = ['年份口径', '用户场景', '竞争比较', '项目建议'].map((title, i) => ({ url: `https://example.org/synthetic-report-${i}`, title: `合成演示：${title}`, text: `【仅合成测试资料，不是真实行业报告】${title}：演示研究应核对数据年份和口径，区分用户需求与实际交付，用多来源比较支持结论；没有数据时不编造行业规模。`, score: .8, fetchedAt: new Date().toISOString(), status: 'excerpt' }));
const web = { search: async () => { searches++; return sources; }, extract: async rows => rows.map(s => ({ ...s, status: 'read' })) };
const service = new ResearchService(local, () => settings, () => chat, () => web);
const started = Date.now();
const result = await service.answer('请用合成演示资料说明如何整合资料、形成研究建议并保留引用。这是模拟流程验证，不是真实行业分析。', [], [], true, () => true, p => console.log(JSON.stringify({ phase: p.phase })));
if (!result.citations.length || result.citations.some(c => !sources.some(s => s.url === c.url))) throw new Error('Synthetic evidence mapping failed.');
const entries = new Map(), contents = new Map();
const vault = { getAbstractFileByPath: p => entries.get(p), createFolder: async p => { entries.set(p, new TFolder(p)); }, create: async (p, text) => { const f = new TFile(p); entries.set(p, f); contents.set(p, text); return f; }, read: async f => contents.get(f.path) };
const task = { id: 'smoke-task', name: '合成研究', sourcePath: '', createdAt: new Date().toISOString(), status: 'review', research: result.research, analysis: draftAnalysis(result, settings) };
await archiveResearch(vault, settings, task, async () => {}); await archiveResearch(vault, settings, task, async () => {});
if (contents.size !== 1 || task.status !== 'done') throw new Error('Archive idempotency failed.');
console.log(JSON.stringify({ passed: true, synthetic: true, realWebSearch: false, userVaultWrites: 0, aiRequests, mockSearches: searches, answerCharacters: result.answer.length, citations: result.citations.length, archivedNotes: contents.size, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
