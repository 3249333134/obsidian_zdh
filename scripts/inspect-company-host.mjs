import {remote} from './diary-remote.mjs';
await remote(async({run})=>{console.log(await run("docker ps --format '{{.Names}} | {{.Image}}'; ss -lnt | grep -E ':(3400|3399|3306) ' || true; nginx -T 2>/dev/null | grep -E 'ssl_certificate|listen .*3399' || true; free -m | head -2"));});
