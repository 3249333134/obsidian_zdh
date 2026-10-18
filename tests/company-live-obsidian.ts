export class TFile {constructor(public path:string){}get extension(){return this.path.split('.').pop()||'';}}
export class TFolder {constructor(public path:string){}}
export const parseYaml=(text:string)=>JSON.parse(text);export const stringifyYaml=(value:unknown)=>JSON.stringify(value,null,2);
export async function requestUrl():Promise<any>{throw Error('Acceptance uses explicit HTTPS adapter only');}
