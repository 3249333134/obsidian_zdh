import { createHash } from 'node:crypto';
import type { Conversation, ConversationMessage } from './types';

export const fingerprint = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function redact(value: string, knownKey = ''): string {
  let text = knownKey ? value.split(knownKey).join('[已遮蔽凭据]') : value;
  return text.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, '[已遮蔽凭据]')
    .replace(/\b(?:kf_company_|diary_obs_)[a-f0-9]{64}\b/g, '[已遮蔽凭据]')
    .replace(/\btvly-[a-zA-Z0-9_-]{12,}\b/g, '[已遮蔽凭据]')
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9._~+\/-]+=*/gi, '$1 [已遮蔽凭据]')
    .replace(/((?:["']?)(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|password|secret|token)(?:["']?)\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/gi, '$1[已遮蔽凭据]')
    .replace(/([?&](?:api_key|key|token|access_token)=)[^&#\s]+/gi, '$1[已遮蔽凭据]')
    .replace(/(https?:\/\/)[^\s\/@]+:[^\s\/@]+@/gi, '$1[已遮蔽凭据]@');
}
type ObjectRecord = Record<string, any>;
export function sessionOrigin(origin: unknown): 'primary' | 'internal' | 'unknown' {
  if (origin === 'subagent' || (origin && typeof origin === 'object' && 'subagent' in origin)) return 'internal';
  return typeof origin === 'string' && ['cli', 'vscode', 'exec', 'app', 'desktop', 'work', 'codex'].includes(origin) ? 'primary' : 'unknown';
}
// Runtime envelopes are matched at the start; ordinary quotations remain data.
export function cleanVisibleText(value: string): string {
  const text = value.trim();
  if (/^(?:<environment_context>|<permissions instructions>|<turn_aborted>|<system_reminder>|<user_instructions>|<INSTRUCTIONS>|<node_repl_review_evidence>|# AGENTS\.md instructions for |Message Type: (?:MESSAGE|FINAL_ANSWER)\s*\nTask name:|>>?>?\s*APPROVAL REQUEST START|The following is the Codex agent history added since your last approval assessment)/i.test(text)) return '';
  if (/^(?:\[REPL (?:response|request)|Assess the exact planned action below|RETAINED USER INSTRUCTIONS START)/i.test(text)) return '';
  return text.replace(/<(environment_context|node_repl_review_evidence|permissions instructions)>[\s\S]*?<\/\1>/gi, '').trim();
}
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') return part.text;
    if (['image', 'image_url', 'input_image', 'file', 'input_file', 'attachment'].includes(part.type)) return '[附件未采集]';
    return '';
  }).filter(Boolean).join('\n');
}
function timestamp(value: unknown, fallback: number): string {
  let time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : fallback;
  if (typeof value === 'number' && time < 100000000000) time *= 1000;
  return new Date(Number.isFinite(time) ? time : fallback).toISOString();
}
export interface ParsedMessage { sessionId?: string; title?: string; message: ConversationMessage }
export function parseNativeRecord(kind: 'codex' | 'workbuddy', record: ObjectRecord, fallback: number, offset: number): ParsedMessage | null {
  let payload = record;
  if (record.isSidechain === true || record.isMeta === true || record.subagent) return null;
  if (record.channel && !['final', 'commentary'].includes(record.channel)) return null;
  if (kind === 'codex') {
    if (record.type !== 'response_item' || record.payload?.type !== 'message') return null;
    payload = record.payload;
    if (payload.channel && !['final', 'commentary'].includes(payload.channel)) return null;
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;
  } else {
    if (!['user', 'assistant'].includes(record.role)) return null;
    if (record.type && !['user', 'assistant', 'message'].includes(record.type)) return null;
  }
  const text = cleanVisibleText(contentText(payload.content));
  if (!text.trim()) return null;
  return { sessionId: kind === 'workbuddy' ? record.sessionId : undefined,
    message: { id: String(payload.id || record.id || payload.message_id || `offset-${offset}`), role: payload.role,
      timestamp: timestamp(record.timestamp || payload.timestamp, fallback), text } };
}
export function parseExport(text: string, extension: string, session: string, time: number): ParsedMessage[] {
  if (extension === '.md' || extension === '.txt') { const body = cleanVisibleText(text); return body ? [{ sessionId: session,
    message: { id: 'document', role: 'user', timestamp: timestamp(time, time), text: body } }] : []; }
  let data: unknown;
  try { data = extension === '.jsonl' ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text); }
  catch { throw new Error('导出文件不是完整有效的 JSON/JSONL，请等待导出完成后重试。'); }
  const root = data as any;
  const records = Array.isArray(root) ? root : root && Array.isArray(root.messages) ? root.messages : null;
  if (!records) throw new Error('未知导出格式。支持消息数组或包含 messages 数组的 JSON，以及已识别的 JSONL。');
  for (const meta of records.filter((r: any) => r?.type === 'session_meta')) {
    const origin = sessionOrigin(meta.payload?.source);
    if (origin === 'unknown') throw new Error('导出会话来源元信息无法识别，已隔离，不发送 AI。');
    if (origin === 'internal') return [];
  }
  const parsed: ParsedMessage[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || typeof record !== 'object') throw new Error('导出消息格式不正确。');
    const codex = parseNativeRecord('codex', record, time, i);
    const workbuddy = parseNativeRecord('workbuddy', record, time, i);
    if (record.type === 'response_item' || record.type === 'event_msg' || ['session_meta', 'turn_context'].includes(record.type)) { if (codex) parsed.push({ ...codex, sessionId: root.sessionId || session }); continue; }
    if (workbuddy && ['user', 'assistant', 'message'].includes(record.type)) { parsed.push({ ...workbuddy, sessionId: root.sessionId || session }); continue; }
    if (record.role === 'system' || record.role === 'tool' || record.role === 'developer' || record.type === 'system') continue;
    if (!['user', 'assistant'].includes(record.role)) throw new Error('未知导出消息格式：缺少 user/assistant 角色。');
    if (record.channel && !['final', 'commentary'].includes(record.channel)) continue;
    const body = cleanVisibleText(contentText(record.content ?? record.text));
    if (!body.trim()) continue;
    parsed.push({ sessionId: String(root.sessionId || root.id || session), title: typeof root.title === 'string' ? root.title : undefined,
      message: { id: String(record.id || record.messageId || `message-${i}`), role: record.role, timestamp: timestamp(record.timestamp || record.created_at, time), text: body } });
  }
  return parsed;
}
export function mergeMessages(conversation: Conversation, messages: ConversationMessage[], key = ''): boolean {
  conversation.messages ||= [];
  let changed = false;
  for (const item of messages) {
    const message = { ...item, text: redact(item.text, key) };
    const index = conversation.messages.findIndex(m => m.id === message.id);
    if (index === -1) {
      if (message.id.startsWith('offset-') && conversation.messages.some(m => m.role === message.role && m.timestamp === message.timestamp && m.text === message.text)) continue;
      conversation.messages.push(message); changed = true;
    }
    else if (conversation.messages[index].text !== message.text || conversation.messages[index].role !== message.role) {
      conversation.messages[index] = message; changed = true;
    }
  }
  return changed;
}
export function transcript(conversation: Conversation, sourceName: string): string {
  return `---\nknowledge_flow_conversation: ${JSON.stringify(conversation.key)}\nsource_app: ${JSON.stringify(sourceName)}\nsession_id: ${JSON.stringify(conversation.sessionId)}\nrevision: ${conversation.revision}\n---\n\n# ${conversation.title.replace(/[\r\n]/g, ' ')}\n\n> 已发送的对话记录；凭据已遮蔽，附件仅保留提示。\n\n` +
    (conversation.messages || []).map(m => `## ${m.role === 'user' ? '我' : 'AI'} · ${m.timestamp}\n\n${m.text}\n`).join('\n');
}
export function shouldAnalyze(c: Conversation, now: number): boolean {
  return c.revision > c.analyzedRevision && (c.completedRevision === c.revision || now - c.lastChangedAt >= 120000 || now - c.pendingSince >= 600000);
}
