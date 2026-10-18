import fs from 'node:fs/promises';import path from 'node:path';
const version=JSON.parse(await fs.readFile('manifest.json','utf8')).version;
const stage=path.resolve('.test-output/company-package-'+Date.now()),server=path.join(stage,'knowledge-flow-company-server-'+version),source=path.join(stage,'knowledge-flow-source-'+version);
await fs.mkdir(server,{recursive:true});await fs.mkdir(source,{recursive:true});
for(const name of ['dist','package.json','package-lock.json','Dockerfile','.env.example','backup.mjs'])await fs.cp('server/company/'+name,path.join(server,name),{recursive:true});
await fs.copyFile('COMPANY-GUIDE.md',path.join(server,'管理员与员工说明.md'));
await fs.copyFile('ROLE-TEMPLATES.md',path.join(server,'ROLE-TEMPLATES.md'));
await fs.copyFile('ROLE-WORKSPACES.md',path.join(server,'ROLE-WORKSPACES.md'));
await fs.cp('templates/company-roles',path.join(server,'templates/company-roles'),{recursive:true});
const licenses=[];
async function collect(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(!e.isDirectory()||e.name.startsWith('.'))continue;const base=path.join(dir,e.name);if(e.name.startsWith('@')){await collect(base);continue;}for(const f of await fs.readdir(base))if(/^(license|notice|copying)(\.|$)/i.test(f)){try{licenses.push('\n===== '+path.relative('server/company/node_modules',base)+'/'+f+' =====\n'+await fs.readFile(path.join(base,f),'utf8'));}catch{}}try{await collect(path.join(base,'node_modules'));}catch{}}}
await collect('server/company/node_modules');await fs.writeFile(path.join(server,'THIRD-PARTY-LICENSES.txt'),licenses.join('\n'));
for(const name of ['src','integration','vendor','scripts','tests','installer','templates','.impeccable'])await fs.cp(name,path.join(source,name),{recursive:true,filter:p=>!p.split(path.sep).some(x=>x==='node_modules'||x==='.git')});
for(const name of ['package.json','package-lock.json','manifest.json','tsconfig.json','vitest.config.ts','styles.css','README.md','COMPANY-GUIDE.md','ROLE-TEMPLATES.md', 'ROLE-WORKSPACES.md','DIARY-CONNECTION.md','VERIFICATION-0.9.0.md','DESIGN.md','PRODUCT.md','THIRD-PARTY-NOTICES.md','.gitignore'])try{await fs.copyFile(name,path.join(source,name));}catch(e){if(e.code!=='ENOENT')throw e;}
for(const name of ['src','public','package.json','package-lock.json','build.mjs','tsconfig.json','Dockerfile','.env.example','backup.mjs'])await fs.cp('server/company/'+name,path.join(source,'server/company',name),{recursive:true});
await fs.writeFile('.test-output/company-package-paths.json',JSON.stringify({server,source,version}));
console.log('Company deployment and source staged without private configuration.');
