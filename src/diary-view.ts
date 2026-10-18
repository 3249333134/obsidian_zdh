import {ItemView,TFile, type WorkspaceLeaf} from 'obsidian';
import type KnowledgeFlow from './main';
import {DIARY_VIEW} from './diary-sync';
import {projectButton,projectField,projectSelect} from './project-ui';
import planningJS from '../vendor/diary-planning/planning.js?raw';
import planningCSS from '../vendor/diary-planning/planning.css?raw';
export class DiaryView extends ItemView {
 private frame?:HTMLIFrameElement;private nonce=crypto.randomUUID();private listener?:(e:MessageEvent)=>void;private themeObserver?:MutationObserver;private status!:HTMLElement;private statusDetails!:HTMLElement;private connectionPanel?:HTMLDetailsElement;private conflictList!:HTMLElement;private filter='';private layout='list';
 constructor(leaf:WorkspaceLeaf,private plugin:KnowledgeFlow){super(leaf);}
 getViewType(){return DIARY_VIEW;}getDisplayText(){return '计划与日程';}getIcon(){return 'calendar-days';}
 async onOpen(){await this.plugin.projects().load();this.layout=this.plugin.diaryState.preferences?.layout||'list';this.render();}
 async onClose(){if(this.listener)window.removeEventListener('message',this.listener);this.themeObserver?.disconnect();this.frame?.remove();}
 showLayout(layout?:string,projectId=''){if(layout)this.layout=layout;this.filter=projectId;this.frame?.contentWindow?.postMessage({kind:'kf-navigate',nonce:this.nonce,layout:this.layout},'*');this.refresh();}
 refresh(){if(!this.frame)return;this.status.textContent=this.shortStatus();this.status.title=this.description();this.statusDetails.textContent=this.description();this.frame.contentWindow?.postMessage({kind:'kf-refresh',nonce:this.nonce},'*');this.updateConflicts();}
 private shortStatus(){if(this.plugin.companyState?.planMode==='company'){const s=this.plugin.companyState;return s.error?'公司同步待处理':s.pending.length?'公司正在同步…':s.connection?.enabled?'公司已同步':'公司同步已暂停';}const s=this.plugin.diaryState,c=s.connection;if(!c)return '连接网站';const count=s.conflicts.filter(x=>x.account===c.account).length;if(count)return `同步冲突 ${count}`;if(s.error||s.pending.some(p=>p.account===c.account&&p.error))return '同步待处理';if(!c.enabled)return '同步已暂停';return s.pending.some(p=>p.account===c.account)?'正在同步…':s.lastSuccess?'已同步 · 设置':'连接就绪 · 设置';}
 private description(){if(this.plugin.companyState?.planMode==='company'){const s=this.plugin.companyState;return `${s.profile?.company.name||'公司'} · 待提交 ${s.pending.length} · ${s.error||'公司团队计划独立同步，不写入个人日记'}`;}const state=this.plugin.diaryState,c=state.connection;return c?`${c.username} · ${c.enabled?'自动同步已启用':'已暂停'} · 待提交 ${state.pending.filter(p=>p.account===c.account).length} · 冲突 ${state.conflicts.filter(p=>p.account===c.account).length}${state.lastSuccess?' · 上次成功 '+new Date(state.lastSuccess).toLocaleString():''}${state.error?' · '+state.error:''}`:'尚未连接网站；本地计划可正常使用。';}
 private render(){
  if(this.listener)window.removeEventListener('message',this.listener);this.themeObserver?.disconnect();this.frame?.remove();const root=this.contentEl;root.empty();root.addClass('kf-diary-root','kf-project-root');
  const header=root.createDiv({cls:'kf-diary-header'});header.createEl('h1',{text:'计划与日程'});
  const bar=header.createDiv({cls:'kf-project-toolbar'});
  if(this.plugin.companyState?.connection){const scope=projectSelect(header,'计划归属',[['personal','个人本地／独立日记'],['company','公司团队']],this.plugin.companyState.planMode||'personal');scope.onchange=()=>{this.plugin.companyState.planMode=scope.value as 'personal'|'company';void this.plugin.persist().then(()=>this.render());};}
  this.status=bar.createEl('button',{text:this.shortStatus(),cls:'kf-diary-sync-status',attr:{type:'button','aria-live':'polite','aria-expanded':'false'}});this.status.title=this.description();
  projectButton(bar,'项目总览',()=>this.plugin.openProjects(),this.status);
  const settings=root.createEl('details',{cls:'kf-diary-settings'});this.connectionPanel=settings;settings.id='kf-diary-settings-'+this.nonce;settings.hidden=true;settings.open=true;this.status.setAttribute('aria-controls',settings.id);this.status.onclick=()=>{settings.hidden=!settings.hidden;settings.open=true;this.status.setAttribute('aria-expanded',String(!settings.hidden));};
  const details=settings,summary=details.createEl('summary',{text:'网站连接与同步'});summary.tabIndex=0;this.statusDetails=details.createEl('p',{text:this.description(),attr:{role:'status','aria-live':'polite'}});
  const url=projectField(details,'网站地址',this.plugin.diaryState.connection?.url||'https://47.115.220.98:3399');const token=projectField(details,'设备授权令牌（在网站“连接 Obsidian”中生成）',this.plugin.diaryState.connection?.token||'');token.type='password';token.autocomplete='off';
  projectButton(details,'测试连接并开启自动同步',async()=>{await this.plugin.diary().connect(url.value,token.value);this.refresh();},this.status,true);
  projectButton(details,'立即同步',async()=>{await this.plugin.diary().sync();this.refresh();},this.status);
  projectButton(details,'暂停／恢复',async()=>{await this.plugin.diary().pause(!!this.plugin.diaryState.connection?.enabled);this.refresh();},this.status);
  projectButton(details,'断开连接',async()=>{await this.plugin.diary().disconnect();token.value='';this.refresh();},this.status);
  details.createEl('p',{text:'仅在 Obsidian 打开时，每 30 秒自动同步。计划双向同步，日记和复盘下载到本地；AI Key 与设备授权分开。'});
  const mode=projectSelect(settings,'新建计划默认保存到',[['local','仅本地'],['cloud','本地与网站']],this.plugin.diaryState.preferences?.defaultCloud!==false?'cloud':'local');mode.onchange=()=>{void this.plugin.diary().api('savePlannerPreferences',[{defaultCloud:mode.value==='cloud'}]).catch(e=>this.statusDetails.textContent=e.message);};
  details.createEl('p',{text:'项目关联和已有计划接入网站，请点击计划标题，在右侧详情中操作。'});
  this.conflictList=root.createDiv();this.updateConflicts();
  this.frame=root.createEl('iframe',{cls:'kf-diary-frame',attr:{title:'独立日记计划工作区',sandbox:'allow-scripts allow-downloads'}});
  this.frame.addEventListener('load',()=>this.frame?.contentWindow?.postMessage({kind:'kf-navigate',nonce:this.nonce,layout:this.layout},'*'));
  const dark=document.body.classList.contains('theme-dark');
  this.frame.srcdoc=`<!doctype html><html lang="zh-CN" data-company="${this.plugin.companyState?.planMode==='company'}" data-theme="${dark?'dark':'light'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><style>${planningCSS}</style><body><div id="app"></div><script>window.__KF_COMPANY=${JSON.stringify(this.plugin.companyState?.planMode==='company')};window.__KF_NONCE=${JSON.stringify(this.nonce)};window.__KF_INITIAL_LAYOUT=${JSON.stringify(this.layout)};<\/script><script>${planningJS.replace(/<\/script/gi,'<\\/script')}<\/script></body></html>`;
  this.listener=event=>{const data=event.data;if(event.source!==this.frame?.contentWindow||data?.nonce!==this.nonce||data.kind!=='kf-call')return;
   if(typeof data.method!=='string'||!Array.isArray(data.args)||JSON.stringify(data.args).length>2000000)return;
   void this.handle(data.method,data.args).then(result=>this.frame?.contentWindow?.postMessage({kind:'kf-result',nonce:this.nonce,id:data.id,result},'*')).catch(e=>this.frame?.contentWindow?.postMessage({kind:'kf-result',nonce:this.nonce,id:data.id,error:e instanceof Error?e.message:'操作失败'},'*'));
  };window.addEventListener('message',this.listener);
  this.themeObserver=new MutationObserver(()=>this.frame?.contentWindow?.postMessage({kind:'kf-theme',nonce:this.nonce,dark:document.body.classList.contains('theme-dark')},'*'));this.themeObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
 }
 private async handle(method:string,args:any[]){
  if(this.plugin.companyState?.planMode==='company'){if(method==='openCompanyTasks'){await this.plugin.openTeamTasks();return {};}if(method==='savePlannerPreferences')return this.plugin.diary().api(method,args);return this.plugin.company().planner(method,args);}
  if(method==='openReference'){const path=await this.plugin.diary().pathForReference(args[0]);await this.app.workspace.openLinkText(path,'',false);return {};}
  if(method==='setProjectFilter'){const filter=String(args[0]);if(filter&&filter!=='__none'&&!this.plugin.projects().projects.has(filter))throw new Error('所选项目已不存在。');this.filter=filter;this.refresh();return {};}
  const result=await this.plugin.diary().api(method,args);
  if(method==='plannerContext')return {...result,projectFilter:this.filter};
  if(method==='actions'&&this.filter)result.tasks=result.tasks.filter((r:any)=>{const task=this.plugin.projects().tasks.get(r.localId);return this.filter==='__none'?!task?.projectId:task?.projectId===this.filter;});
  if(method==='schedule'&&this.filter)result.tasks=result.tasks.filter((r:any)=>{const task=[...this.plugin.projects().tasks.values()].find(t=>t.plan?.id===(r.task.seriesId||r.task.id)||t.id===(r.task.seriesId||r.task.id));return this.filter==='__none'?!task?.projectId:task?.projectId===this.filter;});
  if(['changeAction','updateSeries','quickCreatePlan','bindPlan','assignPlanProject'].includes(method)){await this.plugin.projects().load();this.status.textContent=this.shortStatus();}
  return result;
 }
 private updateConflicts(){if(!this.conflictList)return;this.conflictList.empty();for(const issue of this.plugin.projects().issues){const row=this.conflictList.createDiv({cls:'kf-diary-conflict'});row.createEl('p',{text:issue.path+'：'+issue.message});projectButton(row,'打开需要修复的文件',()=>this.app.workspace.openLinkText(issue.path,'',false),this.status);}
  for(const intent of this.plugin.diaryState.completionIntents||[]){const row=this.conflictList.createDiv({cls:'kf-diary-conflict'});row.createEl('p',{text:'完成记录写入待恢复：'+(intent.error||intent.input.task.title)});projectButton(row,'重试原完成操作',async()=>{await this.plugin.diary().recoverCompletions(intent.id);this.refresh();},this.status);projectButton(row,'保留现有笔记并取消此操作',async()=>{await this.plugin.diary().dismissCompletion(intent.id);this.refresh();},this.status);}
  for(const pending of this.plugin.diaryState.pending.filter(p=>p.account===this.plugin.diaryState.connection?.account&&p.error&&!p.localId)){const row=this.conflictList.createDiv({cls:'kf-diary-conflict'});row.createEl('p',{text:`${pending.kind} 尚未提交：${pending.error}`});if(!pending.conflict)projectButton(row,'重试提交',()=>this.plugin.diary().sync(),this.status);else{row.createEl('pre',{text:JSON.stringify({本地:pending.input,云端:pending.remote},null,2)});if(pending.remote!==undefined){projectButton(row,'采用网站设置',async()=>{await this.plugin.diary().resolveMetadata(pending.id,'remote');this.refresh();},this.status);if(pending.kind==='views')projectButton(row,'确认以本地视图替换网站视图',async()=>{await this.plugin.diary().resolveMetadata(pending.id,'local');this.refresh();},this.status);}else row.createEl('p',{text:'网站没有提供可比较版本；已保留操作，请先核对网站设置。其他计划继续同步。'});}}
  for(const conflict of this.plugin.diaryState.conflicts.filter(c=>c.account===this.plugin.diaryState.connection?.account)){
  const box=this.conflictList.createDiv({cls:'kf-diary-conflict'});box.createEl('h3',{text:'需要核对的同步冲突'});box.createEl('p',{text:conflict.message});
  if(conflict.path)projectButton(box,'打开本地笔记',()=>this.app.workspace.openLinkText(conflict.path!,'',false),this.status);
  if(conflict.localId){const task=this.plugin.projects().tasks.get(conflict.localId);box.createEl('pre',{text:JSON.stringify({本地:task?this.plugin.diary().toTodo(task):null,云端:conflict.remote},null,2)});}
  projectButton(box,'采用云端版本',async()=>{await this.plugin.diary().resolve(conflict.id,'remote');this.refresh();},this.status);projectButton(box,'保留本地版本',async()=>{await this.plugin.diary().resolve(conflict.id,'local');this.refresh();},this.status);
 }}
}
