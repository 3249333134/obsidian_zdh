import { z } from "zod";

export const entityTypes = ["person", "place", "activity", "food", "thing"] as const;
export const entityTypeSchema = z.enum(entityTypes);
export type EntityType = z.infer<typeof entityTypeSchema>;

export const taggedEntitySchema = z.object({
  type: entityTypeSchema,
  name: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});
export type TaggedEntity = z.infer<typeof taggedEntitySchema>;

export const recordRefSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['facts', 'learn', 'input', 'idea', 'todo']), id: z.string().regex(/^[a-zA-Z0-9-]+$/).max(80), summary: z.string().max(2000) });
export type RecordRef = z.infer<typeof recordRefSchema>;

export const attachmentSchema = z.object({ path: z.string().max(500), name: z.string().max(200).default('') });
export type Attachment = z.infer<typeof attachmentSchema>;

export const textEntrySchema = z.object({ task: recordRefSchema.optional(), id: z.string().regex(/^[a-zA-Z0-9-]+$/).max(80), content: z.string().max(50000), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(''), sources: z.array(taggedEntitySchema).default([]), tags: z.array(z.string()).default([]), attachments: z.array(attachmentSchema).max(20).default([]) });
export type TextEntry = z.infer<typeof textEntrySchema>;
export const todoSubtaskSchema = z.object({
  id: z.string().max(80),
  title: z.string().trim().min(1).max(500),
  done: z.boolean().default(false),
});
export type TodoSubtask = z.infer<typeof todoSubtaskSchema>;

export const todoRepeatSchema = z.object({
  type: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom', 'after']),
  interval: z.number().int().positive().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  afterDays: z.number().int().nonnegative().optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/).optional(),
}).nullable();
export type TodoRepeat = z.infer<typeof todoRepeatSchema>;

export const todoAttachmentSchema = z.object({
  name: z.string().max(200),
  type: z.string().max(100).default(''),
  size: z.number().int().nonnegative().default(0),
});
export type TodoAttachment = z.infer<typeof todoAttachmentSchema>;

export const planCategorySchema = z.object({ id: z.string().regex(/^(?:work|personal|cat-[a-f0-9-]{36})$/), name: z.string().trim().min(1).max(30), color: z.string().regex(/^#[0-9a-f]{6}$/i), order: z.number().int().nonnegative().default(0) });
export type PlanCategory = z.infer<typeof planCategorySchema>;
export const defaultPlanCategories: PlanCategory[] = [{id:'work',name:'工作',color:'#7db2df',order:0},{id:'personal',name:'个人生活',color:'#c1a183',order:1}];
export const planCategoryIdSchema = planCategorySchema.shape.id;
export const sharedTagSchema=z.string().trim().min(1).max(40);
export const planViewSchema=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(40),color:z.string().regex(/^#[0-9a-f]{6}$/i),tags:z.array(sharedTagSchema).min(1).max(30)});
export const planViewsSchema=z.array(planViewSchema).max(40);
const baseTodoSchema = z.object({
  category: planCategoryIdSchema.nullable().optional(), important: z.boolean().nullable().optional(), urgent: z.boolean().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/).optional(), startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).optional(),
  id: z.string().regex(/^[a-zA-Z0-9-]+$/).max(80), title: z.string().trim().min(1).max(2000).regex(/^[^\r\n]+$/), done: z.boolean().default(false), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(''),
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/).optional(), source: recordRefSchema.optional(), completion: recordRefSchema.optional(), completedAt: z.string().optional(), operationId: z.string().optional(),
  // 阶段 1 扩展字段
  description: z.string().max(10000).default(''),
  entities: z.array(taggedEntitySchema).max(100).optional(),
  subtasks: z.array(todoSubtaskSchema).max(100).default([]),
  priority: z.string().max(40).default('medium'), // high / medium / low / 自定义
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/).default(''),
  dueTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(''),
  list: z.string().max(80).default(''), // 清单 ID
  tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  status: z.enum(['todo', 'doing', 'done', 'cancelled']).default('todo'),
  repeat: todoRepeatSchema.default(null),
  // 重复系列打卡计数：由服务端按已完成期次自动维护，客户端只读
  checkins: z.number().int().min(0).max(99999).optional(),
  attachments: z.array(todoAttachmentSchema).max(20).default([]),
  createdAt: z.string().default(''),
  deletedAt: z.string().optional(), // 回收站标记
});
export const todoSchema = baseTodoSchema.extend({
  seriesTemplate: baseTodoSchema.optional(),
  recurrenceAnchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  seriesId: z.string().regex(/^[a-zA-Z0-9-]+$/).max(80).optional(),
  occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  occurrenceSuppressed: z.boolean().optional(),
  seriesChanges: z.array(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), stop: z.boolean().default(false), template: baseTodoSchema })).max(100).optional(),
});
export type Todo = z.infer<typeof todoSchema>;

export const eventLocationSchema = z.object({
  name: z.string().max(200).default(""),
  lat: z.number().optional(),
  lng: z.number().optional(),
}).optional();
export type EventLocation = z.infer<typeof eventLocationSchema>;

export const diaryEventSchema = z.object({
  planEntities: z.array(taggedEntitySchema).max(100).optional(),
  plannedStart: z.object({ date: z.string(), time: z.string() }).optional(),
  tags: z.array(z.string()).optional(),
  task: recordRefSchema.optional(),
  id: z.string().min(1).max(80),
  time: z.union([z.literal(""), z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)]).default(""),
  note: z.string().max(10_000).default(""),
  remark: z.string().max(20_000).default(""),
  location: eventLocationSchema,
  people: z.array(taggedEntitySchema).max(100).default([]),
  places: z.array(taggedEntitySchema).max(100).default([]),
  activities: z.array(taggedEntitySchema).max(100).default([]),
  foods: z.array(taggedEntitySchema).max(100).default([]),
  attachments: z.array(attachmentSchema).max(20).default([]),
});
export type DiaryEvent = z.infer<typeof diaryEventSchema>;

export const unknownSectionSchema = z.object({
  heading: z.string().min(1).max(200),
  content: z.string().max(100_000),
});

export const diaryDocumentSchema = z.object({
  recordVersion: z.literal(2).optional(),
  entries: z.object({ learn: z.array(textEntrySchema), input: z.array(textEntrySchema), idea: z.array(textEntrySchema) }).optional(),
  todos: z.array(todoSchema).max(200).default([]),
  todosExtra: z.string().max(50000).default(''),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weather: z.string().max(40).default(""),
  sleep: z.string().max(40).default(""),
  mood: z.string().max(40).default(""),
  facts: z.object({ events: z.array(diaryEventSchema).max(100), note: z.string().max(20_000).default("") }),
  learn: z.object({ sources: z.array(taggedEntitySchema).max(100), content: z.string().max(50_000) }),
  input: z.object({ kind: z.string().max(40), names: z.array(taggedEntitySchema).max(100), excerpt: z.string().max(50_000) }),
  idea: z.object({ tags: z.array(z.string().trim().min(1).max(40)).max(100), content: z.string().max(50_000) }),
  unknownFrontmatter: z.record(z.unknown()).default({}),
  unknownSections: z.array(unknownSectionSchema).default([]),
}).superRefine((document,context)=>{
  if(!document.entries)return;
  const projected=projectEntries(document);
  for(const [kind,key] of [['learn','content'],['input','excerpt'],['idea','content']] as const){
    const original=kind==='input'?document.input.excerpt:document[kind].content;
    const combined=kind==='input'?projected.input.excerpt:projected[kind].content;
    const maximum=fieldLimit(diaryDocumentSchema,`${kind}.${key}`)!;
    if(original.length<=maximum&&combined.length>maximum)context.addIssue({code:'too_big',type:'string',maximum,inclusive:true,path:[kind,key],message:'合并正文超过上限'});
  }
});
export type DiaryDocument = z.infer<typeof diaryDocumentSchema>;

export type FieldIssue = { path: string; message: string; code: string; maximum?: number; minimum?: number };
const FIELD_NAMES: Record<string, string> = { facts: '事实', events: '事件', note: '备注', remark: '事件备注', learn: '新知', input: '输入', idea: '灵感', content: '正文', excerpt: '正文', name: '名称', title: '标题', description: '详情描述', tags: '标签', people: '人物', places: '地点', activities: '活动', foods: '食物', sources: '来源', time: '时间', weather: '天气', sleep: '睡眠', mood: '心情', kind: '类型', list: '清单', todos: '计划', entries: '记录', attachments: '附件' };
export function fieldName(path: string): string {
  return path.split('.').map(key => /^\d+$/.test(key) ? `第 ${Number(key) + 1} 条` : FIELD_NAMES[key] || key).join(' · ');
}
export function validationIssues(issues: z.ZodIssue[]): FieldIssue[] {
  return issues.map(issue => {
    const path = issue.path.join('.');
    const maximum = issue.code === 'too_big' ? Number(issue.maximum) : undefined;
    const minimum = issue.code === 'too_small' ? Number(issue.minimum) : undefined;
    const detail = maximum != null ? `最多 ${maximum.toLocaleString('zh-CN')} ${issue.code === 'too_big' && issue.type === 'array' ? '项' : '字符'}` : minimum != null ? '内容不能为空或数量不足' : '格式不正确，请检查';
    return { path, code: issue.code, maximum, minimum, message: `${fieldName(path)}${issue.message==='合并正文超过上限'?'（合并后）':''}：${detail}` };
  });
}
/** Read the limits from the schema itself so client hints and API checks cannot drift. */
export function fieldLimit(schema: z.ZodTypeAny, path: string): number | undefined {
  let current = schema;
  const unwrap = () => { while (current instanceof z.ZodDefault || current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodEffects) current = current instanceof z.ZodDefault ? current.removeDefault() : current instanceof z.ZodEffects?current.innerType():current.unwrap(); };
  for (const key of path.split('.')) {
    unwrap();
    if (current instanceof z.ZodObject) current = current.shape[key];
    else if (current instanceof z.ZodArray) current = current.element;
    else return undefined;
    if (!current) return undefined;
  }
  unwrap();
  return current instanceof z.ZodString ? current._def.checks.find(check => check.kind === 'max')?.value : undefined;
}
export const DIARY_BODY_LIMIT = 10_485_760;
export function validateDiary(document: unknown): FieldIssue[] {
  const result = diaryDocumentSchema.safeParse(document);
  const issues = result.success ? [] : validationIssues(result.error.issues);
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > DIARY_BODY_LIMIT) issues.push({ path: '', code: 'body_too_large', message: '整份日记超过请求大小限制，请减少附件信息或拆分记录' });
  return issues;
}
export function validationMessage(error: unknown, fallback='内容格式不正确'): string {
  if(error instanceof z.ZodError) return validationIssues(error.issues)[0]?.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

export const textKinds = ['learn', 'input', 'idea'] as const;
export type TextKind = typeof textKinds[number];
export function entryText(entry: TextEntry): string { return `${entry.time ? `[${entry.time}] ` : ''}${entry.content}`; }
export function projectEntries(document: DiaryDocument): DiaryDocument {
  if (!document.entries) return document;
  return { ...document, recordVersion: 2, learn: { ...document.learn, content: document.entries.learn.map(entryText).join('\n\n') }, input: { ...document.input, excerpt: document.entries.input.map(entryText).join('\n\n') }, idea: { ...document.idea, content: document.entries.idea.map(entryText).join('\n\n') } };
}
export function resolveRecord(document: DiaryDocument, ref: RecordRef): string | undefined {
  if (ref.kind === 'facts') return document.facts.events.find(e => e.id === ref.id)?.note;
  if (ref.kind === 'todo') return document.todos.find(t => t.id === ref.id)?.title;
  return document.entries?.[ref.kind].find(e => e.id === ref.id)?.content;
}

export type DiaryResponse = { document: DiaryDocument; version: string; exists: boolean; savedAt?: string; warning?: { code: string; message: string } };

export type EntityRelation = { key: string; type: EntityType; name: string; count: number; dates: string[] };
export type EntityRecord = {
  parentKey?: string;
  occurrences?: Array<{ key: string; date: string; time: string; note: string; index: number }>;
  key: string;
  type: EntityType;
  name: string;
  tags: string[];
  mentions: string[];
  eventRelations: EntityRelation[];
  dayRelations: EntityRelation[];
};

export type TagStore = Record<EntityType, string[]>;
export const placeParentSchema = z.object({ key: z.string().startsWith("place|"), parentKey: z.string().startsWith("place|").nullable() });

export const tagCreateSchema = z.object({ type: entityTypeSchema, name: z.string().trim().min(1).max(40) });

export const weeklySummaryRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  useAi: z.boolean().optional(),
});

export const sentenceSplitRequestSchema = z.object({
  sentence: z.string().trim().min(1).max(2_000),
});

export const sentenceSplitResultSchema = z.object({
  people: z.array(taggedEntitySchema.extend({ type: z.literal("person") })).max(30),
  places: z.array(taggedEntitySchema.extend({ type: z.literal("place") })).max(30),
  activities: z.array(taggedEntitySchema.extend({ type: z.literal("activity") })).max(30),
  foods: z.array(taggedEntitySchema.extend({ type: z.literal("food") })).max(30),
});
export type SentenceSplitResult = z.infer<typeof sentenceSplitResultSchema>;

export const quickFactSchema = z.object({
  id: z.string().max(80).optional(),
  source: z.enum(["auto", "pinned"]),
  label: z.string().max(200),
  shortLabel: z.string().max(20).optional(),
  count: z.number().int().nonnegative(),
  note: z.string().max(2000).default(""),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(""),
  activities: z.array(taggedEntitySchema.extend({ type: z.literal("activity") })).max(30),
  places: z.array(taggedEntitySchema.extend({ type: z.literal("place") })).max(30).default([]),
  people: z.array(taggedEntitySchema.extend({ type: z.literal("person") })).max(30).default([]),
  foods: z.array(taggedEntitySchema.extend({ type: z.literal("food") })).max(30).default([]),
  lastUsedAt: z.string().optional(),
});
export type QuickFact = z.infer<typeof quickFactSchema>;

export const pinQuickFactRequestSchema = z.object({
  label: z.string().trim().min(1).max(200),
  note: z.string().max(2000).default(""),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(""),
  activities: z.array(taggedEntitySchema.extend({ type: z.literal("activity") })).max(30).min(1),
  places: z.array(taggedEntitySchema.extend({ type: z.literal("place") })).max(30).default([]),
  people: z.array(taggedEntitySchema.extend({ type: z.literal("person") })).max(30).default([]),
  foods: z.array(taggedEntitySchema.extend({ type: z.literal("food") })).max(30).default([]),
});
export type PinQuickFactRequest = z.infer<typeof pinQuickFactRequestSchema>;

export function emptyDiary(date: string): DiaryDocument {
  return {
    todos: [],
    todosExtra: '',
    date,
    weather: "",
    sleep: "",
    mood: "",
    facts: { events: [], note: "" },
    learn: { sources: [], content: "" },
    input: { kind: "书", names: [], excerpt: "" },
    idea: { tags: [], content: "" },
    unknownFrontmatter: {},
    unknownSections: [],
  };
}

export function normalizeEntityName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

export function entityKey(type: EntityType, name: string): string {
  return `${type}|${normalizeEntityName(name)}`;
}

const captureDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/);
export const captureDraftSchema = z.object({
  repeat: todoRepeatSchema.default(null),
  category: planCategoryIdSchema.nullable().optional(), important: z.boolean().nullable().optional(), urgent: z.boolean().nullable().optional(),
  startDate: captureDate.optional(), startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).optional(),
  id: z.string().uuid(), kind: z.enum(['plan', 'facts', 'learn', 'input', 'idea']),
  date: captureDate.default(''), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/).default(''),
  content: z.string().trim().min(1).max(10000), description: z.string().max(10000).default(''),
  priority: z.enum(['high', 'medium', 'low']).default('medium'), list: z.string().max(80).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  entities: sentenceSplitResultSchema.default({ people: [], places: [], activities: [], foods: [] }),
  needsReview: z.boolean().default(false), reviewReason: z.string().max(500).default(''),
});
export type CaptureDraft = z.infer<typeof captureDraftSchema>;
export const captureRequestSchema = z.object({ text: z.string().trim().min(1).max(10000),
  completion: z.object({ title: z.string().max(2000), description: z.string().max(10000), date: captureDate, time: z.string().max(5) }).optional() });
export const completionRecordSchema = captureDraftSchema.extend({ kind: z.enum(['facts', 'learn', 'input', 'idea']), version: z.string() });
export type CompletionRecord = z.infer<typeof completionRecordSchema>;

/** Append only: the draft ID survives retries and is used as the record ID. */
export function appendCapture(document: DiaryDocument, draft: CaptureDraft, task?: RecordRef): DiaryDocument {
  if (draft.kind === 'plan') throw new Error('计划须通过行动接口保存');
  const all = [...document.facts.events, ...(document.entries?.learn || []), ...(document.entries?.input || []), ...(document.entries?.idea || [])];
  if (all.some(e => e.id === draft.id)) return document;
  if (draft.kind === 'facts') document.facts.events.push({ id: draft.id, note: draft.content, remark: draft.description, time: draft.time, ...draft.entities, tags: draft.tags, attachments: [], task });
  else {
    if (!document.entries) {
      const legacy = (kind: TextKind, content: string): TextEntry[] => content ? [{ id: 'legacy-' + kind, content, time: '', sources: kind === 'learn' ? document.learn.sources : kind === 'input' ? document.input.names : [], tags: kind === 'idea' ? document.idea.tags : [], attachments: [] }] : [];
      document.entries = { learn: legacy('learn', document.learn.content), input: legacy('input', document.input.excerpt), idea: legacy('idea', document.idea.content) };
    }
    document.entries[draft.kind].push({ id: draft.id, content: draft.content, time: draft.time, sources: Object.values(draft.entities).flat(), tags: draft.tags, attachments: [], task });
  }
  return projectEntries(document);
}
