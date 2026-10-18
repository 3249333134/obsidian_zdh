import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { todoSchema, type Todo } from '@diary/contracts';
import { pool, queryRows } from './db.js';
import { config, vaultPaths } from './config.js';
import { loadDiary } from './vault.js';
import { actionRequestSchema, changeAction } from './actions.js';
import { seriesRequest, updateSeries } from './schedule.js';
import { addPlanCategory, getPlanCategories, reorderPlanCategories, getPlanViews, savePlanViews, addSharedTag } from './planSettings.js';
import { syncSetting } from './sync-db.js';
import {deriveOccurrence} from './recurrence.js';

const PREFIX='/api/obsidian-sync/v1';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const fail=(message:string,statusCode=400,extra={})=>Object.assign(new Error(message),{statusCode,...extra});
const stable=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&v!=='').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(stable(v))])):Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):value??null);
const equal=(a:unknown,b:unknown)=>stable(a)===stable(b);
const queue=new Map<number,Promise<unknown>>();
const serial=<T>(id:number,work:()=>Promise<T>)=>{const result=(queue.get(id)||Promise.resolve()).then(work,work);queue.set(id,result.catch(()=>{}));return result;};

export async function syncIdentity(token:string) {
  if(!/^diary_obs_[a-f0-9]{64}$/.test(token))return null;
  const rows=await queryRows<{user_id:number}>('SELECT user_id FROM obsidian_devices WHERE token_hash = ? AND revoked_at IS NULL',[hash(token)]);
  return rows[0]?.user_id??null;
}
const resourceKey=(kind:string,key:string)=>`${kind}:${key}`;
async function resources(userId:number) {
  const diaries=await queryRows<{date:string;version:string}>('SELECT date,version FROM diaries WHERE user_id = ? ORDER BY date',[userId]);
  const settings=await queryRows<{key:string;value:string}>('SELECT `key`,value FROM settings WHERE user_id = ?',[userId]);
  return [...diaries.map(row=>({kind:'diary',key:row.date,version:row.version})),...settings.filter(r=>syncSetting(r.key)).map(r=>({kind:'setting',key:r.key,version:hash(r.value)}))].sort((a,b)=>resourceKey(a.kind,a.key)<resourceKey(b.kind,b.key)?-1:resourceKey(a.kind,a.key)>resourceKey(b.kind,b.key)?1:0);
}
async function resource(userId:number,kind:string,key:string) {
  if(kind==='diary'){
    const data=await loadDiary(key,userId); return {kind,key,version:data.version,deleted:!data.exists,document:data.exists?data.document:undefined};
  }
  if(kind!=='setting'||!syncSetting(key))throw fail('不支持此同步资源');
  const rows=await queryRows<{value:string}>('SELECT value FROM settings WHERE user_id = ? AND `key` = ?',[userId,key]);
  return {kind,key,version:rows[0]?hash(rows[0].value):'0',deleted:!rows.length,value:rows[0]?JSON.parse(rows[0].value):undefined};
}
const operationSchema=z.object({operationId:z.string().uuid(),kind:z.enum(['action','series','category-add','category-order','views','tag']),input:z.unknown(),base:todoSchema.optional(),baseValue:z.unknown().optional()});
const editable=['title','time','plannedDate','description','subtasks','priority','dueDate','dueTime','list','tags','repeat','attachments','entities','category','important','urgent','startDate','startTime'] as const;
function merge(base:Todo,wanted:Todo,current:Todo) {
  const next={...current},fields:string[]=[];
  for(const field of editable) if(!equal(base[field],wanted[field])) {
    if(!equal(base[field],current[field])&&!equal(wanted[field],current[field]))fields.push(field);
    else (next as any)[field]=wanted[field];
  }
  if(fields.length)throw fail('计划在两端同时修改，请核对冲突字段',409,{code:'SYNC_CONFLICT',fields,current});
  return next;
}
async function apply(userId:number,raw:unknown) {
  const op=operationSchema.parse(raw),requestHash=hash(stable(op));
  const existing=await queryRows<{request_hash:string;status:string}>('SELECT request_hash,status FROM obsidian_operations WHERE user_id = ? AND operation_id = ?',[userId,op.operationId]);
  if(existing[0]?.request_hash!==undefined&&existing[0].request_hash!==requestHash)throw fail('操作标识已用于其他内容',409);
  if(existing[0]?.status==='done')return {ok:true,operationId:op.operationId};
  if(!existing.length)await pool.query('INSERT INTO obsidian_operations (user_id,operation_id,request_hash,status) VALUES (?,?,?,?)',[userId,op.operationId,requestHash,'pending']);
  if(op.kind==='action'){
    const input=actionRequestSchema.parse(op.input);input.operationId=op.operationId;
    const diary=await loadDiary(input.date,userId);let current=diary.document.todos.find(t=>t.id===input.task.id);
    if(!current&&input.task.seriesId&&input.task.occurrenceDate){const root=diary.document.todos.find(t=>t.id===input.task.seriesId);current=root?deriveOccurrence(root,input.task.occurrenceDate)||undefined:undefined;}
    if(current&&input.mode!=='create'){
      if(!op.base)throw fail('缺少计划同步基线',409);
      if(input.mode==='update')input.task=merge(op.base,input.task,current);
      else if(!equal(op.base,current)&&!(input.mode==='complete'&&current.done&&current.operationId===op.operationId)) {
        const target=input.mode==='status'?input.nextStatus:input.mode==='complete'?'done':undefined;
        if(!target||current.status!==target)throw fail('计划状态或内容已变化，请核对后再提交',409,{code:'SYNC_CONFLICT',current});
      }
      input.version=diary.version;
    }
    if(input.mode==='create')input.version=diary.version;
    if(input.completionRecord){const target=await loadDiary(input.completionRecord.date,userId);input.completionRecord.version=target.version;}
    if(input.sourceVersion&&input.task.source)input.sourceVersion=(await loadDiary(input.task.source.date,userId)).version;
    await changeAction(input,userId);
  }else if(op.kind==='series'){
    const input=seriesRequest.parse(op.input),diary=await loadDiary(input.date,userId),root=diary.document.todos.find(t=>t.id===(input.task.seriesId||input.task.id));
    if(!root||!op.base||!equal(root,op.base))throw fail('重复系列已变化，请刷新后重新确认',409,{code:'SYNC_CONFLICT',current:root});
    await updateSeries({...input,version:diary.version},userId);
  }else if(op.kind==='category-add'){
    const input=z.object({id:z.string().regex(/^cat-[a-f0-9-]{36}$/).optional(),name:z.string(),color:z.string()}).parse(op.input),categories=await getPlanCategories(userId);
    const duplicate=categories.find(c=>c.name===input.name);if(duplicate&&input.id&&duplicate.id!==input.id)throw fail('网站已有同名类别，请先刷新类别后重新选择',409,{code:'SYNC_CONFLICT',current:duplicate});
    if(!duplicate)await addPlanCategory(input,userId,input.id);
  }else if(op.kind==='category-order')await reorderPlanCategories(z.array(z.string()).parse(op.input),userId);
  else if(op.kind==='views'){
    const current=await getPlanViews(userId);if(!equal(op.baseValue,current)&&!equal(op.input,current))throw fail('标签视图已在网站变化，请核对后重试',409,{code:'SYNC_CONFLICT',current});
    await savePlanViews(op.input,userId);
  }else await addSharedTag(z.string().parse(op.input),userId);
  await pool.query('UPDATE obsidian_operations SET status = ? WHERE user_id = ? AND operation_id = ?',['done',userId,op.operationId]);
  return {ok:true,operationId:op.operationId};
}
export function registerObsidianSync(app:FastifyInstance) {
  app.get('/api/obsidian-devices',async request=>({devices:await queryRows('SELECT id,name,created_at,revoked_at FROM obsidian_devices WHERE user_id = ? ORDER BY created_at',[request.userId!])}));
  app.post('/api/obsidian-devices',async request=>{
    const {name}=z.object({name:z.string().trim().min(1).max(100)}).parse(request.body),token='diary_obs_'+randomBytes(32).toString('hex'),id=randomUUID();
    await pool.query('INSERT INTO obsidian_devices (id,user_id,name,token_hash,created_at) VALUES (?,?,?,?,?)',[id,request.userId!,name,hash(token),new Date().toISOString()]);
    return {id,token};
  });
  app.delete<{Params:{id:string}}>('/api/obsidian-devices/:id',async request=>{await pool.query('UPDATE obsidian_devices SET revoked_at = ? WHERE id = ? AND user_id = ?',[new Date().toISOString(),request.params.id,request.userId!]);return {ok:true};});
  app.get(PREFIX+'/info',async request=>{
    const rows=await queryRows<{id:number;username:string}>('SELECT id,username FROM users WHERE id = ?',[request.userId!]);
    return {protocol:1,account:rows[0],timezone:config.timezone,capabilities:['plans:write','diaries:read','reviews:read','completion:append'],defaults:{categories:`${vaultPaths.system}/plan-categories.json`,views:`${vaultPaths.system}/plan-views.json`,tags:`${vaultPaths.system}/shared-tags.json`}};
  });
  app.get<{Querystring:{after?:string;watermark?:string;limit?:string}}>(PREFIX+'/snapshot',async request=>{
    const userId=request.userId!,limit=Math.min(100,Math.max(1,Number(request.query.limit)||50));
    const seq=await queryRows<{seq:number}>('SELECT MAX(seq) AS seq FROM obsidian_changes WHERE user_id = ?',[userId]);
    const watermark=request.query.watermark===undefined?Number(seq[0]?.seq||0):Number(request.query.watermark);
    if(!Number.isSafeInteger(watermark)||watermark<0)throw fail('同步游标无效');
    const all=(await resources(userId)).filter(r=>!request.query.after||resourceKey(r.kind,r.key)>request.query.after!),page=all.slice(0,limit),last=page.at(-1);
    return {watermark,items:await Promise.all(page.map(r=>resource(userId,r.kind,r.key))),next:all.length>limit&&last?resourceKey(last.kind,last.key):null};
  });
  app.get<{Querystring:{cursor?:string;limit?:string}}>(PREFIX+'/changes',async request=>{
    const cursor=Number(request.query.cursor||0),limit=Math.min(100,Math.max(1,Number(request.query.limit)||50));if(!Number.isSafeInteger(cursor)||cursor<0)throw fail('同步游标无效');
    const rows=await queryRows<{seq:number;kind:string;resource_key:string}>('SELECT seq,kind,resource_key FROM obsidian_changes WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',[request.userId!,cursor,limit+1]),page=rows.slice(0,limit);
    const unique=[...new Map(page.map(r=>[resourceKey(r.kind,r.resource_key),r])).values()];
    return {cursor:page.length?Number(page[page.length-1].seq):cursor,more:rows.length>limit,items:await Promise.all(unique.map(r=>resource(request.userId!,r.kind,r.resource_key)))};
  });
  app.post(PREFIX+'/operations',async request=>serial(request.userId!,()=>apply(request.userId!,request.body)));
}
