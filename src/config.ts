import type { Destination, Settings } from './types';
export const VIEW_TYPE = 'knowledge-flow-workbench';
export const INBOX = '00_INPUT-输入池/Inbox';
export const SOURCES = '00_INPUT-输入池/sources';
export const ORIGINALS = '05_ASSETS-资产库/原始文档';
export const CONVERSATIONS = '00_INPUT-输入池/对话记录';
export const PROVIDERS: Record<string, { name: string; baseUrl: string; model: string }> = {
  agnes: { name: 'Agnes AI', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  qwen: { name: '通义千问 · 北京地域', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  custom: { name: '自定义兼容接口', baseUrl: 'http://localhost:11434/v1', model: '' }
};
const definitions = [
  ['inbox', '待整理', INBOX, '无法明确分类、需要后续人工判断的材料'],
  ['cases', '案例库', '01_UNDERSTAND-理解层/案例库', '具体事件、实践案例、成功或失败经验'],
  ['methods', '方法库', '01_UNDERSTAND-理解层/方法库', '可复用的方法、流程、框架和操作步骤'],
  ['tools', '工具库', '01_UNDERSTAND-理解层/工具库', '软件、工具、产品使用指南与评测'],
  ['business', '商业观察库', '01_UNDERSTAND-理解层/商业观察库', '商业模式、市场、行业及公司观察'],
  ['topics', '选题库', '01_UNDERSTAND-理解层/选题库', '内容选题、创作灵感和素材方向'],
  ['questions', '用户问题库', '01_UNDERSTAND-理解层/用户问题库', '用户需求、痛点、访谈与问题反馈'],
  ['content', '内容引擎', '02_CONTENT-内容引擎', '文章草稿和内容创作材料'],
  ['projects', '项目沉淀', '03_BUILD-项目沉淀', '项目实施、设计和交付记录'],
  ['output', '发布复盘', '04_OUTPUT-发布复盘', '发布记录、效果分析与复盘'],
  ['assets', '资产库', '05_ASSETS-资产库', '可长期复用的资源与资产'],
  ['wiki', '知识库', '06_WIKI-知识库', '概念、理论、研究和参考知识'],
  ['archive', '归档', '99_ARCHIVE-归档', '已结束或仅保留备查的材料']
];
export const defaultDestinations = (): Destination[] => definitions.map(([id, name, path, description]) => ({ id, name, path, description, enabled: true }));
export const defaultSettings = (): Settings => ({ provider: 'deepseek', apiKey: '', ...PROVIDERS.deepseek,
  chunkSize: 12000, initialized: false, destinations: defaultDestinations() });
export const FOLDERS = [
  '00_INPUT-输入池/每日记录', INBOX, SOURCES,
  ...definitions.map(x => x[2]), '01_UNDERSTAND-理解层/周复盘', ORIGINALS, '07_SYSTEM-系统'
];
export const HOME = `# 知流工作台\n\n从输入到理解，再到创作与沉淀。\n\n使用左侧「知流工作台」图标，或命令面板中的「打开知流工作台」，导入文档并预览归档建议。\n\n## 工作流\n\n${['00_INPUT-输入池','01_UNDERSTAND-理解层','02_CONTENT-内容引擎','03_BUILD-项目沉淀','04_OUTPUT-发布复盘','05_ASSETS-资产库','06_WIKI-知识库','07_SYSTEM-系统','99_ARCHIVE-归档'].map(x => '- ' + x).join('\n')}\n\n## 入口\n\n- [[07_SYSTEM-系统/工作流说明|目录用途与操作说明]]\n\n文档先进入输入池，AI 分析后由你确认。原文件保存在资产库，整理笔记归入对应目标库。\n`;
