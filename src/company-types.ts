import type {Todo} from './diary-vendor/contracts';
export const COMPANY_VIEW='knowledge-flow-company';
export interface CompanyMember {id:string;name:string;username:string;admin:boolean;active:boolean;roleIds:string[]}
export interface RoleTemplate {workflow?:import('./role-workflow').RoleWorkflow;id:string;name:string;categories:string[];rules:string;noteTemplate:string;questions:string[];plans:string[];entries:string[]}
export interface CompanySpace {id:string;name:string;kind:'company'|'department'|'role'|'project';roleId?:string;members:string[];owners:string[];version:number}
export interface CompanyAttachment {id:string;name:string;mime:string;size:number;data?:string;storageKey?:string}
export interface CompanyDocument {roleId?:string;stageId?:import('./role-workflow').StageId;category?:string;id:string;spaceId:string;title:string;body:string;tags:string[];links:string[];authorId:string;maintainerId:string;roleIds:string[];version:number;publishedAt:string;withdrawn?:boolean;source?:string;attachments:CompanyAttachment[]}
export interface CompanyRevision {roleId?:string;stageId?:import('./role-workflow').StageId;category?:string;id:string;documentId:string;spaceId:string;title:string;body:string;tags:string[];links:string[];attachments:CompanyAttachment[];authorId:string;source?:string;baseVersion:number;version:number;status:'pending'|'approved'|'rejected'|'withdrawn';reason?:string;reviewerId?:string;createdAt:string}
export interface TeamPlan {id:string;spaceId:string;ownerId:string;assigneeId:string;sourceIds:string[];date:string;task:Todo;version:number;progress:Array<{at:string;memberId:string;text:string}>}
export interface CompanyEvidence {source?:string;roleId?:string;stageId?:string;id:string;title:string;heading:string;text:string;version:number;spaceId:string}
export interface CompanyRelation {from:string;to:string;type:'link'|'tag';reason:string}
export interface CompanySnapshot {company:{id:string;name:string;adminPath?:string};me:CompanyMember;members:CompanyMember[];spaces:CompanySpace[];roles:RoleTemplate[];documents:CompanyDocument[];revisions:CompanyRevision[];plans:TeamPlan[];cursor:number;accessVersion:number}
export interface CompanyOperation {id:string;kind:string;input:any;error?:string;conflict?:boolean;remote?:unknown}
export interface CompanyMirror {path:string;version:number;hash:string;kind:'document'|'plan'|'asset'}
export interface CompanyState {activeRoleId?:string;roleRoots?:Record<string,string>;roleLinks?:Array<{path:string;roleId:string;stageId:import('./role-workflow').StageId;reason:string;hash:string}>;connection?:{url:string;token:string;memberId:string;companyId:string;enabled:boolean};cursor?:number;accessVersion?:number;profile?:Omit<CompanySnapshot,'documents'|'plans'|'revisions'>;mirrors:Record<string,CompanyMirror>;pending:CompanyOperation[];revisions:CompanyRevision[];plans:TeamPlan[];lastSuccess?:string;error?:string;revoked?:boolean;planMode?:'personal'|'company';selectedSpace?:string}
export const defaultCompanyState=():CompanyState=>({mirrors:{},pending:[],revisions:[],plans:[]});
