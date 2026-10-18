// Only a public documentation query is sent. No notes or conversation content are read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const vault = process.argv[2];
if (!vault) throw new Error('Provide the vault path for its saved Agnes authentication.');
const { settings } = JSON.parse(await fs.readFile(path.join(vault, '.obsidian/plugins/knowledge-flow/data.json'), 'utf8'));
const key = settings.agnesSearchKey || (settings.provider === 'agnes' ? settings.apiKey : '');
if (!key) throw new Error('No saved Agnes Key.');
const bundled = await build({ stdin: { contents: "export {AgnesSearch} from './src/web-research';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian', 'node:*'] });
const module = { exports: {} }, nativeRequire = createRequire(import.meta.url);
const requestUrl = async options => {
  if (options.url !== 'https://apihub.agnes-ai.com/v1/responses') throw new Error('Unexpected host.');
  const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body, signal: AbortSignal.timeout(60000) });
  let json; try { json = await response.json(); } catch { json = {}; }
  console.log(JSON.stringify({ httpStatus: response.status, responseStatus: json.status, outputTypes: Array.isArray(json.output) ? json.output.map(item => ({ type: item.type, status: item.status })) : [], errorCode: typeof json.error?.code === 'string' ? json.error.code.replace(/[^a-z_0-9-]/gi, '').slice(0, 50) : undefined, safeError: typeof json.error?.message === 'string' ? json.error.message.split(key).join('[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 350) : undefined }));
  return { status: response.status, json };
};
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(name => name === 'obsidian' ? { requestUrl } : nativeRequire(name), module, module.exports);
try {
  const sources = await new module.exports.AgnesSearch(key, settings.agnesSearchModel || 'agnes-2.5-flash').search('Obsidian official documentation');
  console.log(JSON.stringify({ verifiedNativeSearch: true, sourceCount: sources.length, userNotesRead: 0, vaultWrites: 0 }));
} catch (error) {
  console.log(JSON.stringify({ verifiedNativeSearch: false, reason: error.message, userNotesRead: 0, vaultWrites: 0 }));
}
