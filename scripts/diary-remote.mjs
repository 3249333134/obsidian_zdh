import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire('D:/prj/user/Diary/package.json'),{Client}=require('ssh2'),ts=require('typescript');
const source=ts.createSourceFile('deploy.mjs',await fs.readFile('D:/prj/user/Diary/scripts/final-deploy.mjs','utf8'),ts.ScriptTarget.Latest,true);
let credentials;
function walk(node){if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='connect'&&node.arguments[0]&&ts.isObjectLiteralExpression(node.arguments[0])){
 const values={};for(const p of node.arguments[0].properties)if(ts.isPropertyAssignment(p)&&(ts.isStringLiteral(p.initializer)||ts.isNumericLiteral(p.initializer)))values[p.name.text]=ts.isNumericLiteral(p.initializer)?Number(p.initializer.text):p.initializer.text;credentials=values;
 }ts.forEachChild(node,walk);}walk(source);
if(credentials?.host!=='47.115.220.98'||!credentials.username||!credentials.password)throw new Error('No matching configured deployment target');
export async function remote(work){const c=new Client();await new Promise((res,rej)=>{c.once('ready',res).once('error',()=>rej(new Error('SSH connection failed'))).connect({...credentials,readyTimeout:15000});});
 const run=command=>new Promise((res,rej)=>c.exec(command,(error,stream)=>{if(error)return rej(new Error('SSH command failed'));let output='';stream.on('data',data=>output+=data).stderr.on('data',data=>output+=data);stream.once('close',code=>code?rej(new Error('Remote command failed: '+output.slice(-1000))):res(output));}));
 const upload=(local,target)=>new Promise((res,rej)=>c.sftp((error,sftp)=>{if(error)return rej(new Error('SFTP unavailable'));sftp.fastPut(local,target,error=>{sftp.end();error?rej(new Error('SFTP upload failed')):res();});}));
 try{return await work({run,upload});}finally{c.end();}
}
if(process.argv.includes('--inspect'))await remote(async({run})=>console.log(await run("docker ps --filter name=diary-app --format '{{.Names}} | {{.Image}} | {{.Status}}'; docker inspect diary-app --format '{{json .Mounts}}'; docker inspect diary-app --format '{{json .Config.Cmd}}'; test -f /opt/diary/.env && echo deployment-config-present; df -h /opt/diary | tail -1")));
