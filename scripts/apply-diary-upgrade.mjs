import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2]||'D:/prj/user/Diary'),staging=path.resolve('integration/diary');
if(root!=='D:\\prj\\user\\Diary'&&root!=='D:/prj/user/Diary'&&!process.argv.includes('--test-root'))throw new Error('Unexpected Diary checkout');
const backup=path.resolve('integration/diary-original');await fs.mkdir(backup,{recursive:true});
async function patch(relative,change){const file=path.join(root,relative),before=await fs.readFile(file,'utf8');const after=change(before);if(after===before)return;const saved=path.join(backup,relative);await fs.mkdir(path.dirname(saved),{recursive:true});try{await fs.writeFile(saved,before,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}await fs.writeFile(file,after);}
for(const name of ['db-context.ts','sync-db.ts','obsidian-sync.ts','obsidian-sync.test.ts'])await fs.copyFile(path.join(staging,name),path.join(root,'apps/api/src',name));
await fs.copyFile(path.join(staging,'ObsidianDevices.tsx'),path.join(root,'apps/web/src/ObsidianDevices.tsx'));
await patch('apps/api/src/db.ts',s=>s.includes('databaseContext')?s:s.replace('export const pool =','import { databaseContext } from "./db-context.js";\nconst originalPool =').replace('/** 类型安全的查询助手，返回行数组 */','export const pool = new Proxy(originalPool, { get(target, key) { const connection = databaseContext.getStore(); const owner = key === "query" && connection ? connection : target; const value = (owner as any)[key]; return typeof value === "function" ? value.bind(owner) : value; } });\n\n/** 类型安全的查询助手，返回行数组 */'));
await patch('apps/api/src/db.ts',s=>s.replace('key === "query" && connection ? connection : target','key === "query" && connection && connection !== pool ? connection : target'));
await patch('apps/api/src/vault.ts',s=>{
 if(s.includes('recordSyncChange'))return s;
 s='import { ensureSyncTables, recordSyncChange, syncTransaction } from "./sync-db.js";\n'+s;
 s=s.replace('  assertDate(date);\n  const document = diaryDocumentSchema.parse(input);','  await ensureSyncTables(); return syncTransaction(async () => {\n  assertDate(date);\n  const document = diaryDocumentSchema.parse(input);');
 s=s.replace('  const saved = await loadDiary(date, userId);','  await recordSyncChange(userId,"diary",date,version);\n  const saved = await loadDiary(date, userId);');
 s=s.replace('return { ...saved, savedAt: new Date().toISOString() };','return { ...saved, savedAt: new Date().toISOString() };\n  });');
 s=s.replace('  const json = JSON.stringify(value, null, 2);','  await ensureSyncTables(); return syncTransaction(async () => {\n  const json = JSON.stringify(value, null, 2);');
 s=s.replace('    [userId, key, json]\n  );','    [userId, key, json]\n  );\n  await recordSyncChange(userId,"setting",key,versionOf(json));\n  });');return s;
});
await patch('apps/api/src/auth.ts',s=>{
 if(s.includes('syncIdentity'))return s;s='import { syncIdentity } from "./obsidian-sync.js";\n'+s;
 return s.replace('    const token = getSessionToken(request);',`    if(url.startsWith('/api/obsidian-sync/v1/')) {\n      const token=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1]||'';\n      const userId=await syncIdentity(token);\n      if(!userId){reply.code(401).send({error:'设备授权无效或已撤销',code:'AUTH_REQUIRED'});return;}\n      request.userId=userId;return;\n    }\n    const token = getSessionToken(request);`);
});
await patch('apps/api/src/server.ts',s=>{
 if(s.includes('registerObsidianSync(app)'))return s;
 s='import { registerObsidianSync } from "./obsidian-sync.js";\nimport { ensureSyncTables } from "./sync-db.js";\n'+s;
 s=s.replace('  registerAuth(app);','  await ensureSyncTables();\n  registerAuth(app);\n  registerObsidianSync(app);');
 s=s.replace('"req.headers.authorization",','"req.headers.authorization", "req.headers.cookie",');return s;
});
await patch('apps/web/src/App.tsx',s=>s.includes('<ObsidianDevices')?s:'import {ObsidianDevices} from "./ObsidianDevices";\n'+s.replace('<div className="rail-note">','<ObsidianDevices/><div className="rail-note">'));
await patch('apps/web/src/TodoPanel.tsx',s=>s.replaceAll("void act(row,'complete',undefined,{automaticRecord:true});",'setCompleting(row);').replaceAll("else void act(r,'complete',undefined,{automaticRecord:true});",'else if(r.task.completion)onOpen(r.task.completion);else setCompleting(r);'));
await patch('apps/web/src/PlanCompletion.tsx',s=>s.includes('已使用本地规则整理')?s:s.replace('      const next = response.drafts[0];',"      if(response.mode==='rule')setError('已使用本地规则整理，可继续编辑；未调用 AI。');\n      const next = response.drafts[0];"));
await patch('apps/web/src/PlanCompletion.tsx',s=>s.replace("response.mode==='rule'","response.mode==='manual'"));
await patch('apps/api/src/planSettings.ts',s=>s.includes('requestedId?: string')?s:s.replace('addPlanCategory(input: unknown, userId: number)','addPlanCategory(input: unknown, userId: number, requestedId?: string)').replace("id:'cat-'+randomUUID(),...data","id:requestedId || 'cat-'+randomUUID(),...data"));
console.log('Diary sync upgrade applied; originals retained in integration/diary-original.');
