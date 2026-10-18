import {TFile,parseYaml,type Vault} from 'obsidian';
import type {RoleContext,StageId} from './role-workflow';
import {stagePath,annotateRole} from './role-workflow';
import {ensureFolder,uniquePath} from './storage';
import {fingerprint} from './sync-format';
import {safePath} from './core';
export interface RoleCandidate {path:string;title:string;stageId:StageId;reason:string;hash:string}
export class RoleWorkspace {
 constructor(private vault:Vault,private allowed:(path:string)=>boolean){ }
 async initialize(c:RoleContext){
  if(!safePath(c.root).startsWith('09_ROLES-岗位工作区/'))throw Error('岗位工作区必须位于岗位目录内。');for(const s of c.workflow.stages)if(s.folder.includes('/')||s.folder.includes('\\')||s.categories.some(x=>x.includes('/')||x.includes('\\')))throw Error('岗位目录配置无效。');
  for(const stage of c.workflow.stages){await ensureFolder(this.vault,stagePath(c,stage.id));for(const cat of stage.categories)await ensureFolder(this.vault,stagePath(c,stage.id)+'/'+cat);const index=stagePath(c,stage.id)+'/索引.md';if(!this.vault.getAbstractFileByPath(index))await this.vault.create(index,`---\nkf_role_home: true\nkf_role_id: ${JSON.stringify(c.roleId)}\n---\n\n# ${c.name} · ${stage.folder}\n\n${stage.purpose}\n\n分类：${stage.categories.join('、')||'本阶段资料'}\n\n请在公司工作台「我的岗位」查看实时资料与授权共享内容。\n`);}
  const home=c.root+'/Home.md';if(!this.vault.getAbstractFileByPath(home))await this.vault.create(home,`---\nkf_role_home: true\nkf_role_id: ${JSON.stringify(c.roleId)}\n---\n\n# ${c.name}岗位工作区\n\n个人资料保留在本机；共享资料请在公司工作台查看当前授权副本。\n\n## 知识流程\n\n${c.workflow.stages.map(s=>`- [[${stagePath(c,s.id)}/索引.md|${s.folder}]]：${s.purpose}`).join('\n')}\n\n## AI 工作流程\n\n${c.workflow.analysis.join(' → ')}\n\n岗位工作台提供资料、项目与待办的实时导航。\n`);
  for(const t of c.workflow.templates){const path=stagePath(c,'system')+'/模板/'+t.id.replace(/[^a-zA-Z0-9_-]/g,'_')+'.md';if(!this.vault.getAbstractFileByPath(path))await this.vault.create(path,'---\nkf_role_template: true\n---\n\n'+t.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,''));}
 }
 async createNote(c:RoleContext,templateId:string){await this.initialize(c);const t=c.workflow.templates.find(t=>t.id===templateId);if(!t)throw Error('岗位模板已更新，请重新选择。');const folder=stagePath(c,t.stage)+(t.stage==='input'?'/Inbox':'');await ensureFolder(this.vault,folder);const body=annotateRole(t.body,c,folder).replace(/^(---\r?\n)/,'$1kf_status: draft\n');return this.vault.create(uniquePath(this.vault,folder,t.title+'.md'),body+'\n\n> 个人草稿；未提交公司共享。\n');}
 async references(c:RoleContext){const out:Array<RoleCandidate&{roleId:string}>=[];for(const file of this.vault.getMarkdownFiles().filter(f=>f.path.startsWith(c.root+'/'))){const raw=await this.vault.cachedRead(file),front=raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);let fm:any;try{fm=front?parseYaml(front[1]):{};}catch{continue;}if(!fm?.kf_role_reference||fm.kf_role_id!==c.roleId||typeof fm.kf_source_path!=='string'||!c.workflow.stages.some(s=>s.id===fm.kf_stage))continue;const path=safePath(fm.kf_source_path);if(!this.allowed(path)||path.startsWith('08_COMPANY-'))continue;out.push({path,title:path.split('/').pop()!,stageId:fm.kf_stage,reason:fm.kf_link_reason||'已确认关联',hash:fm.kf_source_hash||'',roleId:c.roleId});}return out;}
 async scan(c:RoleContext):Promise<RoleCandidate[]>{
  const out:RoleCandidate[]=[];
  for(const f of this.vault.getMarkdownFiles()){
   if(!this.allowed(f.path)||/^(?:08_COMPANY-|09_ROLES-)/.test(f.path)||/(?:原始文档|对话记录|模板|备份|backups?)/i.test(f.path)||f.path==='Home.md')continue;
   const raw=await this.vault.cachedRead(f),front=raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);let fm:any={};try{fm=front?parseYaml(front[1])||{}:{};}catch{continue;}
   if(fm.kf_role_template||fm.kf_status==='draft')continue;
   const text=f.basename+' '+String(fm.tags||'')+' '+raw.slice(0,1500),rank=c.workflow.stages.filter(s=>s.id!=='system'&&s.id!=='assets').map(s=>({s,terms:s.categories.filter(t=>t!=='Inbox'&&t!=='sources'&&text.includes(t))})).filter(x=>x.terms.length).sort((a,b)=>b.terms.length-a.terms.length);
   if(!rank.length)continue;const {s,terms}=rank[0];out.push({path:f.path,title:f.basename,stageId:s.id,reason:'本地匹配分类：'+terms.join('、')+'；需人工确认',hash:fingerprint(raw)});
  }return out;
 }
 async link(c:RoleContext,candidate:RoleCandidate){if(!c.workflow.stages.some(s=>s.id===candidate.stageId&&s.id!=='system'))throw Error('岗位阶段无效。');const f=this.vault.getAbstractFileByPath(candidate.path);if(!(f instanceof TFile)||!this.allowed(f.path)||fingerprint(await this.vault.read(f))!==candidate.hash)throw Error('资料或权限已变化，请重新扫描。');await this.initialize(c);const folder=stagePath(c,candidate.stageId),path=folder+'/关联-'+fingerprint(candidate.path).slice(0,16)+'.md';const body=annotateRole(`---\nkf_role_reference: true\nkf_source_path: ${JSON.stringify(candidate.path)}\nkf_source_hash: ${JSON.stringify(candidate.hash)}\nkf_link_reason: ${JSON.stringify(candidate.reason)}\n---\n\n# ${candidate.title}\n\n个人资料原位关联：[[${candidate.path}]]\n\n依据：${candidate.reason}\n`,c,folder);const old=this.vault.getAbstractFileByPath(path);if(old){if(!(old instanceof TFile)||await this.vault.read(old)!==body)throw Error('关联入口已存在或被修改，未覆盖：'+path);}else await this.vault.create(path,body);}
}
