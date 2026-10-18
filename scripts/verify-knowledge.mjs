// Opt-in live check. Reads the installed configuration; never prints its key or request body.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const vault = process.argv[2];
const synthetic = process.argv.includes('--synthetic');
if (!vault) throw new Error('Provide the explicitly authorized vault path.');
const data = JSON.parse(await fs.readFile(path.join(vault, '.obsidian/plugins/knowledge-flow/data.json'), 'utf8'));
const output = await build({ stdin: { contents: "export * from './src/knowledge'; export {createChat} from './src/ai';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian', 'node:*'] });
const nativeRequire = createRequire(import.meta.url), module = { exports: {} };
const requestUrl = async options => {
  const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body, signal: AbortSignal.timeout(60000) });
  const json = await response.json();
  console.log(JSON.stringify({ responseStatus: response.status, finish: json.choices?.[0]?.finish_reason, responseCharacters: json.choices?.[0]?.message?.content?.length }));
  const content = json.choices?.[0]?.message?.content || '';
  try { const parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); console.log(JSON.stringify({ fields: Object.keys(parsed), answerType: typeof parsed.answer, citations: Array.isArray(parsed.citations) ? parsed.citations.map(c => typeof c === 'string' && /^E\d+$/.test(c) ? c : { type: typeof c, keys: c && typeof c === 'object' ? Object.keys(c) : [] }) : typeof parsed.citations, markers: typeof parsed.answer === 'string' ? [...parsed.answer.matchAll(/\[(?:E)?\d+\]/g)].map(m => m[0]) : [] })); } catch { console.log(JSON.stringify({ validJSON: false })); }
  return { status: response.status, json };
};
new Function('require', 'module', 'exports', output.outputFiles[0].text)(name => name === 'obsidian' ? { TFile: class {}, requestUrl } : nativeRequire(name), module, module.exports);
const { KnowledgeIndex, KnowledgeQA } = module.exports;
const index = new KnowledgeIndex({}, () => []);
const files = synthetic ? ['演示项目周回顾.md', '演示验收方法.md', '演示决策记录.md'] : ['自动化每周回顾流程及项目进展记录.md', 'MapApp占位功能修复工程与本地数据闭环构建.md', '日记与计划管理应用开发进展：UI重构、计划功能与日程拖动机制.md'];
const demos = ['# 周回顾\n每周核对已完成事项和待办，区分提出的需求与实际交付。采用周回顾以避免重复汇报。', '# 阶段验收\n每个阶段执行检查清单，验收通过后进入下一阶段。采用阶段验收以减少问题累积。', '# 决策依据\n记录目标、方案取舍、结果和待办。选择增量执行以减少重复操作。'];
for (const file of files) {
  const id = '03_BUILD-项目沉淀/' + file;
  const text = synthetic ? demos[files.indexOf(file)] : await fs.readFile(path.join(vault, id), 'utf8');
  index.notes.set(id, { id, title: file.slice(0, -3), text, hash: 'live-check', tags: ['项目管理'], links: [], attributes: '' });
}
const chat = module.exports.createChat(data.settings, { maxTokens: 2400, timeoutMs: 60000 });
const qa = new KnowledgeQA(index, {}, async () => {}, () => chat, () => data.settings.model, () => data.settings.apiKey);
const started = Date.now();
const edges = await qa.associate([...index.notes.values()], '项目管理怎么优化');
console.log(JSON.stringify({ verifiedAssociations: edges.length }));
const result = await qa.answer('根据这些笔记，项目管理可以如何优化？请给出有笔记依据的建议。', [], edges, () => true);
if (!result.citations.length) throw new Error('Live answer did not provide usable citations.');
console.log(JSON.stringify({ passed: true, answerCharacters: result.answer.length, citations: result.citations.length, evidenceNotes: new Set(result.evidence.map(e => e.id)).size, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
