import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultPlanCategories, planCategorySchema, planViewsSchema,sharedTagSchema,entityTypes, type PlanCategory, type TagStore } from '@diary/contracts';
import { listDiaryDates, loadDiary, readJson, writeJson, withVaultLock } from './vault.js';
import { vaultPaths } from './config.js';

export {sharedTagSchema,planViewSchema,planViewsSchema} from '@diary/contracts';

export async function tagLibrary(typed: TagStore, userId: number) {
  const saved = await readJson<string[]>(`${vaultPaths.system}/shared-tags.json`, [], userId);
  const documents = await Promise.all((await listDiaryDates(userId)).map(async date => (await loadDiary(date, userId)).document));
  const tags = documents.flatMap(document => [
    ...document.todos.flatMap(task => task.tags), ...document.facts.events.flatMap(event => event.tags || []),
    ...Object.values(document.entries || {}).flatMap(entries => entries.flatMap(entry => [...entry.tags, ...entry.sources.flatMap(source => source.tags)])),
    ...document.facts.events.flatMap(event => [...event.people, ...event.places, ...event.activities, ...event.foods].flatMap(entity => entity.tags)),
  ]);
  return [...new Set([...saved, ...tags, ...entityTypes.flatMap(type => typed[type])])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export async function addSharedTag(tag: string, userId: number) {
  await withVaultLock(userId, async () => {
    const path = `${vaultPaths.system}/shared-tags.json`;
    const tags = await readJson<string[]>(path, [], userId);
    await writeJson(path, [...new Set([...tags, sharedTagSchema.parse(tag)])], userId);
  });
}

export const getPlanViews = (userId: number) => readJson<z.infer<typeof planViewsSchema>>(`${vaultPaths.system}/plan-views.json`, [], userId);
export const savePlanViews = (views: unknown, userId: number) => withVaultLock(userId, () => writeJson(`${vaultPaths.system}/plan-views.json`, planViewsSchema.parse(views), userId));

export async function getPlanCategories(userId: number): Promise<PlanCategory[]> {
  const saved = z.array(planCategorySchema).parse(await readJson<unknown>(`${vaultPaths.system}/plan-categories.json`, [], userId));
  const merged = [...defaultPlanCategories.map((c, i) => ({ ...c, order: c.order ?? i })), ...saved.filter(c=>!defaultPlanCategories.some(d=>d.id===c.id))];
  return merged.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function addPlanCategory(input: unknown, userId: number) {
  const data = planCategorySchema.pick({name:true,color:true}).parse(input);
  return withVaultLock(userId, async()=>{
    const categories = await getPlanCategories(userId);
    const normalize = (name:string)=>name.normalize('NFKC').trim().toLocaleLowerCase();
    if(categories.some(c=>normalize(c.name)===normalize(data.name))) throw Object.assign(new Error('已有同名类别，请使用其他名称'),{statusCode:409});
    if(categories.length>=30) throw Object.assign(new Error('最多可设置 30 个计划类别'),{statusCode:400});
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
    const category = planCategorySchema.parse({id:'cat-'+randomUUID(),...data, order: maxOrder + 1});
    const toSave = [...categories.filter(c=>!defaultPlanCategories.some(d=>d.id===c.id)), category];
    await writeJson(`${vaultPaths.system}/plan-categories.json`, toSave, userId);
    return {category,categories: await getPlanCategories(userId)};
  });
}

export async function reorderPlanCategories(ids: string[], userId: number) {
  return withVaultLock(userId, async () => {
    const current = await getPlanCategories(userId);
    const idSet = new Set(ids);
    const ordered = ids.map((id, i) => {
      const c = current.find((c) => c.id === id);
      return c ? { ...c, order: i } : null;
    }).filter((c): c is PlanCategory => c !== null);
    const rest = current.filter((c) => !idSet.has(c.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    let nextOrder = ordered.length;
    for (const c of rest) c.order = nextOrder++;
    const all = [...ordered, ...rest];
    const toSave = all.filter((c) => !defaultPlanCategories.some((d) => d.id === c.id));
    await writeJson(`${vaultPaths.system}/plan-categories.json`, toSave, userId);
    return { categories: await getPlanCategories(userId) };
  });
}
