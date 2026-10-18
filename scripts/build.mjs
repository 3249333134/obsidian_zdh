import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist/knowledge-flow', { recursive: true });
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/knowledge-flow/main.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', external: ['obsidian', 'fs', 'path', 'url', 'canvas', 'node:*'],
  minify: true, legalComments: 'eof', plugins: [{ name: 'raw-assets', setup(b) {
    b.onResolve({filter:/\?raw$/}, args => ({path:path.resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw'}));
    b.onLoad({filter:/.*/,namespace:'raw'}, async args => ({contents:await readFile(args.path,'utf8'),loader:'text'}));
  }}] });
for (const file of ['manifest.json', 'styles.css', 'README.md', 'THIRD-PARTY-NOTICES.md', 'COMPANY-GUIDE.md', 'ROLE-TEMPLATES.md', 'ROLE-WORKSPACES.md', 'DIARY-CONNECTION.md', 'VERIFICATION-0.9.0.md'])
  await copyFile(file, `dist/knowledge-flow/${file}`);
const licenses = [];
async function collect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue;
    const folder = path.join(directory, item.name);
    if (item.name.startsWith('@')) { await collect(folder); continue; }
    for (const file of await readdir(folder)) if (/^(license|copying|notice)(\.|$)/i.test(file)) {
      try { licenses.push(`\n===== ${path.relative('node_modules', folder)}/${file} =====\n${await readFile(path.join(folder, file), 'utf8')}`); } catch {}
    }
    try { await collect(path.join(folder, 'node_modules')); } catch {}
  }
}
await collect('node_modules');
licenses.push(await readFile('vendor/diary-planning/LICENSES.txt','utf8'));
await writeFile('dist/knowledge-flow/THIRD-PARTY-LICENSES.txt', licenses.join('\n'));
