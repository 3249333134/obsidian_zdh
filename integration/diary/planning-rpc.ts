let seq=0;
const requests=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:number}>();
export class ApiError extends Error{constructor(message:string,public status=0,public data:any={}){super(message);}}
window.addEventListener('message',event=>{
 if(event.source!==parent||event.data?.nonce!==(window as any).__KF_NONCE||event.data?.kind!=='kf-result')return;
 const request=requests.get(event.data.id);if(!request)return;clearTimeout(request.timer);requests.delete(event.data.id);if(event.data.error)request.reject(new ApiError(event.data.error));else request.resolve(event.data.result);
});
export const api:any=new Proxy({}, {get(_target,method){if(method==='assetUrl')return (path:string)=>path;return (...args:any[])=>new Promise((resolve,reject)=>{const id=++seq,timer=window.setTimeout(()=>{requests.delete(id);reject(new Error('本地计划服务等待超时，请重试。'));},120000);requests.set(id,{resolve,reject,timer});parent.postMessage({kind:'kf-call',nonce:(window as any).__KF_NONCE,id,method,args},'*');});}});
