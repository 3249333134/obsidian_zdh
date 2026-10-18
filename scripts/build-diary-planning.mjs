import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {compactPanel} from '../integration/diary/compact-panel.mjs';
const diary=path.resolve(process.argv[2]||'D:/prj/user/Diary'),web=path.join(diary,'apps/web/src');
// Both adapters ship from the same canonical contracts, Markdown and recurrence implementation.
await fs.mkdir('src/diary-vendor',{recursive:true});
for(const [file,source]of [['contracts.ts','packages/contracts/src/index.ts'],['recurrence.ts','apps/api/src/recurrence.ts'],['date.ts','apps/api/src/date.ts'],['markdown.ts','apps/api/src/markdown.ts']]){
 const canonical=await fs.readFile(path.join(diary,source),'utf8');await fs.writeFile('src/diary-vendor/'+file,canonical.replaceAll('@diary/contracts','./contracts').replaceAll('./date.js','./date'));
}
const result=await build({entryPoints:['integration/diary/planning-entry.tsx'],bundle:true,write:false,metafile:true,outfile:'planning.js',format:'iife',platform:'browser',target:'es2022',minify:true,jsx:'automatic',nodePaths:[path.join(diary,'node_modules')],plugins:[{name:'diary-planning',setup(b){b.onResolve({filter:/^diary-ui\//},args=>({path:path.join(web,args.path.slice(9)+(/\.(css|tsx?|jsx?)$/.test(args.path)?'':'.tsx'))}));b.onResolve({filter:/^knowledge-flow-plan-context$/},()=>({path:path.resolve('integration/diary/plan-context.tsx')}));b.onLoad({filter:/[\\/]TodoPanel\.tsx$/},async args=>({contents:compactPanel(await fs.readFile(args.path,'utf8')),loader:'tsx'}));b.onResolve({filter:/^\.\/api$/},()=>({path:path.resolve('integration/diary/planning-rpc.ts')}));b.onResolve({filter:/^@diary\/contracts$/},()=>({path:path.join(diary,'packages/contracts/src/index.ts')}));}}]});
await fs.mkdir('vendor/diary-planning',{recursive:true});
for(const file of result.outputFiles)await fs.writeFile(path.join('vendor/diary-planning',file.path.endsWith('.css')?'planning.css':'planning.js'),file.contents);
const digest=(await import('node:crypto')).createHash('sha256');for(const name of ['TodoPanel.tsx','PlanCalendar.tsx','PlanBoard.tsx','PlanWindows.tsx','PlanViews.tsx','RepeatFields.tsx'])digest.update(await fs.readFile(path.join(web,name)));
await fs.writeFile('vendor/diary-planning/SOURCE.json',JSON.stringify({source:'Diary shared planning components',sha256:digest.digest('hex'),builtAt:new Date().toISOString()},null,2));
const packageRoots=new Set();for(const input of Object.keys(result.metafile.inputs)){let folder=path.dirname(path.resolve(input));while(folder!==path.dirname(folder)){if(await fs.stat(path.join(folder,'package.json')).catch(()=>false)){if(folder.includes('node_modules'))packageRoots.add(folder);break;}folder=path.dirname(folder);}}
const licenses=[];for(const folder of packageRoots)for(const file of await fs.readdir(folder))if(/^(license|copying|notice)(\.|$)/i.test(file))licenses.push(`\n===== ${path.basename(folder)}/${file} =====\n${await fs.readFile(path.join(folder,file),'utf8')}`);
await fs.writeFile('vendor/diary-planning/LICENSES.txt',licenses.join('\n'));
await fs.appendFile('vendor/diary-planning/planning.css',`
html,body,#app{margin:0;min-height:100%;font:14px/1.6 system-ui;color:var(--text);background:var(--bg)}*{box-sizing:border-box}button,input,textarea,select{font:inherit}
.kf-planning-shell{display:grid;grid-template-columns:186px minmax(0,1fr);gap:18px;padding:12px}.kf-planning-shell>aside{position:sticky;top:8px;align-self:start;background:var(--surface);border-radius:16px}.kf-planning-shell>main{min-width:0}.kf-planning-shell h2,.kf-planning-shell h3{color:var(--text)}.todo-panel{max-width:none!important}.todo-panel-header{position:static!important}.kf-planning-shell .plan-rail-navigation{width:100%;background:transparent;color:var(--text)}.kf-planning-nav-toggle{display:none}
.glass-modal:has(.todo-modal),.glass-modal.todo-modal{max-height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden}.plan-dialog-content{display:flex;flex-direction:column;min-height:0;max-height:calc(100dvh - 24px);overflow:hidden}.todo-modal{display:flex;flex-direction:column;min-height:0;max-height:calc(100dvh - 24px);color:var(--text);background:var(--surface)}.todo-modal-header,.todo-modal-footer{flex:none}.todo-modal-body{min-height:0;overflow:auto;overscroll-behavior:contain}.todo-modal-footer{flex-wrap:wrap}
@media(max-width:700px){.kf-planning-shell{display:block;padding:8px}.kf-planning-nav-toggle{display:block;margin:0 0 12px;padding:8px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text)}.kf-planning-shell>aside{position:static;display:none}.kf-planning-shell>aside[data-open=true]{display:block;margin-bottom:16px}.plan-rail-navigation nav{display:flex;flex-wrap:wrap;gap:4px}.plan-rail-navigation nav button{width:auto}.plan-rail-group h2,.plan-rail-caption{display:none}}
`);
console.log('Shared Diary planner built from canonical source.');
