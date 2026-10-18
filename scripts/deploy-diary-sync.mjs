import {remote} from './diary-remote.mjs';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),tag='diary-app:kf-070-'+stamp;
if(!process.argv.includes('--deploy'))throw new Error('Use --deploy after tests pass');
const archive='D:/prj/obsidian_zdh/.test-output/diary-sync-release.tar.gz';
execFileSync('tar.exe',['-czf',archive,'-C','D:/prj/user/Diary','apps/api/dist','apps/web/dist','packages/contracts/dist']);
const result=await remote(async({run,upload})=>{
 const name='diary-app',backup='/opt/diary-v2/backups/kf-'+stamp,release='/opt/diary-v2/releases/kf-'+stamp;
 const image=(await run("docker inspect diary-app --format '{{.Image}}'")).trim();
 const mounts=JSON.parse(await run("docker inspect diary-app --format '{{json .Mounts}}'"));
 const network=(await run("docker inspect diary-app --format '{{.HostConfig.NetworkMode}}'")).trim();
 if(network!=='host'||mounts.length!==1||mounts[0].Source!=='/opt/diary-v2/data'||mounts[0].Destination!=='/app/data')throw new Error('Unexpected production mount or network; deployment stopped');
 await run(`umask 077; mkdir -p '${backup}' '${release}'; chmod 700 '${backup}'; docker inspect diary-app > '${backup}/container.json'; docker inspect diary-app --format '{{range .Config.Env}}{{println .}}{{end}}' > '${backup}/container.env'; docker image tag '${image}' 'diary-app:before-kf-${stamp}'`);
 const dump=`const mysql=(await import('mysql2/promise')).default;const {config}=await import('./apps/api/dist/config.js');const c=await mysql.createConnection(config.db);await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();const data={};for(const table of ['users','diaries','settings','assets','sessions']){data[table]=(await c.query('SELECT * FROM '+table))[0];}await c.commit();await c.end();process.stdout.write(JSON.stringify(data));`;
 const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
 await run(`umask 077; docker exec diary-app node --input-type=module -e ${quote(dump)} > '${backup}/database.json'; test -s '${backup}/database.json'; sha256sum '${backup}/database.json' > '${backup}/database.sha256'`);
 await run(`docker run --rm --network none -v '${backup}:/backup:ro' '${image}' node -e "const d=JSON.parse(require('fs').readFileSync('/backup/database.json','utf8'));if(!Array.isArray(d.diaries)||!Array.isArray(d.users)||!Array.isArray(d.settings))process.exit(1);"`);
 await upload(archive,release+'/update.tar.gz');await run(`tar -xzf '${release}/update.tar.gz' -C '${release}'`);
 const builder='kf-diary-build-'+stamp,stage='kf-diary-stage-'+stamp;
 await run(`docker create --name '${builder}' '${image}' >/dev/null; docker cp '${release}/apps/api/dist/.' '${builder}:/app/apps/api/dist/'; docker cp '${release}/apps/web/dist/.' '${builder}:/app/apps/web/dist/'; docker cp '${release}/packages/contracts/dist/.' '${builder}:/app/packages/contracts/dist/'; docker commit '${builder}' '${tag}' >/dev/null; docker rm '${builder}' >/dev/null`);
 const check=`import {buildServer} from './apps/api/dist/server.js';const app=await buildServer();await app.listen({port:4329,host:'127.0.0.1'});`;
 await run(`docker run -d --name '${stage}' --network host --env-file '${backup}/container.env' -v /opt/diary-v2/data:/app/data '${tag}' node --input-type=module -e ${quote(check)} >/dev/null`);
 try{await run(`docker exec '${stage}' node -e "const u='http://127.0.0.1:4329/api/health';for(let i=0;i<30;i++){try{const r=await fetch(u);if(r.ok)process.exit(0);}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);" --input-type=module`);}catch(e){await run(`docker logs '${stage}' --tail 15`);throw e;}finally{await run(`docker stop -t 5 '${stage}' >/dev/null; docker rm '${stage}' >/dev/null`);}
 const previous='diary-app-before-kf-'+stamp;
 await run(`docker stop -t 20 diary-app >/dev/null; docker rename diary-app '${previous}'`);
 try{
  await run(`docker run -d --name diary-app --restart unless-stopped --network host --env-file '${backup}/container.env' -v /opt/diary-v2/data:/app/data '${tag}' >/dev/null`);
  await run(`docker exec diary-app node --input-type=module -e "for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:4319/api/health');if(r.ok){const p=await fetch('http://127.0.0.1:4319/api/obsidian-sync/v1/info');if(p.status===401)process.exit(0);}}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);"`);
 }catch(e){await run(`docker stop -t 5 diary-app >/dev/null; docker rename diary-app 'diary-app-failed-kf-${stamp}'; docker rename '${previous}' diary-app; docker start diary-app >/dev/null`);throw new Error('New service failed; previous container restored');}
 return {deployed:true,version:'0.7.0',image:tag,previousContainer:previous,backup,release};
});
await fs.writeFile('.test-output/diary-deployment.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
