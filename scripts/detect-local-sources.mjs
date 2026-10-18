import { build } from 'esbuild';
import { createRequire } from 'node:module';
await build({ entryPoints: ['src/sync-reader.ts'], outfile: '.test-output/sync-reader.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['node:*'] });
const { defaultSources, detectSource, sourceFiles, readSourceFile } = createRequire(import.meta.url)('../.test-output/sync-reader.cjs');
for (const source of defaultSources().filter(s => s.kind !== 'trae')) {
  try { const found = await detectSource(source); source.directory = found.directory;
    const files = await sourceFiles(source);
    console.log(JSON.stringify({ source: source.kind, directory: found.directory, message: found.message, fileCount: files.length }));
    if (process.argv.includes('--schema-check')) {
      const roles = { user: 0, assistant: 0 };
      for (const file of files.slice(0, 3)) for (const record of (await readSourceFile(source, file)).records) roles[record.message.role]++;
      console.log(JSON.stringify({ source: source.kind, sampleRoles: roles }));
    }
  } catch (error) { console.log(JSON.stringify({ source: source.kind, error: error.message })); }
}
