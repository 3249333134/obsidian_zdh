import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mysql from 'mysql2/promise';
import {MysqlCompanyStore} from './store';
import {CompanyService,seedCompany} from './service';
import {createCompanyApp} from './app';
const env=process.env;
if(!env.COMPANY_DATABASE_URL||!env.COMPANY_SECRET_KEY)throw Error('Missing company database URL or encryption key');
const pool=mysql.createPool(env.COMPANY_DATABASE_URL),store=new MysqlCompanyStore(pool);
// Seed is INSERT IGNORE: restarting never overwrites users, keys or shared knowledge.
await store.initialize(seedCompany(env.COMPANY_NAME||'我的公司',env.COMPANY_ADMIN_USER||'admin',env.COMPANY_ADMIN_PASSWORD||''));
const service=new CompanyService(store,env.COMPANY_SECRET_KEY),https=env.COMPANY_TLS_KEY&&env.COMPANY_TLS_CERT?{key:await fs.readFile(env.COMPANY_TLS_KEY),cert:await fs.readFile(env.COMPANY_TLS_CERT)}:undefined;
if(!https&&env.COMPANY_HOST!=='127.0.0.1')throw Error('Public deployment requires HTTPS; local tests must explicitly bind 127.0.0.1');
service.adminPath=env.COMPANY_PUBLIC_ADMIN_PATH||'/';
const app=await createCompanyApp(service,path.join(path.dirname(fileURLToPath(import.meta.url)),'public'),https);
await app.listen({host:env.COMPANY_HOST||'0.0.0.0',port:Number(env.COMPANY_PORT||3400)});
for(const sig of ['SIGTERM','SIGINT'] as const)process.once(sig,()=>{void app.close().then(()=>pool.end());});
