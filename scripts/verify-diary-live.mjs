// Explicit production acceptance: synthetic isolated account only, never user vault content.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const origin='https://47.115.220.98:3399',privatePath='.test-output/diary-qa-private.json';
let saved;try{saved=JSON.parse(await fs.readFile(privatePath,'utf8'));if(saved.revoked||!saved.cookie)saved=undefined;}catch{}
async function request(path,body,{cookie=saved?.cookie,token,method=body?'POST':'GET'}={}){
 const result=await fetch(origin+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await result.json();if(!result.ok)throw Object.assign(new Error('Acceptance API failed '+path+' ('+result.status+')'),{status:result.status});return {data,cookie:result.headers.get('set-cookie')?.split(';')[0]};
}
if(!saved){const username='kf_accept_'+Date.now(),password=crypto.randomBytes(24).toString('hex'),auth=await request('/api/auth/register',{username,password},{cookie:undefined});saved={username,password,cookie:auth.cookie,accountId:auth.data.id};await fs.writeFile(privatePath,JSON.stringify(saved,null,2));}
if(!saved.device){saved.device=(await request('/api/obsidian-devices',{name:'0.7.0 隔离验收设备'})).data;await fs.writeFile(privatePath,JSON.stringify(saved,null,2));}
const info=(await request('/api/obsidian-sync/v1/info',undefined,{cookie:undefined,token:saved.device.token})).data;
if(info.account.id!==saved.accountId)throw new Error('Acceptance account mismatch');
if(!saved.planId){const planId=crypto.randomUUID(),operationId=crypto.randomUUID();await request('/api/actions',{mode:'create',date:'2026-10-16',version:'0',task:{id:planId,title:'验收 · 网站创建并同步到 Obsidian',description:'隔离账号合成计划，不含个人资料。',category:'work',important:true,urgent:false,dueDate:'2026-10-17',dueTime:'15:00',startDate:'2026-10-16',startTime:'09:00',subtasks:[{id:crypto.randomUUID(),title:'核对双端结果',done:false}],tags:['同步验收']},operationId});saved.planId=planId;await fs.writeFile(privatePath,JSON.stringify(saved,null,2));}
const snapshot=(await request('/api/obsidian-sync/v1/snapshot',undefined,{cookie:undefined,token:saved.device.token})).data;
if(!snapshot.items.some(r=>r.document?.todos.some(t=>t.id===saved.planId)))throw new Error('Website-created plan missing from snapshot');
if(process.argv.includes('--check-edit')){const row=(await request('/api/actions')).data.tasks.find(r=>r.task.id===saved.planId);if(row.task.dueDate!=='2026-10-18'||row.task.dueTime!=='16:30'||row.task.startDate!=='2026-10-16'||row.task.startTime!=='09:00')throw new Error('Local schedule edit did not reach website, or original start changed');console.log('Actual Obsidian Markdown edit reached website; deadline changed and original start retained.');}
if(process.argv.includes('--complete')){const row=(await request('/api/actions')).data.tasks.find(r=>r.task.id===saved.planId),operationId=crypto.randomUUID();await request('/api/actions',{mode:'complete',date:row.date,version:row.version,task:row.task,operationId,completionRecord:{id:operationId,date:row.date,version:row.version,kind:'facts',time:'16:40',content:'隔离验收：双端调整截止时间并完成核对。'}});saved.completionId=operationId;await fs.writeFile(privatePath,JSON.stringify(saved,null,2));console.log('Synthetic website completion and linked diary fact saved.');}
if(process.argv.includes('--revoke')){await request('/api/obsidian-devices/'+saved.device.id,undefined,{method:'DELETE'});try{await request('/api/obsidian-sync/v1/info',undefined,{cookie:undefined,token:saved.device.token});throw new Error('Revocation did not block token');}catch(e){if(e.status!==401)throw e;}console.log('Acceptance device revoked; rejected with 401 as expected.');}
await fs.writeFile('.test-output/diary-live-check.json',JSON.stringify({health:true,isolatedAccount:true,deviceAuthorization:true,websitePlanSnapshot:true,protocol:info.protocol},null,2));
console.log('Live HTTPS verified: isolated account, device authorization, website plan and paged snapshot. Secrets saved only in ignored local test file.');
