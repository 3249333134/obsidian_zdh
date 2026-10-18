import {annotateRole,stagePath} from './role-workflow';
import { TFile, TFolder, type Vault } from 'obsidian';
import { FOLDERS, HOME, INBOX, ORIGINALS } from './config';
import { renderNote, safeName, safePath } from './core';
import type { Settings, Task } from './types';

export async function ensureFolder(vault: Vault, value: string): Promise<void> {
  const parts = safePath(value).split('/');
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('/'); const found = vault.getAbstractFileByPath(path);
    if (found && !(found instanceof TFolder)) throw new Error(`目录位置已有同名文件：${path}`);
    if (!found) await vault.createFolder(path);
  }
}
export async function initialize(vault: Vault, settings: Settings): Promise<void> {
  for (const path of [...FOLDERS, ...settings.destinations.filter(d => d.enabled).map(d => d.path)]) await ensureFolder(vault, path);
  if (!vault.getAbstractFileByPath('Home.md')) await vault.create('Home.md', HOME);
  const doc = '07_SYSTEM-系统/工作流说明.md';
  if (!vault.getAbstractFileByPath(doc)) await vault.create(doc, '# 工作流说明\n\n打开知流工作台，导入文档，等待 AI 全文分析，检查并修改建议，然后确认归档。\n\n## 目标库\n\n' + settings.destinations.map(d => `- ${d.name}：${d.path} — ${d.description}`).join('\n') + '\n\n原文件先进入输入池/sources，确认归档后移至资产库/原始文档。首版没有日记自动化或 OCR。\n');
  settings.initialized = true;
}
export function uniquePath(vault: Vault, folder: string, filename: string): string {
  safePath(folder); const dot = filename.lastIndexOf('.');
  const stem = safeName(dot > 0 ? filename.slice(0, dot) : filename);
  const ext = dot > 0 ? filename.slice(dot).replace(/[^.a-zA-Z0-9]/g, '') : '';
  let path = `${folder}/${stem}${ext}`; let n = 2;
  while (vault.getAbstractFileByPath(path)) path = `${folder}/${stem} (${n++})${ext}`;
  return path;
}
export async function archiveTask(vault: Vault, settings: Settings, task: Task, save: () => Promise<void>): Promise<void> {
  if (!task.analysis) throw new Error('请先完成分析。');
  if (task.status === 'done') return;
  const destination = settings.destinations.find(d => d.id === task.analysis!.destinationId && d.enabled);
  if (!destination) throw new Error('目标库不存在或已停用，请重新选择。');
  const folder = safePath(destination.path || INBOX);
  const originals=task.roleContext?stagePath(task.roleContext,'assets')+'/原始文档':ORIGINALS;
  await ensureFolder(vault, folder); await ensureFolder(vault, originals);
  const sourceFile = vault.getAbstractFileByPath(task.sourcePath);
  const digest = async (file: TFile) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await vault.readBinary(file)))).map(b => b.toString(16).padStart(2, '0')).join('');
  if (sourceFile instanceof TFile) {
    const hash = await digest(sourceFile);
    if (task.sourceHash && task.sourceHash !== hash) throw new Error('原文件在归档期间发生变化，请保留文件并重新导入。');
    task.sourceHash = hash;
  }
  if (!task.originalPath) task.originalPath = uniquePath(vault, originals, task.name);
  if (!task.notePath) task.notePath = uniquePath(vault, folder, safeName(task.analysis.title) + '.md');
  safePath(task.originalPath); safePath(task.notePath);
  if (!task.originalPath.startsWith(originals + '/') || !task.notePath.startsWith(folder + '/')) throw new Error('归档路径与目标库不一致，请恢复原目标库后重试。');
  task.archivedAt ||= new Date().toISOString();
  task.archiveContent ||= annotateRole(renderNote(task.analysis, task.originalPath, task.createdAt, task.archivedAt, folder, task.id),task.roleContext,folder);
  // Persist reserved paths before writing. Recovery identifies only our own completed writes.
  task.status = 'archiving'; await save();
  const source = vault.getAbstractFileByPath(task.sourcePath);
  const original = vault.getAbstractFileByPath(task.originalPath);
  if (source instanceof TFile) {
    if (original) throw new Error('原文件目标位置已被占用，未覆盖文件。');
    await vault.rename(source, task.originalPath);
  } else if (!(original instanceof TFile)) throw new Error('找不到原文件，请恢复文件后重试。');
  else if (!task.sourceHash || await digest(original) !== task.sourceHash) throw new Error('目标原文件与导入文件不一致，未写入笔记，请检查后重试。');
  const existing = vault.getAbstractFileByPath(task.notePath);
  if (existing) {
    if (!(existing instanceof TFile) || await vault.read(existing) !== task.archiveContent)
      throw new Error('笔记目标位置已被占用或内容已变化，未覆盖文件。');
  } else await vault.create(task.notePath, task.archiveContent);
  task.status = 'done'; task.progress = '归档完成'; task.error = undefined;
  task.archiveContent = undefined; await save();
}
