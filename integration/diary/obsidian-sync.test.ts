import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
vi.mock('./db.js',async()=>{const {createDemoPool}=await import('./demoDatabase.js');const pool=createDemoPool(':memory:');return {pool,queryRows:async(sql:string,params:unknown[]=[])=> (await pool.query(sql,params))[0]};});
import {pool} from './db.js';
import {buildServer} from './server.js';
import {createSession} from './auth.js';
import {saveDiary,loadDiary,writeJson} from './vault.js';
import {emptyDiary,todoSchema} from '@diary/contracts';
import {vaultPaths} from './config.js';
let app:Awaited<ReturnType<typeof buildServer>>,cookie:string,token:string;
beforeAll(async()=>{app=await buildServer();cookie='session='+await createSession(1);const result=await app.inject({method:'POST',url:'/api/obsidian-devices',headers:{cookie},payload:{name:'测试设备'}});expect(result.statusCode).toBe(200);token=result.json().token;});
afterAll(async()=>{await app.close();await pool.end();});
const call=(path:string,body?:any)=>app.inject({method:body?'POST':'GET',url:'/api/obsidian-sync/v1/'+path,headers:{authorization:'Bearer '+token},...(body?{payload:body}:{})});
it('requires device tokens, scopes resources to their account and revokes devices',async()=>{
 expect((await app.inject({url:'/api/obsidian-sync/v1/info',headers:{cookie}})).statusCode).toBe(401);
 expect((await call('info')).json().account.id).toBe(1);
 await pool.query('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)',[2,'other','disabled']);
 const other=emptyDiary('2026-10-01');other.facts.note='PRIVATE_OTHER';await saveDiary(other.date,other,'0',2);
 await writeJson('credentials',{secret:'NOT_SYNCED'},1);
 const snapshot=(await call('snapshot')).json();expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_OTHER');expect(JSON.stringify(snapshot)).not.toContain('NOT_SYNCED');
 const device=(await app.inject({method:'POST',url:'/api/obsidian-devices',headers:{cookie},payload:{name:'撤销测试'}})).json();
 await app.inject({method:'DELETE',url:'/api/obsidian-devices/'+device.id,headers:{cookie}});
 expect((await app.inject({url:'/api/obsidian-sync/v1/info',headers:{authorization:'Bearer '+device.token}})).statusCode).toBe(401);
});
it('journals website diary and review writes, pages deltas, and rolls back failed journaling',async()=>{
 const doc=emptyDiary('2026-10-11');await saveDiary(doc.date,doc,'0',1);await writeJson('weekly-summary:2026-W41',{content:'合成复盘'},1);
 const changes=(await call('changes?cursor=0&limit=1')).json();expect(changes.items).toHaveLength(1);expect(changes.more).toBe(true);const next=(await call('changes?cursor='+changes.cursor)).json();expect(next.items.some((r:any)=>r.key==='weekly-summary:2026-W41')).toBe(true);
 const original=pool.query.bind(pool),spy=vi.spyOn(pool,'query').mockImplementation(async(sql:any,args:any)=>{if(String(sql).startsWith('INSERT INTO obsidian_changes')&&args[2]==='2026-10-13')throw new Error('journal failure');return original(sql,args) as any;});
 await expect(saveDiary('2026-10-13',emptyDiary('2026-10-13'),'0',1)).rejects.toThrow('journal failure');spy.mockRestore();expect((await loadDiary('2026-10-13',1)).exists).toBe(false);
});
it('replays operations once, merges distinct edits and rejects overlapping field edits',async()=>{
 const task=todoSchema.parse({id:randomUUID(),title:'样例计划',dueDate:'2026-10-20'}),operationId=randomUUID();
 const input={mode:'create',date:'2026-10-12',version:'0',task,operationId};expect((await call('operations',{operationId,kind:'action',input})).statusCode).toBe(200);await call('operations',{operationId,kind:'action',input});expect((await loadDiary(input.date,1)).document.todos).toHaveLength(1);
 let diary=await loadDiary(input.date,1);diary.document.todos[0].description='网站增加说明';await saveDiary(input.date,diary.document,diary.version,1);
 let id=randomUUID(),result=await call('operations',{operationId:id,kind:'action',base:task,input:{...input,mode:'update',operationId:id,task:{...task,title:'本地改标题'}}});expect(result.statusCode).toBe(200);
 diary=await loadDiary(input.date,1);expect(diary.document.todos[0]).toMatchObject({title:'本地改标题',description:'网站增加说明'});
 id=randomUUID();result=await call('operations',{operationId:id,kind:'action',base:task,input:{...input,mode:'update',operationId:id,task:{...task,title:'冲突标题'}}});expect(result.statusCode).toBe(409);
 expect((await loadDiary(input.date,1)).document.todos[0].title).toBe('本地改标题');
});
it('paginates mixed settings with the same ordering as its snapshot cursor',async()=>{
 await writeJson(vaultPaths.system+'/plan-views.json',[],1);await writeJson(vaultPaths.system+'/shared-tags.json',['验收'],1);await writeJson('weekly-material:2026-W40',{value:'material'},1);
 let after:string|undefined,watermark:number|undefined;const ids:string[]=[];for(let i=0;i<30;i++){const page=(await call('snapshot?limit=1'+(after?'&after='+encodeURIComponent(after):'')+(watermark!==undefined?'&watermark='+watermark:''))).json();watermark=page.watermark;ids.push(...page.items.map((r:any)=>r.kind+':'+r.key));after=page.next;if(!after)break;}
 const all=(await call('snapshot?limit=100')).json().items.map((r:any)=>r.kind+':'+r.key);expect(ids).toEqual(all);expect(new Set(ids).size).toBe(ids.length);
});
it('syncs virtual repeats and confirmed completion records idempotently, without granting arbitrary diary writes',async()=>{
 const task=todoSchema.parse({id:randomUUID(),title:'重复验收',dueDate:'2026-10-16',repeat:{type:'daily'}}),date='2026-10-15',operationId=randomUUID();await call('operations',{operationId,kind:'action',input:{mode:'create',date,version:'0',task,operationId}});
 const {deriveOccurrence}=await import('./recurrence.js'),root=(await loadDiary(date,1)).document.todos[0],occurrence=deriveOccurrence(root,'2026-10-17')!,id=randomUUID();const body={operationId:id,kind:'action',base:occurrence,input:{mode:'complete',date,version:'0',task:occurrence,operationId:id,completionRecord:{id,date:'2026-10-17',kind:'facts',version:'0',content:'确认的合成完成记录',time:'09:00'}}};
 expect((await call('operations',body)).statusCode).toBe(200);expect((await call('operations',body)).statusCode).toBe(200);expect((await loadDiary('2026-10-17',1)).document.facts.events.filter(e=>e.id===id)).toHaveLength(1);expect((await loadDiary(date,1)).document.todos.find(t=>t.id===occurrence.id)?.done).toBe(true);
 expect((await call('operations',{operationId:randomUUID(),kind:'diary',input:{date:'2026-10-01',content:'not allowed'}})).statusCode).toBeGreaterThanOrEqual(400);
 expect((await app.inject({method:'PUT',url:'/api/diaries/2026-10-01',headers:{authorization:'Bearer '+token},payload:{}})).statusCode).toBe(401);
});
