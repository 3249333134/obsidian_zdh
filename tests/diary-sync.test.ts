import {beforeEach,expect,it,vi} from 'vitest';
import {MemoryVault} from './obsidian';
import {DiarySync,defaultDiaryState,mergePlan,type DiaryState} from '../src/diary-sync';
import {ProjectStore} from '../src/projects';
import {defaultProjectState} from '../src/project-types';
import {emptyDiary,todoSchema,type Todo} from '../src/diary-vendor/contracts';
import {fingerprint} from '../src/sync-format';
let vault:MemoryVault,state:DiaryState,store:ProjectStore,engine:DiarySync,doc:ReturnType<typeof emptyDiary>,version=0,offline=false,ops:any[],account=1;
const token='diary_obs_'+'a'.repeat(64);
beforeEach(()=>{vault=new MemoryVault();state=defaultDiaryState();store=new ProjectStore(vault as any,defaultProjectState,async()=>{});doc=emptyDiary('2026-10-16');version=1;offline=false;ops=[];account=1;engine=new DiarySync(vault as any,store,()=>state,async()=>{},async(url,method,_token,body:any)=>{
 if(offline)throw new Error('offline');
 if(url.endsWith('/info'))return {protocol:1,account:{id:account,username:'合成账号'},timezone:'Asia/Shanghai',capabilities:['plans:write'],defaults:{categories:'system/plan-categories.json',views:'system/plan-views.json',tags:'system/shared-tags.json'}};
 const item=()=>({kind:'diary',key:doc.date,version:String(version),document:JSON.parse(JSON.stringify(doc))});
 if(url.includes('/snapshot'))return {watermark:version,items:[item()],next:null};
 if(url.includes('/changes')){const cursor=Number(new URL(url).searchParams.get('cursor'));return {cursor:version,items:cursor<version?[item()]:[],more:false};}
 if(url.endsWith('/operations')){ops.push(body);if(body.kind==='action'){
  const input=body.input,index=doc.todos.findIndex(t=>t.id===input.task.id);if(input.mode==='create'){if(index<0)doc.todos.push(todoSchema.parse(input.task));}
  else if(index>=0){if(input.mode==='update')doc.todos[index]=todoSchema.parse(input.task);else if(input.mode==='complete')doc.todos[index]=todoSchema.parse({...doc.todos[index],status:'done',done:true,completedAt:'2026-10-16T01:00:00Z'});else if(input.mode==='status')doc.todos[index]=todoSchema.parse({...doc.todos[index],status:input.nextStatus,done:input.nextStatus==='done'});}
  version++;
 }return {ok:true};}throw new Error('unknown test route');
 });
 // Polling is exercised separately; keep deterministic test calls explicit.
 vi.spyOn(engine,'start').mockImplementation(()=>{});
});
const seed=()=>{const task=todoSchema.parse({id:'remote-test-task',title:'云端计划',dueDate:'2026-10-20',startDate:'2026-10-16',startTime:'09:00',category:'work'});doc.todos=[task];return task;};
const connect=()=>engine.connect('https://diary.example/',token);
it('downloads formal Markdown, preserves stable identity and projects remain optional',async()=>{
 seed();await connect();expect(store.tasks.size).toBe(1);const task=[...store.tasks.values()][0];expect(task.projectId).toBe('');expect(task.plan?.id).toBe('remote-test-task');expect(task.sources[0]).toContain('独立日记-云端');
 expect(vault.getMarkdownFiles()).toHaveLength(2);expect(JSON.stringify(state.resources)).not.toContain('云端计划');await engine.sync();expect(vault.getMarkdownFiles()).toHaveLength(2);expect(store.tasks.size).toBe(1);expect(ops).toHaveLength(0);
});
it('keeps legacy tasks local until explicit binding and does not upload private project notes',async()=>{
 const p=await store.saveProject({title:'私有项目',goal:'PRIVATE_GOAL',category:'工作',status:'active',notes:[]});const task=await store.saveTask({title:'本地计划',projectId:p.id,category:'工作',status:'todo',priority:'normal',sources:[]});
 await connect();expect(ops).toHaveLength(0);await engine.bind(task.id);await engine.sync();expect(ops.filter(o=>o.input.mode==='create')).toHaveLength(1);expect(JSON.stringify(ops)).not.toContain('PRIVATE_GOAL');expect(JSON.stringify(ops)).not.toContain(p.path);
});
it('persists an offline edit and later uploads it once, accepting canonical server completion time',async()=>{
 seed();await connect();const row=(await engine.actions()).tasks[0];offline=true;await engine.changeAction({mode:'complete',date:row.date,version:row.version,task:row.task,operationId:crypto.randomUUID()});await engine.sync();
 expect(state.pending).toHaveLength(1);expect([...store.tasks.values()][0].status).toBe('done');expect(JSON.parse(JSON.stringify(state)).pending).toHaveLength(1);
 offline=false;await engine.sync();expect(state.pending).toHaveLength(0);expect(state.conflicts).toHaveLength(0);expect([...store.tasks.values()][0].completedAt).toBe('2026-10-16T01:00:00Z');
 await engine.sync();expect(ops).toHaveLength(1);
});
it('merges separate fields and quarantines conflicting edits without overwriting',async()=>{
 seed();await connect();let local=[...store.tasks.values()][0];await store.saveTask({...local,title:'本地改标题'});doc.todos[0].description='云端补充说明';version++;await engine.sync();
 local=[...store.tasks.values()][0];expect(local.title).toBe('本地改标题');expect(local.plan?.description).toBe('云端补充说明');expect(state.conflicts).toHaveLength(0);
 await store.saveTask({...local,title:'本地第二次修改'});doc.todos[0].title='云端另改标题';version++;await engine.sync();expect(state.conflicts).toHaveLength(1);expect([...store.tasks.values()][0].title).toBe('本地第二次修改');
 await engine.resolve(state.conflicts[0].id,'remote');await engine.sync();expect([...store.tasks.values()][0].title).toBe('云端另改标题');
});
it('preserves user notes outside mirror blocks and asks before replacing manually edited mirror text',async()=>{
 seed();await connect();const mirror=state.resources['diary:'+doc.date],path=mirror.path!;vault.contents.set(path,String(vault.contents.get(path))+'\n手工备注');doc.facts.note='网站新备注';version++;await engine.sync();expect(vault.contents.get(path)).toContain('手工备注');
 vault.contents.set(path,String(vault.contents.get(path)).replace('网站新备注','本地改正文'));doc.facts.note='再次更新';version++;await engine.sync();expect(state.conflicts.some(c=>c.kind==='document')).toBe(true);expect(vault.contents.get(path)).toContain('本地改正文');
});
it('does not advance a download cursor after a failed write, retries and rebuilds without duplicates',async()=>{
 seed();vault.failCreate=true;await connect();expect(state.cursor).toBeUndefined();expect(state.error).toContain('disk full');await engine.sync();expect(state.cursor).toBe(1);expect(store.tasks.size).toBe(1);expect(vault.getMarkdownFiles()).toHaveLength(2);
 const reopened=new ProjectStore(vault as any,defaultProjectState,async()=>{});await reopened.load();expect(reopened.tasks.size).toBe(1);
});
it('keeps paused and old-account operations from being submitted to a different account',async()=>{
 seed();await connect();offline=true;const row=(await engine.actions()).tasks[0];await engine.changeAction({mode:'update',date:row.date,task:{...row.task,title:'待提交'},operationId:crypto.randomUUID()});await engine.sync();offline=false;await engine.pause();await engine.sync();expect(ops).toHaveLength(0);
 account=2;doc=emptyDiary('2026-10-16');version++;await connect();expect(ops).toHaveLength(0);expect(state.pending).toHaveLength(1);
});
it('projects repeats without materializing future notes and changes due time without altering original start',async()=>{
 const root=todoSchema.parse({id:'local-repeat-id',title:'重复计划',dueDate:'2026-10-16',dueTime:'10:00',startDate:'2026-10-16',startTime:'09:00',repeat:{type:'daily'}});
 await engine.changeAction({mode:'create',date:doc.date,task:root,operationId:crypto.randomUUID()});const rows=await engine.schedule('2026-10-16','2026-10-18');expect(rows.tasks).toHaveLength(3);expect(store.tasks.size).toBe(1);
 const task=rows.tasks[0];await engine.changeAction({mode:'update',date:task.date,task:{...task.task,dueDate:'2026-10-17',dueTime:'11:00'},operationId:crypto.randomUUID()});const saved=[...store.tasks.values()][0];expect(saved.plan).toMatchObject({dueDate:'2026-10-17',dueTime:'11:00',startTime:'09:00'});
});
it('rejects unexposed bridge methods and keeps credentials out of sync errors',async()=>{
 await expect(engine.api('saveDiary',['../notes',{}])).rejects.toThrow('未开放');
 expect(mergePlan(todoSchema.parse({id:'x',title:'a'}),todoSchema.parse({id:'x',title:'b'}),todoSchema.parse({id:'x',title:'c'})).conflicts).toEqual(['title']);
});
it('appends two local completion records safely, retries once and preserves personal notes on restore',async()=>{
 for(const id of ['first-plan','second-plan'])await engine.changeAction({mode:'create',date:doc.date,task:todoSchema.parse({id,title:id}),operationId:crypto.randomUUID()});
 let rows=(await engine.actions()).tasks;const id=crypto.randomUUID(),complete={mode:'complete',date:doc.date,task:rows[0].task,operationId:id,completionRecord:{id,date:doc.date,kind:'facts',content:'完成第一项',time:'10:00'}};
 await engine.changeAction(complete);await engine.changeAction(complete);rows=(await engine.actions()).tasks;const second=rows.find(r=>r.task.id==='second-plan'),op=crypto.randomUUID();await engine.changeAction({mode:'complete',date:doc.date,task:second.task,operationId:op,completionRecord:{id:op,date:doc.date,kind:'facts',content:'完成第二项',time:'11:00'}});
 const path='00_INPUT-输入池/每日记录/独立日记-本地/'+doc.date+'.md';vault.contents.set(path,String(vault.contents.get(path))+'\n个人正文保留');expect((await engine.actions()).records).toHaveLength(2);const row=(await engine.actions()).tasks.find(r=>r.task.id==='first-plan');expect(row.completionExists).toBe(true);
 await engine.changeAction({mode:'restore',date:row.date,task:row.task,operationId:crypto.randomUUID()});expect((await engine.actions()).records).toHaveLength(1);expect(vault.contents.get(path)).toContain('个人正文保留');
});
it('rejects stale editor versions without changing a newer local plan',async()=>{
 seed();await connect();const row=(await engine.actions()).tasks[0],local=[...store.tasks.values()][0];await store.saveTask({...local,title:'另一个编辑器的新标题'});await expect(engine.changeAction({mode:'update',date:row.date,version:row.version,task:{...row.task,title:'旧表单'},operationId:crypto.randomUUID()})).rejects.toThrow('已被修改');expect([...store.tasks.values()][0].title).toBe('另一个编辑器的新标题');
});
it('preserves completed repeat history when a future rule is changed or stopped',async()=>{
 const root=todoSchema.parse({id:'series-history-test',title:'原系列',dueDate:'2026-10-16',repeat:{type:'daily'}});await engine.changeAction({mode:'create',date:doc.date,task:root,operationId:crypto.randomUUID()});
 const occurrence=(await engine.schedule('2026-10-17','2026-10-17')).tasks[0];await engine.changeAction({mode:'complete',date:occurrence.date,task:occurrence.task,operationId:crypto.randomUUID()});
 await engine.updateSeries({date:doc.date,from:'2026-10-17',task:{...occurrence.task,title:'新的每周计划',dueDate:'2026-10-17',repeat:{type:'weekly'}},stop:false});
 let scheduled=await engine.schedule('2026-10-16','2026-10-25');expect(scheduled.tasks.find(r=>r.task.dueDate==='2026-10-17')?.task.done).toBe(true);expect(scheduled.tasks.find(r=>r.task.dueDate==='2026-10-24')?.task.title).toBe('新的每周计划');expect(store.tasks.size).toBe(2);
 await engine.updateSeries({date:doc.date,from:'2026-10-17',task:root,stop:true});scheduled=await engine.schedule('2026-10-16','2026-10-25');expect(scheduled.tasks.filter(r=>r.task.dueDate==='2026-10-17')).toHaveLength(1);expect(scheduled.tasks.some(r=>r.task.dueDate==='2026-10-24')).toBe(false);
});
it('requires re-preview when a legacy plan changes before binding',async()=>{
 const task=await store.saveTask({title:'待绑定',projectId:'',category:'工作',status:'todo',priority:'normal',sources:[]});await connect();const preview=engine.uploadPreview(task);await store.saveTask({...task,title:'预览后修改'});await expect(engine.bind(task.id,preview)).rejects.toThrow('重新预览');expect(ops).toHaveLength(0);
});
it('recovers a local completion interrupted after its diary write without duplicating the record',async()=>{
 const task=todoSchema.parse({id:'interrupted-local',title:'中断恢复'});await engine.changeAction({mode:'create',date:doc.date,task,operationId:crypto.randomUUID()});const row=(await engine.actions()).tasks[0],id=crypto.randomUUID();vi.spyOn(store,'saveTask').mockRejectedValueOnce(new Error('synthetic interruption'));
 await expect(engine.changeAction({mode:'complete',date:row.date,version:row.version,task:row.task,operationId:id,completionRecord:{id,date:row.date,kind:'facts',time:'09:00',content:'只写一次'}})).rejects.toThrow('synthetic interruption');expect(state.completionIntents).toHaveLength(1);expect((await engine.actions()).records).toHaveLength(1);
 await engine.recoverCompletions(id);expect(state.completionIntents).toHaveLength(0);expect((await engine.actions()).records).toHaveLength(1);expect([...store.tasks.values()][0].status).toBe('done');
});
it('retains conflicting view settings and submits the chosen local version only after explicit comparison',async()=>{
 await connect();const remote=[{id:crypto.randomUUID(),name:'网站视图',color:'#123456',tags:['远端']}],local=[{id:crypto.randomUUID(),name:'本地视图',color:'#654321',tags:['本地']}],request=(engine as any).request;let conflict=true;
 (engine as any).request=async(...args:any[])=>{if(args[1]==='POST'&&args[3].kind==='views'&&conflict)throw Object.assign(new Error('settings conflict'),{status:409,current:remote});return request(...args);};
 await engine.api('savePlanViews',[local]);await engine.sync();expect(state.pending[0].conflict).toBe(true);expect(state.views).toEqual(local);conflict=false;await engine.resolveMetadata(state.pending[0].id,'local');await engine.sync();expect(state.pending).toHaveLength(0);expect(ops.at(-1).baseValue).toEqual(remote);
});
it('creates from only a title locally without inventing a deadline and reuses the same identity on retry',async()=>{
 const id=crypto.randomUUID();await engine.quickCreatePlan({id,title:'只填标题'});await engine.quickCreatePlan({id,title:'只填标题'});expect(store.tasks.size).toBe(1);const row=(await engine.actions()).tasks[0];expect(row.task.dueDate).toBe('');expect(row.sync.label).toBe('仅本地');expect(ops).toHaveLength(0);
 await expect(engine.quickCreatePlan({id:crypto.randomUUID(),title:'先检查项目',projectId:'missing-project'})).rejects.toThrow('项目已不存在');expect(store.tasks.size).toBe(1);
});
it('automatically uploads a cloud quick plan and subsequently syncs deadline changes and one-click completion',async()=>{
 expect((await engine.plannerContext()).connected).toBe(false);await connect();const context=await engine.plannerContext();expect(context).toMatchObject({connected:true,defaultCloud:true});const id=crypto.randomUUID();await engine.quickCreatePlan({id,title:'快速同步',dueDate:'2026-10-20',dueTime:'10:00',cloud:context.connected&&context.defaultCloud});await engine.sync();expect(doc.todos).toHaveLength(1);expect(doc.todos[0].id).toBe(id);expect(state.pending).toHaveLength(0);let row=(await engine.actions()).tasks[0];expect(row.sync.label).toBe('已同步网站');
 await engine.changeAction({mode:'update',date:row.date,version:row.version,task:{...row.task,dueDate:'2026-10-21',dueTime:'14:30'},operationId:crypto.randomUUID()});await engine.sync();expect(doc.todos[0].dueDate).toBe('2026-10-21');row=(await engine.actions()).tasks[0];await engine.changeAction({mode:'complete',date:row.date,version:row.version,task:row.task,operationId:crypto.randomUUID()});await engine.sync();expect(doc.todos[0].done).toBe(true);expect(doc.facts.events).toHaveLength(0);
});
it('assigns projects from the plan drawer without uploading project details and persists the chosen view',async()=>{
 await connect();const project=await store.saveProject({title:'本地项目',goal:'PRIVATE_PROJECT',category:'工作',status:'active'}),id=crypto.randomUUID();await engine.quickCreatePlan({id,title:'项目任务',cloud:true});await engine.sync();const context=await engine.plannerContext(id);await engine.assignPlanProject(id,project.id,context.hash);await engine.sync();expect((await engine.plannerContext(id)).projectId).toBe(project.id);expect(JSON.stringify(ops)).not.toContain('PRIVATE_PROJECT');expect(JSON.stringify(ops)).not.toContain(project.path);
 await engine.api('savePlannerPreferences',[{layout:'week',defaultCloud:true}]);expect(state.preferences).toEqual({layout:'week',defaultCloud:true});await expect(engine.api('savePlannerPreferences',[{layout:'unknown'}])).rejects.toThrow('视图无效');
});
