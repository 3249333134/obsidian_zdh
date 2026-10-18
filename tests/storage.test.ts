import { describe, it, expect } from 'vitest';
import { MemoryVault, TFile } from './obsidian';
import { archiveTask, initialize, uniquePath } from '../src/storage';
import { defaultSettings, FOLDERS, ORIGINALS, SOURCES } from '../src/config';
import type { Task } from '../src/types';
import { analysis } from './fixtures';
function task(): Task { return { id: 'test-id', name: '文档.pdf', sourcePath: `${SOURCES}/文档.pdf`, createdAt: '2026-10-14', status: 'review', analysis: { ...analysis } }; }
describe('vault safety and recovery', () => {
  it('initializes idempotently and preserves existing Home', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(); await vault.create('Home.md', '用户原有首页');
    await initialize(vault as any, settings); const count = vault.entries.size;
    await initialize(vault as any, settings); expect(vault.entries.size).toBe(count); expect(vault.contents.get('Home.md')).toBe('用户原有首页');
    for (const folder of FOLDERS) expect(vault.entries.has(folder)).toBe(true);
  });
  it('adds filename suffixes without overwriting', async () => {
    const vault = new MemoryVault(); await vault.create('库/标题.md', 'old'); expect(uniquePath(vault as any, '库', '标题.md')).toBe('库/标题 (2).md');
  });
  it('preserves original and creates exactly one note when retried', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(), t = task(); await initialize(vault as any, settings);
    const bytes = new Uint8Array([1, 2, 3]).buffer; await vault.createBinary(t.sourcePath, bytes);
    let saves = 0; await archiveTask(vault as any, settings, t, async () => { saves++; });
    await archiveTask(vault as any, settings, t, async () => { saves++; });
    expect(t.status).toBe('done'); expect(vault.contents.get(t.originalPath!)).toEqual(bytes); expect(vault.entries.has(t.sourcePath)).toBe(false);
    expect([...vault.entries.keys()].filter(p => p.endsWith('测试方法.md'))).toHaveLength(1); expect(saves).toBe(2);
  });
  it('recovers after original move and failed note creation', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(), t = task(); await initialize(vault as any, settings);
    await vault.createBinary(t.sourcePath, new Uint8Array([9]).buffer); vault.failCreate = true;
    await expect(archiveTask(vault as any, settings, t, async () => {})).rejects.toThrow('disk full');
    expect(vault.entries.has(t.originalPath!)).toBe(true); expect(t.archiveContent).toBeTruthy();
    await archiveTask(vault as any, settings, t, async () => {}); expect(t.status).toBe('done');
  });
  it('recovers a write completed before final task persistence', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(), t = task(); await initialize(vault as any, settings);
    await vault.createBinary(t.sourcePath, new Uint8Array([9]).buffer);
    let saved: Task | undefined;
    await archiveTask(vault as any, settings, t, async () => { if (t.status === 'archiving') saved = JSON.parse(JSON.stringify(t)); });
    saved!.status = 'failed'; await archiveTask(vault as any, settings, saved!, async () => {}); expect(saved!.status).toBe('done');
  });
  it('rejects a replaced original during interrupted archive recovery', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(), t = task(); await initialize(vault as any, settings);
    await vault.createBinary(t.sourcePath, new Uint8Array([9]).buffer); vault.failCreate = true;
    await expect(archiveTask(vault as any, settings, t, async () => {})).rejects.toThrow('disk full');
    vault.contents.set(t.originalPath!, new Uint8Array([8]).buffer);
    await expect(archiveTask(vault as any, settings, t, async () => {})).rejects.toThrow('不一致');
    expect(vault.entries.has(t.notePath!)).toBe(false);
  });
  it('rejects collisions and preserves changed note content', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(), t = task(); await initialize(vault as any, settings);
    await vault.createBinary(t.sourcePath, new Uint8Array([9]).buffer);
    t.originalPath = `${ORIGINALS}/占用.pdf`; await vault.create(t.originalPath, 'existing');
    await expect(archiveTask(vault as any, settings, t, async () => {})).rejects.toThrow('占用'); expect(vault.contents.get(t.originalPath)).toBe('existing');
    expect(vault.getAbstractFileByPath(t.sourcePath)).toBeInstanceOf(TFile);
  });
  it('rejects paths outside the vault and disabled destinations', async () => {
    const vault = new MemoryVault(), settings = defaultSettings(), t = task(); settings.destinations.find(d => d.id === 'methods')!.path = '../outside';
    await expect(archiveTask(vault as any, settings, t, async () => {})).rejects.toThrow(); expect(vault.entries.size).toBe(0);
    settings.destinations.find(d => d.id === 'methods')!.enabled = false;
    await expect(archiveTask(vault as any, settings, t, async () => {})).rejects.toThrow('停用');
  });
});
