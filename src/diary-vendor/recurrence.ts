import { createHash } from 'node:crypto';
import { todoSchema, type DiaryDocument, type Todo, type TodoRepeat } from './contracts';
import { addDays, assertDate, weekStart } from './date';

/** 在日记文档内按已完成期次重算每个重复系列的打卡数（幂等，完成/取消/删除期次都安全） */
export function syncSeriesCheckins(document: DiaryDocument) {
  const todos = document.todos;
  for (const root of todos) {
    if (!root.recurrenceAnchor || root.deletedAt) continue;
    const count = todos.filter(t => t.seriesId === root.id && t.done && !t.deletedAt).length + (root.done ? 1 : 0);
    if (count > 0 || root.checkins) root.checkins = count;
  }
}

export const isSeries = (task: Todo) => !!task.recurrenceAnchor && ['daily','weekly','monthly'].includes(task.seriesTemplate?.repeat?.type || task.repeat?.type || '');
export function firstOccurrence(date:string,repeat:TodoRepeat) {
  if(!repeat||!['daily','weekly','monthly'].includes(repeat.type))return date;
  const probe=todoSchema.parse({id:'repeat-probe',title:'重复日程',dueDate:date,recurrenceAnchor:date,repeat:{...repeat,interval:1}});
  let first=assertDate(date);
  for(let i=0;i<366&&!occursOn(probe,first);i++)first=addDays(first,1);
  if(!occursOn(probe,first))throw Object.assign(new Error('重复规则没有有效的首次日期，请检查结束日期'),{statusCode:400});
  return first;
}
export function occurrenceId(series: string, date: string) {
  return `occ-${createHash('sha256').update(`${series}:${date}`).digest('hex').slice(0,32)}`;
}
export function templateAt(root: Todo, date: string) {
  let template: Todo = todoSchema.parse(root.seriesTemplate || root), anchor = root.recurrenceAnchor!;
  let stopped=false;
  for (const change of [...(root.seriesChanges || [])].sort((a,b)=>a.from.localeCompare(b.from))) {
    if (change.from > date) break;
    stopped=change.stop;
    template = todoSchema.parse(change.template); anchor = template.dueDate || change.from;
  }
  return stopped?null:{template,anchor};
}
export function occursOn(root: Todo, date: string) {
  assertDate(date);
  if (!isSeries(root) || date < root.recurrenceAnchor! || root.deletedAt) return false;
  const current=templateAt(root,date); if(!current)return false;
  const {template,anchor}=current, rule=template.repeat;
  if (!rule || rule.type==='none' || (rule.until && date>rule.until)) return false;
  const days=(Date.parse(date+'T00:00:00Z')-Date.parse(anchor+'T00:00:00Z'))/86400000;
  if(days<0)return false;
  const interval=rule.interval||1;
  if(rule.type==='daily')return days%interval===0;
  if(rule.type==='weekly') {
    const weeks=(Date.parse(weekStart(date)+'T00:00:00Z')-Date.parse(weekStart(anchor)+'T00:00:00Z'))/604800000;
    return weeks%interval===0 && (rule.weekdays?.length?rule.weekdays:[new Date(anchor+'T00:00:00Z').getUTCDay()]).includes(new Date(date+'T00:00:00Z').getUTCDay());
  }
  if(rule.type==='monthly') {
    const [y,m,d]=date.split('-').map(Number),[ay,am,ad]=anchor.split('-').map(Number);
    return ((y-ay)*12+m-am)%interval===0 && d===Math.min(rule.monthDay||ad,new Date(Date.UTC(y,m,0)).getUTCDate());
  }
  return false;
}
export function deriveOccurrence(root: Todo, date: string): Todo | null {
  if(!occursOn(root,date))return null;
  const {template,anchor}=templateAt(root,date)!;
  const offset=template.startDate ? (Date.parse(template.startDate+'T00:00:00Z')-Date.parse(anchor+'T00:00:00Z'))/86400000 : null;
  return todoSchema.parse({...template,id:occurrenceId(root.id,date),seriesId:root.id,occurrenceDate:date,
    recurrenceAnchor:undefined,seriesTemplate:undefined,seriesChanges:undefined,repeat:template.repeat,
    dueDate:date,plannedDate:'',time:'',startDate:offset===null?'':addDays(date,offset),checkins:root.checkins,
    done:false,status:'todo',completion:undefined,completedAt:undefined,operationId:undefined,deletedAt:undefined});
}
