import Fastify from 'fastify';
import fs from 'node:fs/promises';
import {z,ZodError} from 'zod';
import {CompanyService,fail} from './service';
export async function createCompanyApp(service:CompanyService,publicDir?:string,https?:{key:Buffer;cert:Buffer}){
 const app=Fastify({logger:false,bodyLimit:16*1024*1024,...(https?{https}:{})}),prefix='/api/company/v1';
 const rates=new Map<string,{count:number;until:number}>();
 app.addHook('onRequest',async(req,reply)=>{reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');if(req.url.startsWith(prefix+'/login')||req.url.startsWith(prefix+'/join')){const old=rates.get(req.ip);if(!old||old.until<Date.now())rates.set(req.ip,{count:1,until:Date.now()+60000});else if(++old.count>10)throw fail('尝试过于频繁，请稍后重试。',429);if(rates.size>2000)for(const [key,v]of rates)if(v.until<Date.now())rates.delete(key);}});
 app.setErrorHandler((error:any,_req,reply)=>{const code=error instanceof ZodError?400:error.statusCode||500;reply.code(code).send({message:error instanceof ZodError?'输入字段无效，请检查表单。':code===500?'服务器操作失败，请重试。':error.message,...(error.current?{current:error.current}:{})});});
 const token=(req:any)=>{const value=String(req.headers.authorization||'');if(!/^Bearer kf_company_[a-f0-9]{64}$/.test(value))throw fail('请登录或连接公司。',401);return value.slice(7);};
 app.get(prefix+'/health',async()=>({service:'knowledge-flow-company',protocol:1,version:'0.9.0'}));
 app.post(prefix+'/login',async req=>service.login(req.body));app.post(prefix+'/join',async req=>service.join(req.body));
 app.get(prefix+'/snapshot',async req=>service.snapshot(token(req)));
 app.get(prefix+'/changes',async req=>{const cursor=z.coerce.number().int().min(0).parse((req.query as any).cursor||0),snapshot=await service.snapshot(token(req));return snapshot.cursor===cursor?{unchanged:true,cursor:snapshot.cursor}:snapshot;});
 app.get(prefix+'/admin',async req=>service.adminData(token(req)));
 app.post(prefix+'/operations',async req=>service.operate(token(req),req.body));
 app.post(prefix+'/search',async req=>{const v=z.object({query:z.string().min(1).max(2000),spaceId:z.string().optional(),roleId:z.string().max(100).optional()}).parse(req.body);return service.search(token(req),v.query,v.spaceId,v.roleId);});
 app.post(prefix+'/answer',async req=>service.answer(token(req),req.body));app.post(prefix+'/review-draft',async req=>service.reviewDraft(token(req),req.body));
 app.get(prefix+'/documents/:id/attachments/:attachmentId',async(req,reply)=>{const p=req.params as any,a=await service.attachment(token(req),p.id,p.attachmentId);reply.header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(a.name)).type('application/octet-stream');return Buffer.from(a.data!,'base64');});
 app.get(prefix+'/revisions/:id/attachments/:attachmentId',async(req,reply)=>{const p=req.params as any,a=await service.attachment(token(req),p.id,p.attachmentId,true);reply.header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(a.name)).type('application/octet-stream');return Buffer.from(a.data!,'base64');});
 if(publicDir){app.get('/',async(_req,reply)=>reply.type('text/html').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'").send(await fs.readFile(publicDir+'/index.html','utf8')));for(const name of ['admin.js','admin.css'])app.get('/'+name,async(_req,reply)=>reply.type(name.endsWith('js')?'text/javascript':'text/css').send(await fs.readFile(publicDir+'/'+name,'utf8')));}
 return app;
}
