import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FileCursor, SyncSource } from './types';
import { fingerprint, parseExport, parseNativeRecord, sessionOrigin, type ParsedMessage } from './sync-format';

const MAX_READ = 32 * 1024 * 1024;
export const defaultSources = (): SyncSource[] => [
  ['codex', 'Codex / Work 本地会话'], ['workbuddy', 'WorkBuddy'], ['trae', 'TRAE 导出目录']
].map(([kind, name]) => ({ id: kind, kind: kind as SyncSource['kind'], name, directory: '', executablePath: '', enabled: false, initialized: false, cursors: {} }));
export async function detectSource(source: SyncSource): Promise<{ directory: string; message: string }> {
  if (source.executablePath.trim()) {
    try { if (!(await fs.stat(source.executablePath)).isFile()) throw new Error(); }
    catch { throw new Error('软件路径不存在，请选择正确的程序文件。'); }
  }
  const directory = source.directory.trim() || (source.kind === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') : source.kind === 'workbuddy' ? path.join(os.homedir(), '.workbuddy', 'projects') : '');
  if (!directory) throw new Error('TRAE 首版需导出，请选择保存聊天导出文件的目录。');
  if (!path.isAbsolute(directory)) throw new Error('记录目录必须是绝对路径。');
  try { if (!(await fs.stat(directory)).isDirectory()) throw new Error(); }
  catch { throw new Error('记录目录不存在或无法读取，请手动选择记录／导出目录。'); }
  return { directory: path.resolve(directory), message: source.kind === 'trae' ? '需导出 · 将监控此目录的新文件' : '已找到本地会话记录目录' };
}
export async function sourceFiles(source: SyncSource): Promise<string[]> {
  const files: string[] = [];
  const extensions = source.kind === 'trae' ? ['.md', '.txt', '.json', '.jsonl'] : ['.jsonl'];
  async function walk(directory: string, depth: number) {
    if (depth > 12) throw new Error('记录目录层级过深，请选择更具体的目录。');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['subagents', 'node_modules', 'logs', 'audit-log', 'traces', 'cache'].includes(entry.name.toLowerCase())) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) files.push(target);
      if (files.length > 20000) throw new Error('记录目录文件过多，请缩小监控范围。');
    }
  }
  await walk(source.directory, 0); return files.sort();
}
export async function fileCursor(filename: string): Promise<FileCursor> {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat(); const prefix = Buffer.alloc(Math.min(128, stat.size));
    await handle.read(prefix, 0, prefix.length, 0);
    let sessionId: string | undefined;
    let internal = false;
    let metadataVerified = false;
    let appName: string | undefined;
    const pieces: Buffer[] = []; let length = 0;
    while (length < Math.min(MAX_READ, stat.size)) {
      const part = Buffer.alloc(Math.min(65536, stat.size - length, MAX_READ - length));
      const { bytesRead } = await handle.read(part, 0, part.length, length);
      if (!bytesRead) break;
      const bytes = part.subarray(0, bytesRead); pieces.push(bytes); length += bytesRead;
      if (bytes.includes(10)) break;
    }
    const header = Buffer.concat(pieces);
    try {
      const first = JSON.parse(header.toString('utf8').split('\n')[0]);
      if (first.type === 'session_meta') {
        if (typeof first.payload?.id === 'string') sessionId = first.payload.id;
        const origin = sessionOrigin(first.payload?.source);
        internal = origin === 'internal'; metadataVerified = origin !== 'unknown';
        appName = first.payload?.originator === 'codex_work_desktop' || first.payload?.source === 'work' ? 'Work' : first.payload?.originator === 'Codex Desktop' || ['cli', 'codex'].includes(first.payload?.source) ? 'Codex' : '来源未识别';
      }
    } catch {}
    return { offset: 0, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, signature: fingerprint(prefix), size: stat.size, mtime: stat.mtimeMs, sessionId, internal, metadataVerified, appName };
  } finally { await handle.close(); }
}
export interface SourceBatch { records: ParsedMessage[]; cursor: FileCursor; warnings?: string }
export async function readSourceFile(source: SyncSource, filename: string, previous?: FileCursor): Promise<SourceBatch> {
  if (previous && previous.offset === previous.size && previous.internal !== undefined && (source.kind !== 'codex' || (previous.metadataVerified && previous.appName))) {
    const stat = await fs.stat(filename);
    if (previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.identity === `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`)
      return { records: [], cursor: previous };
  }
  const current = await fileCursor(filename);
  if (source.kind === 'codex' && !current.metadataVerified) throw new Error('会话来源元信息不完整或无法识别，已隔离此文件，不发送 AI。');
  if (current.internal) return { records: [], cursor: { ...current, offset: current.size } };
  if (source.kind === 'trae') {
    if (previous?.baseline) return { records: [], cursor: { ...current, offset: current.size, baseline: true } };
    if (previous && previous.size === current.size && previous.mtime === current.mtime && previous.signature === current.signature) return { records: [], cursor: previous };
    if (current.size > 50 * 1024 * 1024) throw new Error('导出文件超过 50 MB，请拆分后重试。');
    const text = await fs.readFile(filename, 'utf8');
    return { records: parseExport(text.replace(/^\uFEFF/, ''), path.extname(filename).toLowerCase(), path.basename(filename), current.mtime), cursor: { ...current, offset: current.size } };
  }
  let offset = previous?.offset || 0;
  let replacedPrefix = Boolean(previous && previous.size >= 128 && current.signature !== previous.signature);
  if (previous && previous.size > 0 && previous.size < 128 && current.size >= previous.size) {
    const header = await fs.open(filename, 'r');
    try { const prefix = Buffer.alloc(previous.size); await header.read(prefix, 0, prefix.length, 0); replacedPrefix = fingerprint(prefix) !== previous.signature; }
    finally { await header.close(); }
  }
  // Growing short files change their prefix: this alone does not mean file rotation.
  if (previous && (current.identity !== previous.identity || current.size < offset || replacedPrefix)) offset = 0;
  if (current.size === offset) return { records: [], cursor: { ...current, offset } };
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(MAX_READ, current.size - offset)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead); const end = bytes.lastIndexOf(10);
    if (end === -1) {
      if (bytesRead === MAX_READ) throw new Error('单条消息超过 32 MB，无法安全解析，请使用导出文件。');
      return { records: [], cursor: { ...current, offset } };
    }
    const records: ParsedMessage[] = []; let consumed = 0;
    for (const line of bytes.subarray(0, end + 1).toString('utf8').split('\n').slice(0, -1)) {
      if (line.trim()) {
        let record;
        try { record = JSON.parse(line); } catch { throw new Error('会话日志包含无效 JSON，已停止此文件同步，原文件未修改。'); }
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('未知会话记录格式：消息必须是 JSON 对象。');
        if (source.kind === 'codex' && record.type === 'event_msg') {
          if (record.payload?.type === 'task_started') current.turnComplete = false;
          if (record.payload?.type === 'task_complete') current.turnComplete = true;
        }
        const parsed = parseNativeRecord(source.kind, record, current.mtime, offset + consumed);
        if (parsed) records.push({ ...parsed, sessionId: parsed.sessionId || current.sessionId || previous?.sessionId });
      }
      consumed += Buffer.byteLength(line + '\n');
    }
    return { records, cursor: { ...current, offset: offset + end + 1 } };
  } finally { await handle.close(); }
}
export async function baselineSource(source: SyncSource): Promise<Record<string, FileCursor>> {
  const cursors: Record<string, FileCursor> = {};
  for (const filename of await sourceFiles(source)) {
    const cursor = await fileCursor(filename); cursor.offset = cursor.size;
    if (source.kind === 'trae') cursor.baseline = true;
    // Do not begin at the middle of an unfinished JSONL record.
    else if (cursor.size) {
      const handle = await fs.open(filename, 'r');
      try {
        const length = Math.min(cursor.size, MAX_READ); const tail = Buffer.alloc(length);
        await handle.read(tail, 0, length, cursor.size - length);
        cursor.offset = cursor.size - length + tail.lastIndexOf(10) + 1;
      } finally { await handle.close(); }
    }
    cursors[filename] = cursor;
  }
  return cursors;
}
