import {remote} from './diary-remote.mjs';import fs from 'node:fs/promises';
const config='/opt/project-ark/source/deploy/remote/nginx.conf.template',stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),backup='/opt/knowledge-flow-company/backups/gateway-'+stamp;
const shared=`      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_read_timeout 180s;
      proxy_buffering off;`;
await remote(async({run,upload})=>{const original=await run(`cat '${config}'`);const marker='    # 全部代理到本地 Diary';if(!original.includes(marker))throw Error('Gateway configuration differs; no change made');const block=`    # knowledge-flow-company:start
    location = /company { return 302 /company/; }
    location ^~ /company/ {
      proxy_pass http://127.0.0.1:3400/;
${shared}
    }
    location ^~ /api/company/v1/ {
      proxy_pass http://127.0.0.1:3400;
${shared}
    }
    # knowledge-flow-company:end

`;
const cleaned=original.replace(/    # knowledge-flow-company:start[\s\S]*?    # knowledge-flow-company:end\n\n?/,'');const changed=cleaned.replace(marker,block+marker);await fs.writeFile('.test-output/company-gateway.conf',changed);await run(`umask 077; mkdir -p '${backup}'; cp '${config}' '${backup}/nginx.conf'; chmod 700 '${backup}'`);await upload('.test-output/company-gateway.conf',backup+'/candidate.conf');await run(`cat '${backup}/candidate.conf' > '${config}'`);try{await run('docker exec project-ark-gateway nginx -t');await run('docker exec project-ark-gateway nginx -s reload');}catch{await run(`cat '${backup}/nginx.conf' > '${config}'; docker exec project-ark-gateway nginx -t; docker exec project-ark-gateway nginx -s reload`);throw Error('Company gateway check failed; previous configuration restored');}await fs.writeFile('.test-output/company-gateway.json',JSON.stringify({backup,adminUrl:'https://47.115.220.98:3399/company/',normalTlsValidation:true},null,2));console.log('Independent company service published through /company/ and /api/company/v1/; existing Diary location retained.');});
