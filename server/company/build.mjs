import {build} from 'esbuild';
import fs from 'node:fs/promises';
await build({entryPoints:['src/index.ts'],outfile:'dist/index.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'node22'});
await fs.cp('public','dist/public',{recursive:true});
