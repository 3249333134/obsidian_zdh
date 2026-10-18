// THESIS: Diary's complete planning workflow, running on Markdown rather than a second website.
// OWN-WORLD: The existing lavender Diary controls, shared cards and responsive navigation.
// STORY: Find, edit, schedule and complete a plan; the host exposes project and sync confirmation.
// FIRST VIEWPORT: Compact navigation beside live plans, with no fabricated data.
// FORM: Reuse the explicitly requested Diary composition and components; no alternate visual world.
// FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {TodoPanel} from 'diary-ui/TodoPanel';
import {PlanCategoryProvider} from 'diary-ui/PlanCategories';
import {I18nProvider} from 'react-aria-components';
import {api} from './planning-rpc';
import {QuickPlan} from './plan-context';
import 'diary-ui/glass-ui.css';
import 'diary-ui/styles.css';
import 'diary-ui/glass-layout.css';
import 'diary-ui/plan-workspace.css';
import 'diary-ui/plan-glass.css';
import 'diary-ui/schedule.css';
import 'diary-ui/schedule-refinements.css';
import './compact-planning.css';
function Planner(){
 const [navigation,setNavigation]=useState<any>(),[action,setAction]=useState<any>(),[revision,setRevision]=useState(0),[navOpen,setNavOpen]=useState(false),[quick,setQuick]=useState<{category?:string}>(),[context,setContext]=useState<any>(),[error,setError]=useState('');
 useEffect(()=>{void api.plannerContext().then(setContext).catch((e:Error)=>setError(e.message));},[revision]);
 useEffect(()=>{const listener=(e:MessageEvent)=>{if(e.source!==parent||e.data?.nonce!==(window as any).__KF_NONCE)return;if(e.data.kind==='kf-refresh')setRevision(v=>v+1);if(e.data.kind==='kf-navigate')setAction({kind:'view',value:e.data.layout,id:Date.now()});if(e.data.kind==='kf-theme')document.documentElement.dataset.theme=e.data.dark?'dark':'light';};const create=(e:Event)=>{if((window as any).__KF_COMPANY){void api.openCompanyTasks();return;}setQuick((e as CustomEvent).detail||{});setNavOpen(false);};const view=(e:Event)=>void api.savePlannerPreferences((e as CustomEvent).detail).catch((e:Error)=>setError(e.message));window.addEventListener('message',listener);window.addEventListener('kf-quick-create',create);window.addEventListener('kf-layout-changed',view);return()=>{window.removeEventListener('message',listener);window.removeEventListener('kf-quick-create',create);window.removeEventListener('kf-layout-changed',view);};},[]);
 const select=(kind:string,value:string)=>{setAction({kind,value,id:Date.now()});setNavOpen(false);};
 const date=new Intl.DateTimeFormat('en-CA').format(new Date());
 return <PlanCategoryProvider><div className="kf-planning-shell"><button className="kf-planning-nav-toggle" aria-expanded={navOpen} onClick={()=>setNavOpen(!navOpen)}>筛选计划</button><aside data-open={navOpen} className="kf-plan-sidebar"><button type="button" className="save-button kf-new-plan" onClick={()=>{if((window as any).__KF_COMPANY){void api.openCompanyTasks();return;}setQuick({});setNavOpen(false);}}>＋ 新建计划</button><nav aria-label="计划状态">{[['all','全部计划'],['today','今日'],['upcoming','即将开始'],['overdue','逾期'],['done','已完成'],['trash','回收站']].map(([id,label])=><button key={id} type="button" aria-pressed={navigation?.filter===id} onClick={()=>select('filter',id)}><span>{label}</span><small>{navigation?.counts[id]??0}</small></button>)}</nav><div className="kf-sidebar-section"><strong>事项类别</strong><nav aria-label="事项类别"><button type="button" aria-pressed={!navigation||navigation.category==='all'} onClick={()=>select('category','all')}>全部类别</button>{navigation?.categories.map((c:any)=><button key={c.id} type="button" aria-pressed={navigation.category===c.id} onClick={()=>select('category',c.id)}><span className="kf-category-dot" style={{background:c.color}}/>{c.name}</button>)}</nav></div><label className="kf-sidebar-section">项目筛选<select aria-label="项目筛选" value={context?.projectFilter||''} onChange={e=>void api.setProjectFilter(e.target.value).then(()=>setRevision(v=>v+1)).catch((e:Error)=>setError(e.message))}><option value="">全部项目</option><option value="__none">未关联项目</option>{context?.projects?.map((p:any)=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label></aside><main>{error&&<p role="alert">{error}</p>}{quick&&<QuickPlan category={quick.category} onClose={()=>setQuick(undefined)} onCreated={()=>{setQuick(undefined);window.dispatchEvent(new Event('kf-created-plan'));void api.setProjectFilter('').then(()=>setRevision(v=>v+1));}}/>}<TodoPanel date={date} entityContext={{entities:[],tags:{person:[],place:[],activity:[],food:[],thing:[]},onCreateTag:async(type,name)=>{await api.addTag(type,name);}}} prepare={async(d)=>{return (await api.loadDiary(d||date)).version;}} changed={async()=>{}} onOpen={ref=>void api.openReference(ref)} onClose={()=>{}} revision={revision} toolbarAction={action} onNavigationChange={setNavigation} fullscreen active/></main></div></PlanCategoryProvider>;
}
createRoot(document.getElementById('app')!).render(<I18nProvider locale="zh-CN"><Planner/></I18nProvider>);
