import { pool } from './db.js';
import { databaseContext } from './db-context.js';

export async function syncTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (databaseContext.getStore()) return work();
  const connection: any = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
  try {
    await connection.query('BEGIN');
    const result = await databaseContext.run(connection, work);
    await connection.query('COMMIT'); return result;
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { if (connection !== pool) connection.release(); }
}
export const syncSetting = (key: string) => /^weekly-(?:summary|material):\d{4}-W\d{2}$/.test(key) || /\/(?:plan-categories|plan-views|shared-tags|tags)\.json$/.test(key);
export async function recordSyncChange(userId: number, kind: 'diary' | 'setting', key: string, version: string) {
  if (kind === 'setting' && !syncSetting(key)) return;
  await pool.query('INSERT INTO obsidian_changes (user_id,kind,resource_key,version) VALUES (?,?,?,?)', [userId,kind,key,version]);
}
export async function initSyncTables() {
  const sqlite = typeof pool.getConnection !== 'function';
  const id = sqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGINT PRIMARY KEY AUTO_INCREMENT';
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS obsidian_devices (id VARCHAR(36) PRIMARY KEY,user_id INT NOT NULL,name VARCHAR(100) NOT NULL,token_hash VARCHAR(64) UNIQUE NOT NULL,created_at VARCHAR(30) NOT NULL,revoked_at VARCHAR(30))`,
    `CREATE TABLE IF NOT EXISTS obsidian_changes (seq ${id},user_id INT NOT NULL,kind VARCHAR(20) NOT NULL,resource_key VARCHAR(500) NOT NULL,version VARCHAR(64) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS obsidian_operations (user_id INT NOT NULL,operation_id VARCHAR(36) NOT NULL,request_hash VARCHAR(64) NOT NULL,status VARCHAR(20) NOT NULL,PRIMARY KEY(user_id,operation_id))`,
  ]) await pool.query(sql);
}
let ready: Promise<void> | undefined;
export function ensureSyncTables() { return ready ||= initSyncTables().catch(error => { ready = undefined; throw error; }); }
