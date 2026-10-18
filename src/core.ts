import type { Analysis, Destination } from './types';
export function safePath(value: string): string {
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /[\u0000-\u001f:*?"<>|]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ') || /^\.(obsidian|git)$/i.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)))
    throw new Error('目录必须是当前笔记库内的相对路径，不能指向系统目录。');
  return path;
}
export function safeName(value: string): string {
  let name = value.replace(/[\u0000-\u001f\\/:*?"<>|#\[\]]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = '文档-' + (name || '未命名');
  return name;
}
export function splitText(text: string, size: number): string[] {
  if (!Number.isInteger(size) || size < 1000 || size > 30000) throw new Error('分块大小应为 1000–30000 个字符。');
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary > start + size / 2) end = boundary + 1;
      if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
export function parseAnalysis(raw: string, destinations: Destination[]): Analysis {
  let object: unknown;
  try { object = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('AI 返回的内容不是有效 JSON，请重试或更换模型。'); }
  if (!object || typeof object !== 'object') throw new Error('AI 返回格式不完整。');
  const o = object as Record<string, unknown>;
  for (const key of ['title', 'summary', 'destinationId', 'reason', 'body'])
    if (typeof o[key] !== 'string' || !(o[key] as string).trim()) throw new Error(`AI 返回缺少 ${key}，请重试。`);
  for (const key of ['tags', 'keyPoints'])
    if (!Array.isArray(o[key]) || !(o[key] as unknown[]).every(x => typeof x === 'string')) throw new Error(`AI 返回的 ${key} 格式错误。`);
  if (!destinations.some(d => d.enabled && d.id === o.destinationId)) throw new Error('AI 推荐了未配置的目标库，请重试；不会写入该位置。');
  return { title: (o.title as string).trim(), summary: o.summary as string, body: o.body as string,
    reason: o.reason as string, destinationId: o.destinationId as string,
    tags: normalizeTags(o.tags as string[]), keyPoints: o.keyPoints as string[] };
}
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(t => t.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\-/]/gu, '').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '')).filter(t => t && !/^\d+$/.test(t)))].slice(0, 20);
}
export function endpoint(base: string): string {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new Error('接口地址不是有效 URL。'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('请使用不含密码、参数的 HTTP(S) 接口地址。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程服务请使用 HTTPS；HTTP 仅用于本机模型。');
  return url.toString().replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
}
export function renderNote(a: Analysis, source: string, createdAt: string, archivedAt: string, destination: string, id: string): string {
  const q = JSON.stringify;
  return `---\nknowledge_flow_id: ${q(id)}\ntags: ${q(normalizeTags(a.tags))}\nsource: ${q(source)}\nimported_at: ${q(createdAt)}\narchived_at: ${q(archivedAt)}\ndestination: ${q(destination)}\n---\n\n# ${a.title.replace(/[\r\n]/g, ' ')}\n\n## 摘要\n\n${a.summary}\n\n## 关键要点\n\n${a.keyPoints.map(x => '- ' + x).join('\n')}\n\n## 整理内容\n\n${a.body}\n\n## 来源与归档\n\n[打开原文件](<${encodeURI(source).replace(/#/g, '%23').replace(/\?/g, '%3F')}>)\n\n分类理由：${a.reason}\n`;
}
