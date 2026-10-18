import fs from 'node:fs/promises';
import path from 'node:path';
import { TFile, type Vault } from 'obsidian';
import type { State } from './types';
import { fingerprint } from './sync-format';
import { safePath } from './core';

// This one-time backup is the only retained copy of legacy transcripts.
export async function migrateConversationState(state: State, vault: Vault) {
  const sync = state.sync; if (!sync || sync.modeVersion === 2) return;
  const base = (vault.adapter as any)?.getBasePath?.();
  if (!base) throw new Error('无法定位笔记库，已停止迁移与采集。');
  const backup = path.resolve(base, '.obsidian/plugins/knowledge-flow/migration-backup-v03');
  await fs.mkdir(backup, { recursive: true });
  const stateBackup = path.join(backup, 'data-before.json');
  try { await fs.writeFile(stateBackup, JSON.stringify(state), { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const candidates = new Map<string, string>();
  for (const c of sync.conversations) if (c.transcriptPath && c.transcriptHash) candidates.set(c.transcriptPath, c.transcriptHash);
  for (const t of state.tasks.filter(t => t.conversationKey)) {
    const original = t.conversationArchive?.original || t.transcriptText;
    if (t.originalPath && original) candidates.set(t.originalPath, fingerprint(original));
  }
  const warnings: string[] = [];
  for (const [filename, expected] of candidates) {
    const file = vault.getAbstractFileByPath(safePath(filename)); if (!file) continue;
    if (!(file instanceof TFile)) { warnings.push(`${filename}：位置被文件夹占用，已保留。`); continue; }
    const content = await vault.read(file); const hash = fingerprint(content);
    if (hash !== expected) { warnings.push(`${filename}：有手工修改，已保留。`); continue; }
    const copy = path.join(backup, hash + '.md');
    try { await fs.writeFile(copy, content, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (fingerprint(await fs.readFile(copy, 'utf8')) !== hash) throw new Error('旧记录备份校验失败，未清理原文件。');
    // Recheck after backup; never delete a note edited during migration.
    if (fingerprint(await vault.read(file)) !== hash) { warnings.push(`${filename}：迁移期间被修改，已保留。`); continue; }
    await vault.delete(file);
  }
  for (const c of sync.conversations) {
    if (c.archivedContent) c.archivedHash = fingerprint(c.archivedContent);
    delete c.messages; delete c.transcriptPath; delete c.transcriptHash; delete c.archivedContent; delete c.knowledge;
    c.title = '待提炼对话'; c.messageIndex = {}; c.pendingCount = 0; c.revision++; c.analyzedRevision = 0;
  }
  for (const t of state.tasks.filter(t => t.conversationKey)) {
    t.status = 'superseded'; t.progress = '旧逐字记录已备份，等待重新提炼'; t.error = undefined;
    delete t.transcriptText; delete t.conversationArchive; delete t.analysis; delete t.originalPath; delete t.archiveContent; t.sourcePath = '';
  }
  for (const source of sync.sources) {
    source.historyPending = [{ from: '2026-10-08', to: '2026-10-14' }];
    if (source.kind !== 'trae') for (const cursor of Object.values(source.cursors)) cursor.offset = 0;
  }
  sync.migrationWarnings = warnings; sync.modeVersion = 2;
}

export function persistentState(state: State): State {
  const copy = JSON.parse(JSON.stringify(state)) as State;
  for (const c of copy.sync?.conversations || []) { delete c.messages; delete c.transcriptPath; delete c.transcriptHash; delete c.archivedContent; }
  for (const t of copy.tasks) if (t.conversationKey) {
    delete t.transcriptText;
    if (t.conversationArchive) { delete t.conversationArchive.original; delete t.conversationArchive.originalPath; }
  }
  return copy;
}
