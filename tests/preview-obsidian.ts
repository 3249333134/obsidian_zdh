export class ItemView { contentEl: HTMLElement; app: any; constructor(leaf: any) { this.contentEl = leaf.contentEl; this.app = leaf.app; } }
export class Notice { constructor(message: string) { console.log(message); } }
export class TFile { constructor(public path: string) {} }
export {parse as parseYaml} from 'yaml';
export const requestUrl=async()=>{throw Error('UI fixture does not call external AI');};
export class MarkdownRenderer{static async render(_app:any,text:string,container:HTMLElement){container.textContent=text;}}
