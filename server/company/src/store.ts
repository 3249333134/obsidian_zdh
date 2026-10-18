import type {Pool} from 'mysql2/promise';
import type {CompanyData} from './service';
export interface CompanyStore {transaction<T>(work:(data:CompanyData)=>Promise<T>|T):Promise<T>;read():Promise<CompanyData>;readAsset?(key:string):Promise<string|undefined>}
export class MemoryCompanyStore implements CompanyStore {
 private queue=Promise.resolve();constructor(public data:CompanyData){}
 transaction<T>(work:(data:CompanyData)=>Promise<T>|T):Promise<T>{const job=this.queue.then(async()=>{const draft=structuredClone(this.data),value=await work(draft);this.data=draft;return structuredClone(value);});this.queue=job.then(()=>{},()=>{});return job;}
 async read(){await this.queue;return structuredClone(this.data);}
}
// A single locked aggregate is deliberately bounded to the first 20-person company.
// Every content mutation, operation receipt and audit entry commits atomically.
export class MysqlCompanyStore implements CompanyStore {
 constructor(private pool:Pool){}
 async initialize(seed:CompanyData){await this.pool.query('CREATE TABLE IF NOT EXISTS kf_company_state (id INT PRIMARY KEY, schema_version INT NOT NULL, body LONGTEXT NOT NULL)');await this.pool.query('CREATE TABLE IF NOT EXISTS kf_company_assets (asset_key VARCHAR(200) PRIMARY KEY, body MEDIUMBLOB NOT NULL)');await this.pool.query('INSERT IGNORE INTO kf_company_state (id,schema_version,body) VALUES (1,1,?)',[JSON.stringify(seed)]);const data=await this.read();if(data.schema!==1)throw Error('Company database schema incompatible');}
 async transaction<T>(work:(data:CompanyData)=>Promise<T>|T):Promise<T>{const c=await this.pool.getConnection();try{await c.beginTransaction();const [rows]:any=await c.query('SELECT body FROM kf_company_state WHERE id=1 FOR UPDATE');const data:CompanyData=JSON.parse(rows[0].body);if(data.schema!==1)throw Error('Company database schema incompatible');const result=await work(data);for(const r of [...Object.values(data.revisions),...Object.values(data.documents)])for(const a of r.attachments)if(a.data){const key=a.storageKey||r.id+':'+a.id;await c.query('INSERT INTO kf_company_assets(asset_key,body) VALUES (?,?) ON DUPLICATE KEY UPDATE asset_key=asset_key',[key,Buffer.from(a.data,'base64')]);a.storageKey=key;delete a.data;}await c.query('UPDATE kf_company_state SET body=? WHERE id=1',[JSON.stringify(data)]);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}}
 async readAsset(key:string){const [rows]:any=await this.pool.query('SELECT body FROM kf_company_assets WHERE asset_key=?',[key]);return rows[0]?.body.toString('base64');}
 async read(){const [rows]:any=await this.pool.query('SELECT body FROM kf_company_state WHERE id=1');return JSON.parse(rows[0].body) as CompanyData;}
}
