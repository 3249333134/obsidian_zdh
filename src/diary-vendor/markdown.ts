import YAML from "yaml";
import { emptyDiary, projectEntries, recordRefSchema, textEntrySchema, textKinds, todoSchema, type DiaryDocument, type DiaryEvent, type EntityType, type TaggedEntity } from "./contracts";
import { createHash } from 'node:crypto';

const stableId = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
function metadata(text: string): Record<string, unknown> {
  const raw = text.match(/<!-- diary-links:([A-Za-z0-9+/=]+) -->/)?.[1];
  if (!raw) return {};
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return {}; }
}
const links = (value: unknown) => `<!-- diary-links:${Buffer.from(JSON.stringify(value)).toString('base64')} -->`;

/** 返回 Obsidian 友好的 markdown 行：图片用 ![[path]]，非图片用 [name](path) */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
function attachmentMarkdown(attachments: Array<{ path: string; name: string }>): string[] {
  if (!attachments?.length) return [];
  return attachments.map((a) => {
    const ext = (a.path.split(".").pop() || "").toLowerCase();
    if (IMAGE_EXTS.has(ext)) return `![[${a.path}]]`;
    return `[${a.name || ext.toUpperCase()}](${a.path})`;
  });
}

const KNOWN_HEADINGS = new Set(["今日事实", "今日新知", "输入记录", "灵感碎片", "待办清单"]);

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content };
  try {
    return { data: (YAML.parse(match[1]) as Record<string, unknown>) || {}, body: content.slice(match[0].length) };
  } catch {
    return { data: {}, body: content.slice(match[0].length) };
  }
}

function sectionsOf(body: string): Array<{ heading: string; content: string }> {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => ({
    heading: match[1].trim(),
    content: body.slice((match.index || 0) + match[0].length, matches[index + 1]?.index ?? body.length).trim(),
  }));
}

function cleanPrompt(content: string): string {
  return content.replace(/^>.*(?:\r?\n|$)/, "").trim();
}

function parseField(content: string, labels: string[]): string {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`^-\\s+(?:${escaped})[：:][ \\t]*(.*)$`, "m");
  const match = regex.exec(content);
  if (!match) return "";
  const rest = content.slice((match.index || 0) + match[0].length);
  const continuation: string[] = [];
  for (const line of rest.replace(/^\r?\n/, '').split(/\r?\n/)) {
    if (/^(?:-|#{2,3}\s)/.test(line)) break;
    continuation.push(line.replace(/^\s{2}/, ""));
  }
  return [match[1], ...continuation].join("\n").trim();
}

export function parseTaggedList(value: string, type: EntityType): TaggedEntity[] {
  return value.split(/、/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^([^\[]+?)(?:\s*\[([^\]]*)\])?$/);
    const name = (match?.[1] || part).trim();
    const tags = (match?.[2] || "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    return { type, name, tags };
  }).filter((item) => item.name);
}

function parseEvent(block: string, legacy = false): DiaryEvent {
  const meta = metadata(block);
  const locName = parseField(block, ["定位", "位置"]);
  const locMeta = meta.location as { lat?: number; lng?: number } | undefined;
  const attachments = Array.isArray(meta.attachments) ? meta.attachments.filter((a: any) => a && typeof a.path === 'string').map((a: any) => ({ path: a.path, name: a.name || '' })) : [];
  return {
    id: block.match(/<!-- diary-event:([a-zA-Z0-9-]+) -->/)?.[1] || stableId(block),
    task: recordRefSchema.safeParse(meta.task).success ? recordRefSchema.parse(meta.task) : undefined,
    plannedStart: meta.plannedStart as DiaryEvent['plannedStart'],
    planEntities: meta.planEntities as DiaryEvent['planEntities'],
    tags: Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    time: parseField(block, ["时间"]),
    note: parseField(block, ["描述", "一句话"]),
    remark: parseField(block, ["事件备注"]),
    location: locName || locMeta?.lat != null ? { name: locName, lat: locMeta?.lat, lng: locMeta?.lng } : undefined,
    people: parseTaggedList(parseField(block, legacy ? ["见谁", "和谁"] : ["和谁", "见谁"]), "person"),
    places: parseTaggedList(parseField(block, legacy ? ["去哪", "在哪"] : ["在哪", "去哪"]), "place"),
    activities: parseTaggedList(parseField(block, ["做了什么"]), "activity"),
    foods: parseTaggedList(parseField(block, ["吃了什么"]), "food"),
    attachments,
  };
}

function parseEvents(content: string): DiaryEvent[] {
  if (/^###\s+事件/m.test(content)) {
    return content.split(/^###\s+事件[^\r\n]*$/m).slice(1).map((part) => parseEvent(part)).filter(hasEventContent);
  }
  const event = parseEvent(content, true);
  return hasEventContent(event) ? [event] : [];
}

function hasEventContent(event: DiaryEvent): boolean {
  return Boolean(event.time || event.note || event.remark || event.location?.name || event.people.length || event.places.length || event.activities.length || event.foods.length || event.attachments.length);
}

export function parseDiaryMarkdown(content: string, date: string): DiaryDocument {
  const { data, body } = parseFrontmatter(content);
  const document = emptyDiary(date);
  document.weather = typeof data.weather === "string" ? data.weather : "";
  document.sleep = typeof data.sleep === "string" ? data.sleep : "";
  document.mood = typeof data.mood === "string" ? data.mood : "";
  const { date: _date, type: _type, weather: _weather, sleep: _sleep, mood: _mood, tags: _tags, ...unknown } = data;
  document.unknownFrontmatter = unknown;

  for (const section of sectionsOf(body)) {
    const clean = cleanPrompt(section.content);
    if (section.heading === "待办清单") {
      const extra: string[] = [];
      for (const line of section.content.split(/\r?\n/)) {
        const task = line.replace(/ <!-- diary-links:[A-Za-z0-9+/=]+ -->/, '').match(/^- \[([ xX])\] (?:\[((?:[01]\d|2[0-3]):[0-5]\d)\] )?(.+?)(?: <!-- diary-task:([a-zA-Z0-9-]+) -->)?$/);
        if (task && task[3].trim()) document.todos.push(todoSchema.parse({ ...metadata(line), id: task[4] || stableId(`${date}:${line}`), done: task[1].toLowerCase() === 'x', time: task[2] || '', title: task[3].trim() }));
        else if (line.trim() !== '---') extra.push(line);
      }
      document.todosExtra = extra.join('\n').trim();
    } else if (section.heading === "今日事实") {
      document.facts.events = parseEvents(clean);
      document.facts.note = parseField(clean, ["备注"]);
    } else if (section.heading === "今日新知") {
      document.learn.sources = parseTaggedList(parseField(clean, ["来源"]), "thing");
      document.learn.content = parseField(clean, ["内容"]);
    } else if (section.heading === "输入记录") {
      document.input.kind = parseField(clean, ["类型"]) || "书";
      document.input.names = parseTaggedList(parseField(clean, ["名称"]), "thing");
      document.input.excerpt = parseField(clean, ["片段", "片段/句子"]);
    } else if (section.heading === "灵感碎片") {
      document.idea.tags = parseField(clean, ["标签"]).split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean);
      document.idea.content = parseField(clean, ["内容"]);
    } else if (!KNOWN_HEADINGS.has(section.heading)) {
      document.unknownSections.push(section);
    }
  }
  document.entries = { learn: [], input: [], idea: [] };
  for (const kind of textKinds) {
    const value = kind === 'input' ? document.input.excerpt : document[kind].content;
    const blocks = value.includes('<!-- diary-record:') ? value.split(/(?=<!-- diary-record:)/).filter(v => v.trim()) : value.split(/\n\s*\n/).filter(v => v.trim());
    document.entries[kind] = blocks.map((block, index) => {
      const id = block.match(/<!-- diary-record:([a-zA-Z0-9-]+) -->/)?.[1] || stableId(`${date}:${kind}:${index}:${block}`);
      const clean = block.replace(/<!-- diary-record:[a-zA-Z0-9-]+ -->\s*/, '').replace(/<!-- diary-links:[A-Za-z0-9+/=]+ -->\s*/, '').trim();
      const time = clean.match(/^\[((?:[01]\d|2[0-3]):[0-5]\d)\]\s*/);
      const meta = metadata(block);
      const attachments = Array.isArray(meta.attachments) ? meta.attachments.filter((a: any) => a && typeof a.path === 'string').map((a: any) => ({ path: a.path, name: a.name || '' })) : [];
      return textEntrySchema.parse({ task: meta.task, id, content: time ? clean.slice(time[0].length) : clean, time: time?.[1] || '', sources: meta.sources || (kind === 'learn' ? document.learn.sources : kind === 'input' ? document.input.names : []), tags: meta.tags || (kind === 'idea' ? document.idea.tags : []), attachments });
    });
  }
  // Strip metadata from fact text; markers are not user remarks.
  for (const event of document.facts.events) for (const key of ['note', 'remark'] as const) event[key] = event[key].replace(/\n?<!-- diary-(?:event|links):[^>]+ -->/g, '').trim();
  return projectEntries(document);
}

function formatTagged(items: TaggedEntity[]): string {
  return items.map((item) => item.tags.length ? `${item.name} [${item.tags.join(",")}]` : item.name).join("、");
}

function field(label: string, value: string): string {
  const [first = "", ...rest] = value.trim().split(/\r?\n/);
  return `- ${label}：${first}${rest.length ? `\n${rest.map((line) => `  ${line}`).join("\n")}` : ""}`;
}

export function serializeDiaryMarkdown(document: DiaryDocument): string {
  document = structuredClone(projectEntries(document));
  for (const kind of textKinds) if (document.entries) {
    const text = document.entries[kind].map(e => {
      const meta: Record<string, unknown> = { sources: e.sources, tags: e.tags, task: e.task };
      if (e.attachments.length) meta.attachments = e.attachments;
      const obsidianAttach = attachmentMarkdown(e.attachments).join('\n');
      const body = `${e.time ? `[${e.time}] ` : ''}${e.content}${obsidianAttach ? '\n' + obsidianAttach : ''}`;
      return `<!-- diary-record:${e.id} -->\n${links(meta)}\n${body}`;
    }).join('\n\n');
    if (kind === 'input') document.input.excerpt = text; else document[kind].content = text;
  }
  const frontmatter: Record<string, unknown> = {
    ...document.unknownFrontmatter,
    date: document.date,
    type: "diary",
    ...(document.weather ? { weather: document.weather } : {}),
    ...(document.sleep ? { sleep: document.sleep } : {}),
    ...(document.mood ? { mood: document.mood } : {}),
    tags: ["日记", "马伯庸日记法"],
  };
  const lines = ["---", YAML.stringify(frontmatter).trimEnd(), "---", "", `# 日记 · ${document.date}`];
  const meta = [document.weather && `天气：${document.weather}`, document.sleep && `睡眠：${document.sleep}`, document.mood && `情绪：${document.mood}`].filter(Boolean).join("　");
  if (meta) lines.push(`> ${meta}`);
  lines.push("", "## 今日事实", "> 主谓宾事件：和谁、在哪、做了什么、吃了什么。", "");
  document.facts.events.forEach((event, index) => {
    lines.push(`### 事件 ${index + 1}`);
    lines.push(`<!-- diary-event:${event.id} -->`);
    const meta: Record<string, unknown> = {};
    if (event.task) meta.task = event.task;
    if (event.plannedStart) meta.plannedStart = event.plannedStart;
    if (event.planEntities?.length) meta.planEntities = event.planEntities;
    if (event.tags?.length) meta.tags = event.tags;
    if (event.location?.lat != null && event.location?.lng != null) meta.location = { lat: event.location.lat, lng: event.location.lng };
    if (event.attachments.length) meta.attachments = event.attachments;
    if (Object.keys(meta).length) lines.push(links(meta));
    if (event.time) lines.push(field("时间", event.time));
    if (event.note.trim()) lines.push(field("描述", event.note));
    if (event.remark.trim()) lines.push(field("事件备注", event.remark));
    if (event.location?.name) lines.push(field("定位", event.location.name));
    lines.push(field("和谁", formatTagged(event.people)));
    lines.push(field("在哪", formatTagged(event.places)));
    lines.push(field("做了什么", formatTagged(event.activities)));
    lines.push(field("吃了什么", formatTagged(event.foods)));
    // Obsidian 友好的附件行（保留 base64 links 注释供 web app 反序列化）
    if (event.attachments.length) lines.push(...attachmentMarkdown(event.attachments));
    lines.push("");
  });
  if (document.facts.note.trim()) lines.push(field("备注", document.facts.note), "");
  lines.push("## 今日新知", "> 今天听到或学到的新知识、观点与见闻。", "");
  if (document.learn.sources.length) lines.push(field("来源", formatTagged(document.learn.sources)));
  if (document.learn.content.trim()) lines.push(field("内容", document.learn.content));
  lines.push("", "## 输入记录", "> 读过、看过或听过的内容，以及值得留下的片段。", "", field("类型", document.input.kind));
  if (document.input.names.length) lines.push(field("名称", formatTagged(document.input.names)));
  if (document.input.excerpt.trim()) lines.push(field("片段", document.input.excerpt));
  lines.push("", "## 灵感碎片", "> 捕捉尚未成形的想法、疑问与线索。", "");
  if (document.idea.tags.length) lines.push(field("标签", document.idea.tags.join("，")));
  if (document.idea.content.trim()) lines.push(field("内容", document.idea.content));
  if (document.todos?.length || document.todosExtra) {
    lines.push('', '## 待办清单', '');
    for (const task of document.todos || []) lines.push(`- [${task.done ? 'x' : ' '}] ${task.time ? `[${task.time}] ` : ''}${task.title} <!-- diary-task:${task.id} --> ${links({ ...task, id: undefined, title: undefined, done: undefined, time: undefined })}`);
    if (document.todosExtra) lines.push('', document.todosExtra);
  }
  for (const section of document.unknownSections) lines.push("", `## ${section.heading}`, section.content);
  lines.push("", "---", "");
  return lines.join("\n");
}
