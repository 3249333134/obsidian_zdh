import { TFile, requestUrl, parseYaml, stringifyYaml, type Vault } from 'obsidian';
import { ProjectStore, noteLink } from './projects';
import { fingerprint, redact } from './sync-format';
import { ensureFolder, uniquePath } from './storage';
import { safeName } from './core';
import { localDay } from './project-types';
import type { ProjectTask } from './project-types';
import { todoSchema, emptyDiary, captureDraftSchema, appendCapture, resolveRecord, defaultPlanCategories, diaryDocumentSchema, planCategorySchema, planViewsSchema, type Todo, type DiaryDocument } from './diary-vendor/contracts';
import { serializeDiaryMarkdown, parseDiaryMarkdown } from './diary-vendor/markdown';
import { deriveOccurrence, isSeries, firstOccurrence } from './diary-vendor/recurrence';
import { addDays } from './diary-vendor/date';

export const DIARY_VIEW='knowledge-flow-diary-plans';
const API='/api/obsidian-sync/v1',START='<!-- knowledge-flow:diary:start -->',END='<!-- knowledge-flow:diary:end -->';
export interface DiaryConnection {url:string;token:string;account:string;accountId:number;username:string;enabled:boolean;timezone:string;keys:{categories:string;views:string;tags:string}}
interface RemoteBase {date:string;task:Todo;localId:string;account:string;path?:string}
interface Resource {version:string;path?:string;hash?:string}
interface Pending {id:string;account:string;localId?:string;kind:string;input:any;base?:Todo;baseValue?:unknown;error?:string;conflict?:boolean;remote?:unknown}
export interface DiaryConflict {id:string;kind:'plan'|'document';localId?:string;path?:string;remote:any;message:string;account:string;resource?:string}
export interface DiaryState {
 connection?:DiaryConnection;cursor?:number;snapshot?:{after?:string;watermark?:number};resources:Record<string,Resource>;bases:Record<string,RemoteBase>;pending:Pending[];conflicts:DiaryConflict[];
 categories:Array<{id:string;name:string;color:string;order:number}>;views:any[];tags:string[];lastSuccess?:string;error?:string;
 completionIntents?:Array<{id:string;input:any;account?:string;error?:string}>;
 preferences?:{layout?:string;defaultCloud?:boolean};
}
export const defaultDiaryState=():DiaryState=>({resources:{},bases:{},pending:[],conflicts:[],categories:[...defaultPlanCategories],views:[],tags:[]});
const stable=(v:any):string=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined&&v[k]!=='').sort().map(k=>[k,JSON.parse(stable(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):v??null);
const equal=(a:any,b:any)=>stable(a)===stable(b);
const fields=['title','time','plannedDate','description','subtasks','priority','dueDate','dueTime','list','tags','repeat','attachments','entities','category','important','urgent','startDate','startTime','done','status','completedAt','completion','deletedAt','seriesChanges','seriesTemplate','occurrenceSuppressed'] as const;
export function mergePlan(base:Todo,local:Todo,remote:Todo):{task:Todo;conflicts:string[]} {
 const task={...remote},conflicts:string[]=[];
 for(const k of fields)if(!equal(base[k],local[k])){if(!equal(remote[k],base[k])&&!equal(remote[k],local[k]))conflicts.push(k);else(task as any)[k]=local[k];}
 return {task:todoSchema.parse(task),conflicts};
}
export type DiaryRequest=(url:string,method:string,token:string,body?:unknown)=>Promise<any>;
export const diaryRequest:DiaryRequest=async(url,method,token,body)=>{
 const response=await requestUrl({url,method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),throw:false});
 let data:any;try{data=response.json;}catch{data={};}
 if(response.status<200||response.status>=300)throw Object.assign(new Error(response.status===401?'设备授权失效，请在网站重新生成并连接。':response.status===404?'网站尚未提供同步接口，请先更新网站。':response.status===409?'内容在两端发生变化，请核对冲突。':`同步请求失败（${response.status}），请稍后重试。`),{status:response.status,current:data.current});
 return data;
};
export class DiarySync {
 private running?:Promise<void>;private timer?:ReturnType<typeof setInterval>;private uploadTimer?:ReturnType<typeof setTimeout>;private stopped=false;private applying=false;private writeQueue=Promise.resolve();
 onChange:()=>void=()=>{};
 constructor(readonly vault:Vault,readonly store:ProjectStore,readonly state:()=>DiaryState,private persist:()=>Promise<void>,private request:DiaryRequest=diaryRequest,private secrets:()=>string[]=()=>[]){}
 private async changed(){await this.persist();this.onChange();}
 private message(e:unknown){return redact(e instanceof Error?e.message:'同步失败',this.state().connection?.token||'');}
 private async call(path:string,method='GET',body?:unknown){const c=this.state().connection;if(!c)throw new Error('请先连接独立日记。');const result=await this.request(c.url+API+path,method,c.token,body);if(this.stopped||this.state().connection?.account!==c.account)throw new Error('连接已更换，已忽略迟到响应。');return result;}
 async connect(url:string,token:string){
  const parsed=new URL(url.trim());if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['127.0.0.1','localhost'].includes(parsed.hostname)))throw new Error('请使用 HTTPS 网站地址。');
  if(parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')throw new Error('请填写网站根地址，不包含密码、路径或查询参数。');
  url=parsed.origin;token=token.trim();if(!/^diary_obs_[a-f0-9]{64}$/.test(token))throw new Error('请填写网站生成的 Obsidian 设备授权令牌。');
  const info=await this.request(url+API+'/info','GET',token);if(info.protocol!==1||!Number.isInteger(info.account?.id)||!info.capabilities?.includes('plans:write'))throw new Error('网站同步版本不兼容。');
  const state=this.state(),account=fingerprint(url+'|'+info.account.id).slice(0,16);
  if(state.connection?.account!==account){state.cursor=undefined;state.snapshot={};state.resources={};state.categories=[...defaultPlanCategories];state.views=[];state.tags=[];}
  state.connection={url,token,account,accountId:info.account.id,username:String(info.account.username),timezone:info.timezone||'Asia/Shanghai',enabled:true,keys:info.defaults};state.error=undefined;await this.changed();this.start();await this.sync();
 }
 start(){if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>void this.sync(),30000);void this.recoverCompletions().then(()=>this.sync());}
 stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.uploadTimer)clearTimeout(this.uploadTimer);this.timer=undefined;}
 notifyChange(){if(this.applying||this.stopped||!this.state().connection?.enabled)return;if(this.uploadTimer)clearTimeout(this.uploadTimer);this.uploadTimer=setTimeout(()=>void this.sync(),2000);}
 async renamed(oldPath:string,newPath:string){for(const r of Object.values(this.state().resources))if(r.path===oldPath)r.path=newPath;await this.changed();}
 async pause(paused=true){const c=this.state().connection;if(c)c.enabled=!paused;await this.changed();if(!paused)void this.sync();}
 async disconnect(){this.state().connection=undefined;this.state().error=undefined;await this.changed();}
 async recoverCompletions(id?:string){for(const item of [...(this.state().completionIntents||[])]){if(item.account&&item.account!==this.state().connection?.account||item.error&&!id||id&&item.id!==id)continue;try{await this.changeAction(item.input,true);}catch{/* Retained with a concrete retry error. */}}}
 async dismissCompletion(id:string){this.state().completionIntents=(this.state().completionIntents||[]).filter(x=>x.id!==id);await this.changed();}
 async sync(){if(this.running)return this.running;if(this.stopped||!this.state().connection?.enabled)return;
  this.running=(async()=>{try{await this.pull();await this.discover();await this.push();await this.pull();this.state().lastSuccess=new Date().toISOString();this.state().error=undefined;}catch(e){this.state().error=this.message(e);if((e as any).status===401&&this.state().connection)this.state().connection!.enabled=false;}finally{await this.changed();}})().finally(()=>{this.running=undefined;});return this.running;
 }
 private async pull(){
  const s=this.state();
  if(s.cursor===undefined){s.snapshot||={};let more=true;while(more){const snapshot=s.snapshot||{};const page=await this.call('/snapshot?'+new URLSearchParams({...snapshot.after?{after:snapshot.after}:{},...snapshot.watermark!==undefined?{watermark:String(snapshot.watermark)}:{}}));
   if(!Array.isArray(page.items)||!Number.isSafeInteger(page.watermark))throw new Error('网站同步响应无效。');
   for(const item of page.items)await this.applyResource(item);s.snapshot={after:page.next||undefined,watermark:page.watermark};more=!!page.next;if(!more){s.cursor=page.watermark;s.snapshot=undefined;}await this.changed();}
  }
  let more=true;while(more){const page=await this.call('/changes?cursor='+s.cursor);if(!Array.isArray(page.items)||!Number.isSafeInteger(page.cursor)||page.cursor<s.cursor!)throw new Error('网站增量游标无效。');for(const item of page.items)await this.applyResource(item);if(page.more&&page.cursor===s.cursor)throw new Error('网站增量没有前进，请重试。');s.cursor=page.cursor;more=!!page.more;await this.changed();}
 }
 private notePath(date:string){const account=this.state().connection?.account||'local';return `00_INPUT-输入池/每日记录/独立日记-云端/${account}/${date}.md`;}
 private async applyResource(item:any){
  if(!['diary','setting'].includes(item.kind)||typeof item.key!=='string'||typeof item.version!=='string')throw new Error('同步材料格式无效。');
  const key=item.kind+':'+item.key,s=this.state();if(s.resources[key]?.version===item.version)return;
  this.applying=true;try{
   if(item.kind==='diary'){
    if(item.deleted){if(s.resources[key]?.path)await this.deletedDocument(key);return;}
    const doc=diaryDocumentSchema.parse(item.document),path=this.notePath(doc.date);
    await this.writeDocument(key,path,serializeDiaryMarkdown(this.remoteAttachments(doc)).replace(/!\[\[(https?:\/\/[^\]]+)\]\]/g,'[远端附件]($1)'),item.version);
    const currentIds=new Set(doc.todos.map(t=>t.id));
    for(const task of doc.todos)await this.receivePlan(doc.date,task);
    for(const base of Object.values(s.bases).filter(b=>b.account===s.connection?.account&&b.date===doc.date&&!currentIds.has(b.task.id)&&!s.pending.some(p=>p.account===b.account&&p.localId===b.localId&&p.input?.mode==='create')))await this.receivePlan(doc.date,{...base.task,deletedAt:base.task.deletedAt||new Date().toISOString()});
   }else{
    const c=s.connection!;
    if(item.key===c.keys.categories){s.categories=item.deleted?[...defaultPlanCategories]:Array.isArray(item.value)?item.value.map((v:any)=>planCategorySchema.parse(v)):[];s.categories=[...defaultPlanCategories,...s.categories.filter(v=>!defaultPlanCategories.some(d=>d.id===v.id))];}
    else if(item.key===c.keys.views)s.views=item.deleted?[]:planViewsSchema.parse(item.value);
    else if(item.key===c.keys.tags)s.tags=item.deleted?[]:Array.isArray(item.value)?item.value.filter((v:unknown)=>typeof v==='string'):[];
    else if(/^weekly-summary:\d{4}-W\d{2}$/.test(item.key)){
     const path=`01_UNDERSTAND-理解层/周复盘/独立日记-云端/${c.account}/${item.key.split(':')[1]}.md`;
     if(item.deleted)await this.deletedDocument(key);else if(typeof item.value?.content==='string')await this.writeDocument(key,path,item.value.content.replace(/\[\[00_INPUT-输入池\/每日记录\/(\d{4}-\d{2}-\d{2})(?:\.md)?\]\]/g,(_m:string,date:string)=>noteLink(this.notePath(date))),item.version);
    }
   }
   s.resources[key]={...s.resources[key],version:item.version};await this.changed();
  }finally{this.applying=false;}
 }
 private remoteAttachments(doc:DiaryDocument):DiaryDocument {
  const origin=this.state().connection!.url;const data=JSON.parse(JSON.stringify(doc));
  const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(Array.isArray(v.attachments))for(const a of v.attachments){if(typeof a.path==='string'&&!/^https?:\/\//.test(a.path))a.path=new URL('/'+a.path.replace(/^\//,''),origin).href;}for(const x of Object.values(v))visit(x);};visit(data);return data;
 }
 private async deletedDocument(key:string){const r=this.state().resources[key];if(!r?.path)return;const file=this.vault.getAbstractFileByPath(r.path);if(file instanceof TFile){const raw=await this.vault.read(file);await this.writeDocument(key,r.path,`> 云端来源已删除。本地保留以下记录，未永久删除。\n\n${this.managed(raw)||raw}`,'deleted');}}
 private managed(raw:string){const start=raw.indexOf(START),end=raw.indexOf(END);return start>=0&&end>start?raw.slice(start+START.length,end).trim():undefined;}
 private async writeDocument(key:string,path:string,content:string,version:string,force=false){
  if(content.includes(START)||content.includes(END))throw new Error('云端材料含保留区块标记，已隔离。');
  const s=this.state(),prior=s.resources[key],file=this.vault.getAbstractFileByPath(prior?.path||path);
  if(file instanceof TFile){const raw=await this.vault.read(file),managed=this.managed(raw);if(!force&&(!prior?.hash||managed===undefined||fingerprint(managed)!==prior.hash)){
   if(!s.conflicts.some(c=>c.resource===key&&c.account===s.connection?.account))s.conflicts.push({id:crypto.randomUUID(),kind:'document',path:file.path,resource:key,remote:{content,version},message:'本地同步正文已被修改，请核对云端更新。',account:s.connection!.account});await this.changed();return;
  }
  await this.vault.process(file,current=>{if(current!==raw)throw new Error('笔记刚刚发生变化，未覆盖。');const a=current.indexOf(START),b=current.indexOf(END);return current.slice(0,a)+START+'\n'+content.trim()+'\n'+current.slice(b);});
  }else{
   if(prior?.path)throw new Error('同步笔记已在本地删除，请恢复或通过冲突处理重新接收。');
   await ensureFolder(this.vault,path.slice(0,path.lastIndexOf('/')));if(this.vault.getAbstractFileByPath(path))throw new Error('同步路径已被占用，未覆盖。');
   await this.vault.create(path,`---\nkf_kind: diary-mirror\nkf_diary_source: ${s.connection!.account}\n---\n\n${START}\n${content.trim()}\n${END}\n\n## 我的记录\n`);
  }
  s.resources[key]={version,path:file instanceof TFile?file.path:path,hash:fingerprint(content.trim())};
 }
 private async receivePlan(date:string,remote:Todo){
  const s=this.state(),c=s.connection!,key=c.account+'|'+date+'|'+remote.id,base=s.bases[key];await this.store.load();
  const local=base?this.store.tasks.get(base.localId):undefined;
  if(base&&!local){if(!s.conflicts.some(x=>x.localId===base.localId&&x.account===c.account))s.conflicts.push({id:crypto.randomUUID(),kind:'plan',localId:base.localId,path:base.path,remote,message:'本地计划被删除、属性无效或标识重复，请恢复原文件后处理；其他计划继续同步。',account:c.account});for(const pending of s.pending.filter(p=>p.localId===base.localId&&p.account===c.account))pending.conflict=true;await this.changed();return;}
  let next=remote;
  if(local&&base){const result=mergePlan(base.task,this.toTodo(local),remote);if(result.conflicts.length){
   const conflict=s.conflicts.find(x=>x.localId===local.id&&x.account===c.account);if(conflict){conflict.remote=remote;conflict.message='冲突字段：'+result.conflicts.join('、');}else s.conflicts.push({id:crypto.randomUUID(),kind:'plan',localId:local.id,remote,message:'冲突字段：'+result.conflicts.join('、'),account:c.account});
   for(const pending of s.pending.filter(p=>p.localId===local.id&&p.account===c.account))pending.conflict=true;await this.changed();return;
  }next=result.task;}
  const localId=local?.id||'diary-'+fingerprint(key).slice(0,32),saved=await this.savePlan(date,next,localId,local?.projectId||'',true);
  s.bases[key]={date,task:remote,localId,account:c.account,path:saved.path};await this.changed();
 }
 toTodo(task:ProjectTask):Todo {
  return todoSchema.parse({...task.plan,id:task.plan?.id||task.id,title:task.title,status:task.status==='canceled'?'cancelled':task.status,done:task.status==='done',priority:({normal:'medium',high:'high',low:'low'}[task.priority]),startDate:task.plannedDate||'',startTime:task.startTime||'',dueDate:task.dueDate||'',category:this.state().categories.find(c=>c.name===task.category)?.id||task.plan?.category||null,completedAt:task.completedAt});
 }
 private base(localId:string){return Object.values(this.state().bases).find(b=>b.localId===localId&&b.account===this.state().connection?.account);}
 private resolveLocal(id?:string){return id?this.store.tasks.get(id)||[...this.store.tasks.values()].find(t=>t.plan?.id===id):undefined;}
 syncStatus(localId:string){const s=this.state(),base=this.base(localId),other=Object.values(s.bases).some(b=>b.localId===localId),pending=s.pending.filter(p=>p.localId===localId&&p.account===s.connection?.account);return {bound:!!base,label:!base?(other?'其他账号的计划':'仅本地'):s.conflicts.some(c=>c.localId===localId&&c.account===s.connection?.account)||pending.some(p=>p.error)?'同步待处理':!s.connection?.enabled?'同步已暂停':pending.length?'正在同步':'已同步网站'};}
 async plannerContext(id?:string){await this.store.load();const local=this.resolveLocal(id),status=local?this.syncStatus(local.id):undefined;return {localId:local?.id,hash:local?.hash,projectId:local?.projectId||'',projects:[...this.store.projects.values()].map(p=>({id:p.id,title:p.title})),connected:!!this.state().connection?.enabled,bound:status?.bound||false,syncLabel:status?.label||'仅本地',defaultCloud:this.state().preferences?.defaultCloud??true};}
 async assignPlanProject(id:string,projectId:string,hash?:string){await this.store.load();const local=this.resolveLocal(id);if(!local)throw new Error('计划不存在，请刷新。');if(hash&&hash!==local.hash)throw new Error('计划刚刚变化，请重新打开详情再关联项目。');await this.store.saveTask({...local,hash:hash||local.hash,projectId});await this.changed();return this.plannerContext(local.id);}
 async quickCreatePlan(input:{id:string;title:string;dueDate?:string;dueTime?:string;projectId?:string;category?:string|null;tags?:string[];cloud?:boolean}){
  if(input.cloud&&!this.state().connection?.enabled)throw new Error('请先连接并启用网站同步，或取消同步选择。');
  const plan=todoSchema.parse({id:input.id,title:input.title,dueDate:input.dueDate||'',dueTime:input.dueTime||'',category:input.category||null,tags:input.tags||[],createdAt:new Date().toISOString()});await this.store.load();const existing=this.store.tasks.get(plan.id);
  if(input.projectId&&!this.store.projects.has(input.projectId))throw new Error('所选项目已不存在，请重新选择。');
  if(existing){const prior=this.toTodo(existing);if(prior.title!==plan.title||prior.dueDate!==plan.dueDate||prior.dueTime!==plan.dueTime)throw new Error('此创建操作已经保存，请打开现有计划修改，未重复创建。');}
  else {const date=localDay();await this.changeAction({mode:'create',date,version:'',task:plan,operationId:crypto.randomUUID()});if(input.projectId)await this.assignPlanProject(plan.id,input.projectId);}
  if(input.cloud)await this.bind(plan.id);await this.changed();return {localId:plan.id};
 }
 private async savePlan(date:string,plan:Todo,localId?:string,projectId?:string,cloud=false){
  await this.store.load();const old=localId?this.store.tasks.get(localId):undefined;
  const category=this.state().categories.find(c=>c.id===plan.category)?.name||'待分类';
  const references=await Promise.all([plan.source,plan.completion].filter(Boolean).map(ref=>this.pathForReference(ref!,cloud||!!(localId&&this.base(localId)))));
  return this.store.saveTask({...old,id:localId||plan.id,plan,planDate:date,title:plan.title,projectId:projectId??old?.projectId??'',category,status:plan.status==='cancelled'?'canceled':plan.done?'done':plan.status,priority:plan.priority==='high'?'high':plan.priority==='low'?'low':'normal',plannedDate:plan.startDate||undefined,startTime:plan.startDate?plan.startTime||undefined:undefined,dueDate:plan.dueDate||undefined,completedAt:plan.completedAt,sources:[...new Set([...(old?.sources||[]),...references,...(cloud||localId&&this.base(localId)?[this.notePath(date)]:[])])]});
 }
 private cleanUpload(value:any):any {if(typeof value==='string'){let text=redact(value,this.state().connection?.token||'');for(const key of this.secrets())if(key)text=redact(text,key);return text.replace(/\b[A-Za-z]:[\\/][^\s<>"|]+/g,'[本地路径已省略]').replace(/\[\[[^\]]+\]\]/g,'[本地知识链接已省略]').replace(/\/(?:home|Users|mnt)\/[^\s<>"|]+/g,'[本地路径已省略]');}if(Array.isArray(value))return value.map(v=>this.cleanUpload(v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.cleanUpload(v)]));return value;}
 uploadPreview(local:ProjectTask){const task=this.toTodo(local);delete task.source;delete task.completion;delete task.operationId;return todoSchema.parse(this.cleanUpload(task));}
 private async enqueue(pending:Omit<Pending,'id'|'account'>,id=crypto.randomUUID()){
  const s=this.state(),c=s.connection;if(!c)throw new Error('请先连接网站。');if(pending.base&&!equal(pending.base,this.cleanUpload(pending.base)))throw new Error('网站计划基线含凭据或本地路径，请先在网站清理后重试。');s.pending.push({...pending,input:this.cleanUpload(pending.input),id,account:c.account});await this.changed();
 }
 async bind(localId:string,expected?:unknown){
  if(!this.state().connection?.enabled)throw new Error('请先连接并启用网站同步。');await this.store.load();const local=this.store.tasks.get(localId);if(!local)throw new Error('计划不存在。');if(this.base(localId))return;
  const task=this.uploadPreview(local);if(expected!==undefined&&!equal(expected,task))throw new Error('计划在预览后发生变化，请重新预览再确认。');const date=local.planDate||localDay(),c=this.state().connection!;this.state().bases[c.account+'|'+date+'|'+task.id]={date,task,localId,account:c.account,path:local.path};await this.changed();
  await this.enqueue({kind:'action',localId,input:{mode:'create',date,version:'0',task,operationId:crypto.randomUUID()}});void this.sync();
 }
 private async discover(){
  if(this.applying)return;await this.store.load();for(const base of Object.values(this.state().bases).filter(b=>b.account===this.state().connection?.account)){
   const local=this.store.tasks.get(base.localId);if(!local){await this.receivePlan(base.date,base.task);continue;}
   const current=this.toTodo(local);if(equal(current,base.task)||this.state().conflicts.some(c=>c.localId===local.id)||this.state().pending.some(p=>p.localId===local.id&&p.account===base.account))continue;
   if(!equal(current.seriesChanges,base.task.seriesChanges)&&current.seriesChanges?.length){const change=current.seriesChanges.find(c=>!base.task.seriesChanges?.some(b=>equal(b,c)));if(change){await this.enqueue({kind:'series',localId:local.id,base:base.task,input:{date:base.date,version:'0',from:change.from,stop:change.stop,task:{...change.template,id:current.id,seriesId:current.id}}});continue;}}
   if(current.status!==base.task.status)await this.enqueue({kind:'action',localId:local.id,base:base.task,input:{mode:current.status==='done'?'complete':'status',nextStatus:current.status,date:base.date,version:'0',task:current,operationId:crypto.randomUUID()}});
   if(!equal({...current,status:base.task.status,done:base.task.done,completedAt:base.task.completedAt},base.task))await this.enqueue({kind:'action',localId:local.id,base:base.task,input:{mode:'update',date:base.date,version:'0',task:current,operationId:crypto.randomUUID()}});
  }
 }
 private async push(){
  const s=this.state();for(const p of [...s.pending].filter(p=>p.account===s.connection?.account&&!p.conflict)){
   try{const localBefore=p.localId?this.store.tasks.get(p.localId):undefined,applied=localBefore?this.toTodo(localBefore):undefined;await this.call('/operations','POST',{operationId:p.id,kind:p.kind,input:['action','series'].includes(p.kind)?{...p.input,operationId:p.id}:p.input,base:p.base,baseValue:p.baseValue});s.pending=s.pending.filter(x=>x.id!==p.id);const base=p.localId?this.base(p.localId):undefined;if(base&&applied)base.task=applied;await this.changed();}
   catch(e){p.error=this.message(e);if((e as any).status===409){p.conflict=true;p.remote=(e as any).current;if(p.localId&&!s.conflicts.some(c=>c.localId===p.localId&&c.account===p.account))s.conflicts.push({id:crypto.randomUUID(),kind:'plan',localId:p.localId,remote:(e as any).current,message:p.error,account:p.account});}else if((e as any).status===401)throw e;await this.changed();}
  }
 }
 async resolve(id:string,choice:'remote'|'local'){
  const s=this.state(),conflict=s.conflicts.find(c=>c.id===id);if(!conflict||conflict.account!==s.connection?.account)throw new Error('请连接原账号处理此冲突。');
  if(conflict.kind==='document'){
   if(choice==='remote')await this.writeDocument(conflict.resource!,conflict.path!,conflict.remote.content,conflict.remote.version,true);
   else {const r=s.resources[conflict.resource!];if(r)r.version=conflict.remote.version;}
  }else{
   const base=this.base(conflict.localId!);if(!base)throw new Error('同步基线不存在。');const remote=todoSchema.parse(conflict.remote);const local=this.store.tasks.get(conflict.localId!);if(!local)throw new Error('请恢复本地计划笔记。');
   s.pending=s.pending.filter(p=>p.localId!==local.id||p.account!==conflict.account);const wanted=choice==='remote'?remote:this.toTodo(local);base.task=remote;await this.savePlan(base.date,wanted,local.id,local.projectId);
  }
  s.conflicts=s.conflicts.filter(c=>c.id!==id);await this.changed();void this.sync();
 }
 async resolveMetadata(id:string,choice:'remote'|'local'){
  const s=this.state(),p=s.pending.find(p=>p.id===id&&p.account===s.connection?.account);if(!p||!p.conflict)throw new Error('此设置没有待处理冲突。');
  if(p.kind==='views'){const remote=planViewsSchema.parse(p.remote);if(choice==='remote'){s.views=remote;s.pending=s.pending.filter(x=>x.id!==p.id);}else{p.baseValue=remote;p.id=crypto.randomUUID();p.error=undefined;p.conflict=false;delete p.remote;}}
  else if(p.kind==='category-add'&&choice==='remote'){const remote=planCategorySchema.parse(p.remote),old=p.input.id;s.categories=s.categories.filter(c=>c.id!==old&&c.id!==remote.id).concat(remote);await this.store.load();for(const local of this.store.tasks.values())if(local.plan?.category===old)await this.savePlan(local.planDate||localDay(),{...this.toTodo(local),category:remote.id},local.id);for(const op of s.pending)if(op.input?.task?.category===old){op.input.task.category=remote.id;op.id=crypto.randomUUID();op.error=undefined;op.conflict=false;}s.pending=s.pending.filter(x=>x!==p);}
  else throw new Error('请采用网站已有类别，再重新编辑本地分类。');await this.changed();void this.sync();
 }
 async actions(){await this.store.load();const records=[] as any[];
  const paths=new Set([...Object.entries(this.state().resources).filter(([key,r])=>key.startsWith('diary:')&&r.path).map(([,r])=>r.path!),...this.vault.getMarkdownFiles().filter(f=>f.path.startsWith('00_INPUT-输入池/每日记录/独立日记-本地/')).map(f=>f.path)]);
  for(const path of paths){const file=this.vault.getAbstractFileByPath(path);if(!(file instanceof TFile))continue;const date=path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];if(!date)continue;try{const raw=await this.vault.read(file),doc=parseDiaryMarkdown(this.managed(raw)||raw,date);records.push(...doc.facts.events.map(e=>({date,kind:'facts',id:e.id,summary:e.note.slice(0,2000)})),...(['learn','input','idea'] as const).flatMap(kind=>(doc.entries?.[kind]||[]).map(e=>({date,kind,id:e.id,summary:e.content.slice(0,2000)}))));}catch{/* Invalid diary text is never used as a completion reference. */}}
  const exists=(ref:any)=>!!ref&&records.some(r=>r.date===ref.date&&r.kind===ref.kind&&r.id===ref.id);
  const tasks=[] as any[];for(const local of this.store.tasks.values()){const task=this.toTodo(local),date=local.planDate||local.createdAt.slice(0,10);tasks.push({date,version:this.dayVersion(date),task,sourceExists:exists(task.source),completionExists:exists(task.completion),completionPending:this.state().pending.some(p=>p.localId===local.id&&p.input?.completionRecord),localId:local.id,sync:this.syncStatus(local.id)});}return {tasks,records};}
 private dayVersion(date:string){return fingerprint(stable([...this.store.tasks.values()].filter(t=>(t.planDate||t.createdAt.slice(0,10))===date).map(t=>this.toTodo(t))));}
 async loadDiary(date:string){let document=emptyDiary(date);const resource=this.state().resources['diary:'+date],file=resource?.path?this.vault.getAbstractFileByPath(resource.path):undefined;if(file instanceof TFile){const raw=this.managed(await this.vault.read(file));if(raw)document=parseDiaryMarkdown(raw,date);}document.todos=(await this.actions()).tasks.filter(r=>r.date===date).map(r=>r.task);return {document,version:this.dayVersion(date),exists:!!resource};}
 async schedule(from:string,to:string,cursor?:string){const {tasks}=await this.actions(),actual=new Map(tasks.map(r=>[r.task.id,r])),items=tasks.filter(r=>!isSeries(r.task)&&(r.task.dueDate||r.task.plannedDate||'')>=from&&(r.task.dueDate||r.task.plannedDate||'')<=to&&!r.task.occurrenceSuppressed);
  if(from>to||Date.parse(to)-Date.parse(from)>367*86400000)throw new Error('请选择一年以内的日程范围。');
  const roots=tasks.filter(r=>isSeries(r.task));for(const root of roots)for(let date=from;date<=to;date=addDays(date,1)){const projected=deriveOccurrence(root.task,date);if(!projected)continue;if(date===root.task.recurrenceAnchor&&!root.task.seriesChanges?.some((c:any)=>c.from<=date)){if(root.task.dueDate>=from&&root.task.dueDate<=to)items.push(root);}else if(date!==root.task.recurrenceAnchor&&!actual.has(projected.id)&&!(root.task.dueDate===date&&root.task.seriesChanges?.some((c:any)=>c.from===root.task.recurrenceAnchor)))items.push({...root,task:projected,localId:undefined});}
  for(const root of roots)if(root.task.dueDate>=from&&root.task.dueDate<=to&&!items.some(r=>r.task.id===root.task.id))items.push(root);
  items.sort((a,b)=>(a.task.dueDate+':'+a.task.id).localeCompare(b.task.dueDate+':'+b.task.id));const page=items.filter(r=>!cursor||r.task.dueDate+':'+r.task.id>cursor).slice(0,200);return {tasks:page,nextCursor:page.length===200?page.at(-1).task.dueDate+':'+page.at(-1).task.id:undefined};
 }
 async changeAction(input:any,recovering=false){return this.serialWrite(async()=>{
  const s=this.state();let intent=s.completionIntents?.find(i=>i.id===input.operationId);
  if(!intent&&input.mode==='complete'&&input.completionRecord){todoSchema.parse(input.task);captureDraftSchema.parse(input.completionRecord);intent={id:input.operationId,input:JSON.parse(JSON.stringify(input)),account:s.connection?.account};(s.completionIntents||=[]).push(intent);await this.changed();}
  try{const result=await this.performAction(input,recovering);if(intent)s.completionIntents=s.completionIntents!.filter(i=>i!==intent);await this.changed();return result;}catch(e){if(intent){intent.error=this.message(e);await this.changed();}throw e;}
 });}
 private async performAction(input:any,recovering=false){
  const plan=todoSchema.parse(input.task),rows=(await this.actions()).tasks;let row=rows.find(r=>r.date===input.date&&r.task.id===plan.id),root=plan.seriesId?rows.find(r=>r.date===input.date&&r.task.id===plan.seriesId):undefined;
  if(!row&&plan.seriesId&&root){const projected=deriveOccurrence(root.task,plan.occurrenceDate!);if(!projected||projected.id!==plan.id)throw new Error('重复期次已变化，请刷新。');row={...root,task:projected,localId:undefined};}
  if(!row&&input.mode!=='create')throw new Error('计划已删除或不存在。');
  if(row?.task.operationId===input.operationId&&input.mode==='complete'&&row.task.done){if(recovering&&row.localId){const base=this.base(row.localId);if(base&&!base.task.done&&!this.state().pending.some(p=>p.id===input.operationId))await this.enqueue({kind:'action',localId:row.localId,base:base.task,input:{...input,version:'0'}},input.operationId);}return {diary:await this.loadDiary(input.date)};}
  if(input.version&&row&&input.version!==row.version)throw new Error('计划已被修改，请刷新后重新核对；输入仍保留。');
  let next=plan;const now=new Date().toISOString();
  if(input.mode==='status'){next={...next,status:input.nextStatus,done:input.nextStatus==='done',completedAt:input.nextStatus==='done'?now:undefined};}
  if(input.mode==='complete')next={...next,status:'done',done:true,completedAt:now,operationId:input.operationId};
  if(input.mode==='restore')next={...next,status:'todo',done:false,deletedAt:undefined,completedAt:undefined};
  if(['delete','purge'].includes(input.mode))next={...next,deletedAt:now,occurrenceSuppressed:input.mode==='purge'&&!!next.seriesId};
  if(input.mode==='create'&&['daily','weekly','monthly'].includes(next.repeat?.type||'')){if(!next.dueDate)throw new Error('重复计划需要截止日期。');next={...next,dueDate:firstOccurrence(next.dueDate,next.repeat),recurrenceAnchor:firstOccurrence(next.dueDate,next.repeat)};next.seriesTemplate=todoSchema.parse(next);}
  const existing=row?.localId?this.store.tasks.get(row.localId):undefined,rootBase=root?this.base(root.localId):undefined,base=existing?this.base(existing.id):rootBase;
  if(input.mode==='complete'&&input.completionRecord&&!base){
   const record=captureDraftSchema.parse({...input.completionRecord,id:input.operationId});await this.editLocalDiary(record.date,document=>resolveRecord(document,{date:record.date,kind:record.kind==='plan'?'facts':record.kind,id:record.id,summary:''})!==undefined?document:appendCapture(document,record,{date:input.date,kind:'todo',id:plan.id,summary:plan.title}));next.completion={date:record.date,kind:record.kind==='plan'?'facts':record.kind,id:record.id,summary:record.content};
  }
  if(!base&&row?.task.completion?.kind==='facts'&&(input.mode==='restore'||input.mode==='status'&&['todo','doing'].includes(input.nextStatus))){const ref=row.task.completion;await this.editLocalDiary(ref.date,document=>{const event=document.facts.events.find(e=>e.id===ref.id);if(event&&(event.task?.id!==plan.id||event.task.date!==input.date))throw new Error('完成记录来源不一致，未删除。');document.facts.events=document.facts.events.filter(e=>e.id!==ref.id);return document;});next.completion=undefined;}
  const saved=await this.savePlan(input.date,todoSchema.parse(next),existing?.id||plan.id,existing?.projectId||'');
  if(base){const remoteBase=rootBase&&!existing?deriveOccurrence(rootBase.task,plan.occurrenceDate!):base.task;await this.enqueue({kind:'action',localId:saved.id,base:remoteBase||undefined,input:{...input,task:plan,version:'0'}},input.operationId);if(!existing)this.state().bases[base.account+'|'+input.date+'|'+plan.id]={...base,task:remoteBase!,localId:saved.id};void this.sync();}
  await this.changed();return {diary:await this.loadDiary(input.date)};
 }
 private async editLocalDiary(date:string,edit:(document:DiaryDocument)=>DiaryDocument){
  const path=`00_INPUT-输入池/每日记录/独立日记-本地/${date}.md`,file=this.vault.getAbstractFileByPath(path);await ensureFolder(this.vault,path.slice(0,path.lastIndexOf('/')));
  if(file instanceof TFile){const raw=await this.vault.read(file),content=this.managed(raw);if(content===undefined)throw new Error('同日期本地记录不含插件管理区块，请先核对，未覆盖。');const next=serializeDiaryMarkdown(edit(parseDiaryMarkdown(content,date)));await this.vault.process(file,current=>{if(current!==raw)throw new Error('日记刚刚变化，请重试。');return current.slice(0,current.indexOf(START))+START+'\n'+next.trim()+'\n'+current.slice(current.indexOf(END));});}
  else await this.vault.create(path,START+'\n'+serializeDiaryMarkdown(edit(emptyDiary(date))).trim()+'\n'+END+'\n\n## 我的记录\n');
 }
 private serialWrite<T>(fn:()=>Promise<T>):Promise<T>{const promise=this.writeQueue.catch(()=>{}).then(fn);this.writeQueue=promise.then(()=>{},()=>{});return promise;}
 async updateSeries(input:any){
  return this.serialWrite(async()=>{const rows=(await this.actions()).tasks,row=rows.find(r=>r.date===input.date&&r.task.id===(input.task.seriesId||input.task.id));if(!row||!isSeries(row.task)||input.from<row.task.recurrenceAnchor)throw new Error('重复系列不存在或日期无效。');if(input.version&&input.version!==row.version)throw new Error('系列已变化，请刷新后重新核对。');
   const {seriesId,occurrenceDate,recurrenceAnchor,seriesChanges,seriesTemplate,occurrenceSuppressed,...template}=todoSchema.parse(input.task);if(!input.stop){if(!['daily','weekly','monthly'].includes(template.repeat?.type||''))throw new Error('请选择每日、每周或每月。');if(!template.dueDate||template.dueDate<input.from)throw new Error('系列首次截止日期不能早于所选期次。');template.dueDate=firstOccurrence(template.dueDate,template.repeat);}
   const root={...row.task,seriesChanges:[...(row.task.seriesChanges||[]).filter((c:any)=>c.from<input.from),{from:input.from,stop:!!input.stop,template}]};if(input.from===root.recurrenceAnchor&&!root.done)Object.assign(root,template,{id:root.id,recurrenceAnchor:root.recurrenceAnchor,status:input.stop?'cancelled':'todo'});const base=this.base(row.localId);await this.savePlan(row.date,root,row.localId);
   for(const other of rows.filter(r=>r.task.seriesId===root.id&&r.task.occurrenceDate>=input.from&&!r.task.done&&r.task.status!=='cancelled'&&!r.task.deletedAt)){const projected=deriveOccurrence(root,other.task.occurrenceDate);await this.savePlan(other.date,input.stop?{...other.task,status:'cancelled'}:projected||{...other.task,occurrenceSuppressed:true},other.localId);}
   if(base){await this.enqueue({kind:'series',localId:row.localId,base:base.task,input});void this.sync();}await this.changed();return {diary:await this.loadDiary(row.date)};});
 }
 async api(method:string,args:any[]):Promise<any>{
  if(method==='savePlannerPreferences'){const input=args[0],s=this.state();if(!input||typeof input!=='object')throw new Error('界面设置无效。');const next={...s.preferences};if(input.layout!==undefined){if(!['list','week','month','board','windows'].includes(input.layout))throw new Error('视图无效。');next.layout=input.layout;}if(input.defaultCloud!==undefined){if(typeof input.defaultCloud!=='boolean')throw new Error('保存范围无效。');next.defaultCloud=input.defaultCloud;}if(!equal(s.preferences,next)){s.preferences=next;await this.changed();}return next;}
  if(method==='plannerContext')return this.plannerContext(args[0]);if(method==='assignPlanProject')return this.assignPlanProject(args[0],args[1],args[2]);if(method==='quickCreatePlan')return this.quickCreatePlan(args[0]);
  if(method==='previewPlan'){await this.store.load();const local=this.resolveLocal(args[0]);if(!local)throw new Error('计划不存在。');return {plan:this.uploadPreview(local)};}
  if(method==='bindPlan'){const local=this.resolveLocal(args[0]);if(!local)throw new Error('计划不存在。');return this.bind(local.id,args[1]);}
  if(method==='actions')return this.actions();if(method==='schedule')return this.schedule(args[0],args[1],args[2]);if(method==='loadDiary')return this.loadDiary(args[0]);if(method==='changeAction')return this.changeAction(args[0]);if(method==='updateSeries')return this.updateSeries(args[0]);
  const s=this.state();if(method==='planCategories')return {categories:s.categories};if(method==='planViews')return {views:s.views};if(method==='tagLibrary')return {tags:[...new Set([...s.tags,...[...this.store.tasks.values()].flatMap(t=>t.plan?.tags||[])])]};
  if(method==='parseTodo')return {title:String(args[0]),dueDate:'',dueTime:'',priority:'medium',list:'',tags:[]};
  if(method==='parseCapture')return {drafts:[captureDraftSchema.parse({id:crypto.randomUUID(),kind:'facts',content:String(args[0]),date:args[1]?.date||localDay(),time:args[1]?.time||''})],mode:'manual'};
  if(method==='addSharedTag'){const tag=String(args[0]).trim();if(!tag||tag.length>40)throw new Error('标签应为1–40字。');s.tags=[...new Set(s.tags.concat(tag))];if(s.connection)await this.enqueue({kind:'tag',input:tag});await this.changed();return {tags:s.tags};}
  if(method==='savePlanViews'){const before=s.views,next=planViewsSchema.parse(args[0]);s.views=next;if(s.connection)await this.enqueue({kind:'views',input:next,baseValue:before});await this.changed();return {views:next};}
  if(method==='addPlanCategory'){const category=planCategorySchema.parse({id:'cat-'+crypto.randomUUID(),name:args[0],color:args[1],order:s.categories.length});if(s.categories.some(c=>c.name===category.name))throw new Error('类别名称重复。');s.categories.push(category);if(s.connection)await this.enqueue({kind:'category-add',input:{id:category.id,name:category.name,color:category.color}});await this.changed();void this.sync();return {category,categories:s.categories};}
  if(method==='reorderPlanCategories'){const ids=args[0] as string[];s.categories=s.categories.map(c=>({...c,order:ids.includes(c.id)?ids.indexOf(c.id):ids.length+c.order})).sort((a,b)=>a.order-b.order);if(s.connection)await this.enqueue({kind:'category-order',input:ids});await this.changed();return {categories:s.categories};}
  if(method==='addTag')return {tags:{person:[],place:[],activity:[],food:[],thing:[]}};
  throw new Error('此操作未开放给计划界面。');
 }
 async pathForReference(ref:{date:string;id:string;kind:string},cloud=false){
  if(ref.kind==='todo'){const task=[...this.store.tasks.values()].find(t=>(t.plan?.id||t.id)===ref.id&&t.planDate===ref.date);if(task)return task.path;}
  const remote=this.state().resources['diary:'+ref.date]?.path,local=`00_INPUT-输入池/每日记录/独立日记-本地/${ref.date}.md`;
  for(const path of [remote,local].filter((p):p is string=>!!p)){const file=this.vault.getAbstractFileByPath(path);if(!(file instanceof TFile))continue;try{const raw=await this.vault.read(file),doc=parseDiaryMarkdown(this.managed(raw)||raw,ref.date);if(resolveRecord(doc,ref as any)!==undefined)return path;}catch{/* A broken reference cannot select a different record. */}}
  return cloud?remote||this.notePath(ref.date):local;
 }
}
