export const PROJECT_VIEW = 'knowledge-flow-projects';
export const PROJECT_ROOT = '03_BUILD-项目沉淀/项目管理';
export const REVIEW_ROOT = '01_UNDERSTAND-理解层/周复盘';
export type ProjectStatus = 'planned' | 'active' | 'paused' | 'completed' | 'archived';
export type ProjectTaskStatus = 'todo' | 'doing' | 'done' | 'canceled';
export interface Project {
  id: string; path: string; hash: string; title: string; goal: string; category: string; status: ProjectStatus;
  createdAt: string; updatedAt: string; notes: string[];
}
export interface ProjectTask {
  roleId?:string;
  plan?: import('./diary-vendor/contracts').Todo; planDate?: string;
  id: string; path: string; hash: string; title: string; projectId: string; category: string;
  status: ProjectTaskStatus; priority: 'high' | 'normal' | 'low';
  plannedDate?: string; startTime?: string; endDate?: string; endTime?: string; dueDate?: string;
  createdAt: string; updatedAt: string; completedAt?: string; sources: string[]; actionKey?: string;
}
export interface ProjectSuggestion {
  roleContext?:import('./role-workflow').RoleContext;
  id: string; sourcePath: string; sourceHash: string; projectId?: string; projectTitle?: string;
  reason: string; actions: Array<{ title: string; reason: string; evidence: string; selected: boolean }>;
  status: 'pending' | 'accepted' | 'stale'; createdAt: string;
  draftTaskId?: string; materialHash?: string;
  selected?: boolean;
}
export interface ProjectOperation {
  roleReviewRoot?:string;
  id: string; label: string; status: 'pending' | 'done'; paths: string[]; error?: string;
  writes: Array<{ path: string; content: string; expectedHash?: string }>;
}
export interface ProjectReviewDraft {
  roleContext?:import('./role-workflow').RoleContext;
  id: string; title: string; body: string; projectIds: string[]; from: string; to: string;
  sources: Array<{ path: string; hash: string }>; createdAt: string; notePath?: string;
}
export interface ProjectState {
  categories: string[]; suggestions: ProjectSuggestion[]; operations: ProjectOperation[]; reviews: ProjectReviewDraft[];
}
export const defaultProjectState = (): ProjectState => ({ categories: ['工作', '个人生活'], suggestions: [], operations: [], reviews: [] });
export const PROJECT_STATUS: Record<ProjectStatus, string> = { planned: '计划中', active: '进行中', paused: '暂停', completed: '已完成', archived: '已归档' };
export const PROJECT_TASK_STATUS: Record<ProjectTaskStatus, string> = { todo: '待办', doing: '进行中', done: '已完成', canceled: '已取消' };
export function localDay(date = new Date()): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
export function dayDate(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期应为 YYYY-MM-DD。');
  const [y, m, d] = day.split('-').map(Number), date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new Error('日期不存在。');
  return date;
}
export function addDays(day: string, count: number): string { const date = dayDate(day); date.setDate(date.getDate() + count); return localDay(date); }
export function weekStart(day = localDay()): string { const date = dayDate(day); return addDays(day, -((date.getDay() + 6) % 7)); }
export function overdue(task: ProjectTask, today = localDay()) { return !['done', 'canceled'].includes(task.status) && Boolean(task.dueDate && task.dueDate < today); }
export function taskMatches(task: ProjectTask, filter: string, today = localDay()) {
  if (filter === 'all') return task.status !== 'canceled';
  if (filter === 'done') return task.status === 'done';
  if (filter === 'canceled') return task.status === 'canceled';
  if (filter === 'overdue') return overdue(task, today);
  if (['done', 'canceled'].includes(task.status)) return false;
  if (filter === 'today') return onDay(task, today) || task.dueDate === today;
  if (filter === 'upcoming') return Boolean(task.dueDate && task.dueDate > today && task.dueDate <= addDays(today, 7));
  return task.status === filter;
}
export function completion(tasks: ProjectTask[]): number { const active = tasks.filter(t => t.status !== 'canceled'&&!t.plan?.deletedAt&&!t.plan?.occurrenceSuppressed); return active.length ? Math.round(active.filter(t => t.status === 'done').length / active.length * 100) : 0; }
export function onDay(task: ProjectTask, day: string): boolean { return Boolean(task.plannedDate && task.plannedDate <= day && (task.endDate || task.plannedDate) >= day && !(task.endTime === '00:00' && task.endDate === day && task.plannedDate < day)); }
export function moveSchedule(task: ProjectTask, day: string, time?: string): ProjectTask {
  dayDate(day); const previous = task.plannedDate, end = task.endDate;
  const utc = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const durationDays = previous && end ? Math.round((utc(end) - utc(previous)) / 86400000) : 0;
  const result = { ...task, plannedDate: day, endDate: end ? addDays(day, durationDays) : undefined };
  if (time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('执行时间无效。');
    const startMinutes = task.startTime ? Number(task.startTime.slice(0, 2)) * 60 + Number(task.startTime.slice(3)) : undefined;
    const endMinutes = task.endTime ? durationDays * 1440 + Number(task.endTime.slice(0, 2)) * 60 + Number(task.endTime.slice(3)) : undefined;
    result.startTime = time;
    if (startMinutes !== undefined && endMinutes !== undefined) {
      const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + endMinutes - startMinutes;
      result.endDate = addDays(day, Math.floor(minutes / 1440)); result.endTime = `${String(Math.floor(minutes % 1440 / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }
  }
  return result;
}
