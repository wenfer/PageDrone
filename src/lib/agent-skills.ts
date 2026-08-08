/**
 * 内置 AI 工具库（Agent Skills）—— 对话式代理可调用的能力白名单。
 *
 * 设计目标是「尽量减少推理产生的不确定因素」，手段是四层：
 *  1. 白名单 + 机器可读的参数声明（SKILLS 表），prompt 里的 AI 工具文档由这张表
 *     自动生成（renderSkillCatalog），不存在第二份需要同步的副本。
 *  2. 执行前强制校验（validateSkillCall / validateStep），校验失败时把
 *     「正确签名」回灌给模型让它自己改——比让它凭空猜有效得多。
 *  3. 只读 AI 工具（含测试报告、流程和页面观察）先于写入工具提供，
 *     让模型先看清现状再动手。
 *  4. 所有接收 id 的 AI 工具都校验 id 真实存在，并在报错里列出当前可用 id，
 *     从根上掐掉「模型编一个 proc_xxx」这类幻觉。
 *
 * 本文件在 Service Worker 侧运行，不得引用 DOM。
 */

import {
  createProcedure,
  createSite,
  type Procedure,
  type Site,
  type Flow,
  type Step,
  type StepType,
} from './models.js';
import { createFlow, getFlows, saveFlow } from './flows.js';
import {
  getProcedure,
  getLogs,
  getProcedures,
  getSites,
  updateSiteLastResult,
  upsertProcedure,
  upsertSite,
} from './storage.js';
import { runFlowTest } from './flow-test.js';
import type { PageObservation } from './types.js';

// —— AI 工具声明 ——

export type SkillArgType = 'string' | 'number' | 'boolean' | 'string[]' | 'object';

export interface SkillArgDef {
  type: SkillArgType;
  required?: boolean;
  /** 取值必须落在此集合内（配合 type:'string'） */
  enum?: readonly string[];
  desc: string;
}

/** AI 工具分组：决定 prompt 里的排列顺序与「是否需要用户确认」 */
export type SkillGroup = 'read' | 'write' | 'browser' | 'control';

export interface SkillDef {
  name: string;
  group: SkillGroup;
  summary: string;
  args: Record<string, SkillArgDef>;
  returns: string;
  /** 昂贵 AI 工具：真开浏览器标签 / 真烧 token，UI 侧据此决定是否先征求确认 */
  costly?: boolean;
}

const STEP_TYPES: readonly StepType[] = [
  'click',
  'type',
  'goto',
  'wait',
  'waitFor',
  'waitForText',
  'waitForUrl',
  'manual',
  'extract',
];

export const SKILLS: readonly SkillDef[] = [
  // —— 只读 ——
  {
    name: 'list-procedures',
    group: 'read',
    summary: '列出全部已有可编排技能（Procedure）。动手改任何技能之前先调用它拿到真实 id。',
    args: {},
    returns: '{ procedures: [{ id, name, kind, siteId, stepCount, url }] }',
  },
  {
    name: 'list-sites',
    group: 'read',
    summary: '列出全部已配置站点（Site）。',
    args: {},
    returns: '{ sites: [{ id, name, url, enabled, skillCount, checkinProcedureId, loginProcedureId, verificationProcedureId }] }',
  },
  {
    name: 'get-procedure',
    group: 'read',
    summary: '读取单个可编排技能的完整内容（含全部步骤）。修改已有技能的步骤前必须先读。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
    },
    returns: '{ procedure: { id, name, kind, siteId, url, description, script, detect, steps: [...], output, lastResult } }',
  },
  {
    name: 'get-site',
    group: 'read',
    summary: '读取单个站点的完整配置和最近执行结果，用于诊断技能为什么没有按预期执行。不会返回 AI API Key 等敏感设置。',
    args: {
      siteId: { type: 'string', required: true, desc: '站点 id' },
    },
    returns: '{ site: { id, name, url, enabled, mode, skill bindings, schedule, timeouts, lastResult } }',
  },
  {
    name: 'list-logs',
    group: 'read',
    summary: '查看最近的本地执行日志，可按站点筛选。修复技能前先用它确认实际失败步骤和错误信息。',
    args: {
      siteId: { type: 'string', desc: '可选：只查看该站点的日志' },
      limit: { type: 'number', desc: '返回条数，默认 20，最多 50' },
    },
    returns: '{ logs: [{ id, siteId, siteName, status, message, startedAt, finishedAt, cfWaitedMs }] }',
  },
  {
    name: 'list-flows',
    group: 'read',
    summary: '列出流程及其节点引用；测试或修复流程前先拿到真实 flowId。',
    args: {},
    returns: '{ flows: [{ id, name, nodeCount, procedureIds }] }',
  },
  {
    name: 'get-flow',
    group: 'read',
    summary: '读取流程完整节点、连线和变量；测试流程发现节点问题后必须先读取它。',
    args: {
      flowId: { type: 'string', required: true, desc: '流程 id' },
    },
    returns: '{ flow: { id, name, description, nodes: [...], edges: [...], variables } }',
  },

  // —— 写入 ——
  {
    name: 'create-procedure',
    group: 'write',
    summary: '创建一个新的可编排技能。创建后会返回它的 id，后续用 add-step 往里加步骤；login 登录技能只使用标准点击/等待动作，不添加 manual 人工步骤。',
    args: {
      name: { type: 'string', required: true, desc: '技能名称，简短可辨识' },
      siteId: { type: 'string', required: true, desc: '所属网站 id；必须先通过 list-sites 获取真实 id' },
      kind: {
        type: 'string',
        required: true,
        enum: ['checkin', 'login', 'verification'],
        desc: "技能种类：'checkin' 自动化技能 / 'login' 登录技能 / 'verification' 验证技能",
      },
      url: { type: 'string', desc: '目标网址（http/https 开头）' },
      description: { type: 'string', desc: '技能说明' },
      clearSteps: {
        type: 'boolean',
        desc: '是否清空工厂预置的示例步骤，默认 true。要自己从零加步骤时保持 true。',
      },
      outputEnabled: { type: 'boolean', desc: '是否让该技能向流程调用方返回提取结果' },
      outputFields: { type: 'string[]', desc: '要返回的结果字段名；留空表示返回全部 extract 结果' },
    },
    returns: '{ procedureId, name, kind, siteId, stepCount, output }',
  },
  {
    name: 'add-step',
    group: 'write',
    summary: '往可编排技能末尾追加一个执行步骤。login 登录技能禁止添加 manual；执行器会自动提交 Chrome 自动填充的普通表单。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      step: {
        type: 'object',
        required: true,
        desc:
          '步骤对象，必须含 type 字段。各 type 的必填字段：' +
          "click{selector} / type{selector,text} / goto{url} / wait{ms} / " +
          'waitFor{selector} / waitForText{selector,includes} / waitForUrl{match} / manual{message} / ' +
          'extract{selector,mode,variable}',
      },
    },
    returns: '{ procedureId, stepIndex, stepCount }',
  },
  {
    name: 'update-step',
    group: 'write',
    summary: '整体替换可编排技能中某一个步骤（不是局部合并）。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      stepIndex: { type: 'number', required: true, desc: '步骤下标，从 0 开始' },
      step: { type: 'object', required: true, desc: '新的完整步骤对象，字段要求同 add-step' },
    },
    returns: '{ procedureId, stepIndex, stepCount }',
  },
  {
    name: 'remove-step',
    group: 'write',
    summary: '删除可编排技能中某一个步骤。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      stepIndex: { type: 'number', required: true, desc: '步骤下标，从 0 开始' },
    },
    returns: '{ procedureId, stepCount }',
  },
  {
    name: 'replace-steps',
    group: 'write',
    summary: '整体替换一个技能的标准操作序列。适合根据 get-procedure 和 list-logs 的诊断结果一次性重排修复步骤；会覆盖原步骤，执行前必须得到用户明确指令。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      steps: { type: 'object', required: true, desc: '步骤数组；每个步骤字段要求同 add-step' },
    },
    returns: '{ procedureId, stepCount, steps }',
  },
  {
    name: 'update-procedure',
    group: 'write',
    summary: '修改已有技能的名称、说明、目标网址或自定义脚本。不会改变技能所属网站、类型、来源或本地历史；清空脚本请使用 clearScript=true。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      name: { type: 'string', desc: '技能名称' },
      description: { type: 'string', desc: '技能说明' },
      url: { type: 'string', desc: '目标网址（http/https 开头）' },
      script: { type: 'string', desc: '自定义脚本；技能存在标准步骤时通常不会执行脚本' },
      clearScript: { type: 'boolean', desc: '是否清空现有自定义脚本' },
    },
    returns: '{ procedureId, name, description, url, scriptLength, stepCount }',
  },
  {
    name: 'set-detect',
    group: 'write',
    summary: '设置技能的结果判定条件。checkin 用关键词，login 用登录态，verification 用验证完成信号。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      successKeywords: { type: 'string[]', desc: '仅 checkin：命中即判成功的页面文字' },
      failKeywords: { type: 'string[]', desc: '仅 checkin：命中即判失败的页面文字' },
      loggedInSelector: { type: 'string', desc: '仅 login：出现即代表已登录的选择器' },
      loggedInUrlIncludes: { type: 'string', desc: '仅 login：已登录时网址应包含的片段' },
      loginUrlPattern: { type: 'string', desc: '登录页网址特征，命中代表掉线' },
      notLoggedInKeywords: { type: 'string[]', desc: '仅 login：代表未登录的页面文字' },
      completedSelector: { type: 'string', desc: '仅 verification：出现即代表验证完成的选择器' },
      completedUrlIncludes: { type: 'string', desc: '仅 verification：验证完成后 URL 应包含的片段' },
    },
    returns: '{ procedureId, detect }',
  },
  {
    name: 'set-output',
    group: 'write',
    summary: '配置技能是否向流程返回数据；通常先添加 extract 步骤，再选择要暴露的结果字段。',
    args: {
      procedureId: { type: 'string', required: true, desc: '技能 id' },
      enabled: { type: 'boolean', required: true, desc: '是否启用技能返回值' },
      fields: { type: 'string[]', desc: '要返回的 extract 变量名；留空或空数组表示返回全部结果' },
    },
    returns: '{ procedureId, output }',
  },
  {
    name: 'create-site',
    group: 'write',
    summary: '创建站点，把技能绑定到一个网址上并可配置每日定时。',
    args: {
      name: { type: 'string', required: true, desc: '站点名称' },
      url: { type: 'string', required: true, desc: '站点网址（http/https 开头）' },
      checkinProcedureId: { type: 'string', desc: '绑定的自动化技能 id' },
      loginProcedureId: { type: 'string', desc: '绑定的登录技能 id' },
      verificationProcedureId: { type: 'string', desc: '绑定的验证技能 id' },
      scheduleEnabled: { type: 'boolean', desc: '是否开启每日定时' },
      scheduleHour: { type: 'number', desc: '定时的小时 0-23' },
      scheduleMinute: { type: 'number', desc: '定时的分钟 0-59' },
    },
    returns: '{ siteId, name, url }',
  },
  {
    name: 'update-site',
    group: 'write',
    summary: '更新已有站点的配置。',
    args: {
      siteId: { type: 'string', required: true, desc: '站点 id' },
      name: { type: 'string', desc: '站点名称' },
      url: { type: 'string', desc: '站点网址' },
      enabled: { type: 'boolean', desc: '是否启用' },
      checkinProcedureId: { type: 'string', desc: '绑定的自动化技能 id' },
      loginProcedureId: { type: 'string', desc: '绑定的登录技能 id' },
      verificationProcedureId: { type: 'string', desc: '绑定的验证技能 id；空字符串表示取消绑定' },
      scheduleEnabled: { type: 'boolean', desc: '是否开启每日定时' },
      scheduleHour: { type: 'number', desc: '定时的小时 0-23' },
      scheduleMinute: { type: 'number', desc: '定时的分钟 0-59' },
    },
    returns: '{ siteId, name, url, enabled }',
  },
  {
    name: 'create-flow',
    group: 'write',
    summary: '创建流程（画布节点图）。可按 procedureIds 串行编排，也可选择当前所有站点并保存同步策略。登录技能默认排除。',
    args: {
      name: { type: 'string', required: true, desc: '流程名称' },
      description: { type: 'string', desc: '流程说明' },
      procedureIds: { type: 'string[]', desc: '要串行执行的技能 id，按先后顺序' },
      siteScope: { type: 'string', enum: ['explicit', 'all-sites'], desc: 'explicit 使用 procedureIds；all-sites 使用当前站点集合' },
      includeDisabled: { type: 'boolean', desc: 'all-sites 时是否包含禁用站点，默认 false' },
      includeMissingSiteId: { type: 'boolean', desc: '是否包含没有 siteId 的旧技能，默认 false（无法安全归属时会跳过）' },
      includeLoginProcedures: { type: 'boolean', desc: '是否包含登录技能，默认 false' },
      autoSyncSites: { type: 'boolean', desc: '执行前自动把新增站点追加到流程，默认 false' },
    },
    returns: '{ flowId, name, nodeCount }',
  },
  {
    name: 'update-flow-node',
    group: 'write',
    summary: '定点修改流程中一个节点的配置，保留其他节点、连线和变量；修改后必须重新测试流程。',
    args: {
      flowId: { type: 'string', required: true, desc: '流程 id' },
      nodeId: { type: 'string', required: true, desc: '节点 id，必须来自 get-flow' },
      data: { type: 'object', required: true, desc: '要合并到节点 data 的字段，例如 selector、url、procedureId' },
    },
    returns: '{ flowId, nodeId, nodeType, data }',
  },

  // —— 浏览器 ——
  {
    name: 'read-page',
    group: 'browser',
    summary:
      '打开一个网址、采样一次页面状态后关闭标签。写 selector 之前用它看清真实 DOM，' +
      '不要凭猜写选择器。比 explore-page 便宜得多，优先用这个。',
    args: {
      url: { type: 'string', required: true, desc: '要查看的网址（http/https 开头）' },
    },
    returns: '{ url, title, text, elements: [{ tag, text, selector }] }',
    costly: true,
  },
  {
    name: 'test-procedure',
    group: 'browser',
    summary:
      '在隔离标签页真实执行一个技能，并在每个步骤前后采样 URL、标题、页面正文和可交互元素。' +
      '返回的是页面事实和失败步骤；不会修改技能或日志，若确认登录失效只在站点上标记“需要登录”。如果用户要求修复，读取报告后再调用写入工具并重新测试。',
    args: {
      procedureId: { type: 'string', required: true, desc: '要测试的技能 id' },
      url: { type: 'string', desc: '可选：本次测试使用的目标网址；留空按技能/所属网站推导' },
    },
    returns: '{ testOk, status, message, siteId, siteName, loginRequired, loginHint, loginSignals, failedStepIndex, failedStepType, observations: [...] }',
    costly: true,
  },
  {
    name: 'test-flow',
    group: 'browser',
    summary:
      '打开隔离的 React Flow 画布，使用正式流程执行引擎真实运行流程并回传节点日志、变量和技能页面观察。' +
      '不会自动改流程；发现问题后先读取真实配置，再根据用户意图修改并重测。',
    args: {
      flowId: { type: 'string', required: true, desc: '要测试的流程 id' },
    },
    returns: '{ testOk, status, message, logs: [...], nodeReports: [{siteName,nodeName,procedureId,status,durationMs,errorType,failedStepIndex,repairHint}], summary, variables: {...} }',
    costly: true,
  },
  {
    name: 'explore-page',
    group: 'browser',
    summary:
      '完整 AI 探索：真开标签，反复「看页面→决策→操作」直到达成目标，并把过程归纳成一个新技能。' +
      '很贵（多轮大模型调用 + 真实浏览器操作）。只在用户明确要求分析/自动生成整套流程时调用；' +
      '能靠 read-page 加手写步骤解决的，不要用它。成功路径会固化为标准动作步骤，不生成脚本。',
    args: {
      url: { type: 'string', required: true, desc: '起始网址（http/https 开头）' },
      siteId: { type: 'string', required: true, desc: '生成技能所属网站 id；必须先通过 list-sites 获取真实 id' },
      goal: { type: 'string', required: true, desc: '要达成的目标，一句话描述' },
      successKeywords: { type: 'string[]', desc: '出现即代表目标达成的页面文字' },
    },
    returns: '{ ok, procedureId, siteId, stepCount, message }',
    costly: true,
  },

  // —— 控制 ——
  {
    name: 'ask',
    group: 'control',
    summary:
      '信息不足时向用户提问并暂停。缺少网址、缺少选择器依据、或用户意图有多种理解时用它，' +
      '不要自己编造缺失的信息。',
    args: {
      question: { type: 'string', required: true, desc: '要问用户的问题' },
    },
    returns: '（暂停本轮，等待用户回复）',
  },
  {
    name: 'done',
    group: 'control',
    summary: '本轮工作完成，给用户一个总结。',
    args: {
      summary: { type: 'string', required: true, desc: '这轮做了什么，用户视角的简明总结' },
    },
    returns: '（结束本轮）',
  },
];

const SKILL_BY_NAME = new Map(SKILLS.map((s) => [s.name, s]));

export function getSkill(name: string): SkillDef | undefined {
  return SKILL_BY_NAME.get(name);
}

export function isCostlySkill(name: string): boolean {
  return !!SKILL_BY_NAME.get(name)?.costly;
}

// —— prompt 文档生成（唯一真相源就是上面的 SKILLS 表）——

function renderArgs(args: Record<string, SkillArgDef>): string {
  const entries = Object.entries(args);
  if (!entries.length) return '    参数：无';
  const lines = entries.map(([name, def]) => {
    const flag = def.required ? '必填' : '可选';
    const enumHint = def.enum ? `，取值 ${def.enum.map((v) => `"${v}"`).join(' | ')}` : '';
    return `    - ${name} (${def.type}, ${flag}${enumHint})：${def.desc}`;
  });
  return `    参数：\n${lines.join('\n')}`;
}

const GROUP_TITLE: Record<SkillGroup, string> = {
  read: '只读 AI 工具（先用这些看清现状）',
  write: '写入 AI 工具（改扩展本地数据，快且确定）',
  browser: '浏览器 AI 工具（会真的打开标签页，开销大）',
  control: '控制 AI 工具',
};

/** 生成进 system prompt 的 AI 工具目录 */
export function renderSkillCatalog(): string {
  const groups: SkillGroup[] = ['read', 'write', 'browser', 'control'];
  const blocks = groups.map((g) => {
    const items = SKILLS.filter((s) => s.group === g).map(
      (s) => `  ${s.name}\n    说明：${s.summary}\n${renderArgs(s.args)}\n    返回：${s.returns}`
    );
    return `【${GROUP_TITLE[g]}】\n${items.join('\n\n')}`;
  });
  return blocks.join('\n\n');
}

/** 步骤类型的必填字段表——与 models.ts 的 Step 判别联合一一对应 */
const STEP_REQUIRED: Record<StepType, readonly string[]> = {
  click: ['selector'],
  type: ['selector', 'text'],
  goto: ['url'],
  wait: ['ms'],
  waitFor: ['selector'],
  waitForText: ['selector', 'includes'],
  waitForUrl: ['match'],
  manual: ['message'],
  extract: ['selector', 'mode', 'variable'],
};

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * 校验步骤对象。
 * 报错信息要足够具体，让模型下一轮能直接改对——这是自我修正的关键。
 */
export function validateStep(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'step 必须是一个对象' };
  }
  const step = raw as Record<string, unknown>;
  const type = step.type;
  if (typeof type !== 'string' || !STEP_TYPES.includes(type as StepType)) {
    return {
      ok: false,
      error: `step.type 无效：${JSON.stringify(type)}。可用类型：${STEP_TYPES.join(' | ')}`,
    };
  }
  const required = STEP_REQUIRED[type as StepType];
  const missing = required.filter((f) => {
    const v = step[f];
    return v === undefined || v === null || (typeof v === 'string' && v === '');
  });
  if (missing.length) {
    return {
      ok: false,
      error: `type 为 "${type}" 的步骤缺少必填字段：${missing.join('、')}。该类型完整必填字段为 ${required.join('、')}`,
    };
  }
  if (type === 'wait' && typeof step.ms !== 'number') {
    return { ok: false, error: 'wait 步骤的 ms 必须是数字（毫秒）' };
  }
  if (type === 'goto' && !/^https?:\/\//i.test(String(step.url))) {
    return { ok: false, error: 'goto 步骤的 url 必须是 http:// 或 https:// 开头的完整网址' };
  }
  if (type === 'extract') {
    const modes = ['text', 'attribute', 'html', 'value', 'list', 'table'];
    if (!modes.includes(String(step.mode))) {
      return { ok: false, error: `extract.mode 必须是 ${modes.join(' | ')}` };
    }
    if (step.mode === 'attribute' && !String(step.attribute || '').trim()) {
      return { ok: false, error: 'extract 使用 attribute 模式时必须提供 attribute' };
    }
  }
  return { ok: true };
}

/** 校验 AI 工具调用时所需的现场上下文（用于 id 存在性检查） */
export interface SkillContext {
  procedures: Procedure[];
  sites: Site[];
  flows: Flow[];
  settings: import('./models.js').Settings;
  signal: import('./cancellation.js').CancellationToken;
  onProgress?: (message: string) => void;
}

function typeOf(v: unknown): SkillArgType | 'unknown' {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'string[]';
  if (v && typeof v === 'object') return 'object';
  return 'unknown';
}

/**
 * 执行前校验：AI 工具名 → 必填参数 → 类型 → enum → id 存在性 → step 结构。
 * 任何一环失败都返回一条「带正确签名或可用 id 列表」的错误，供上层回灌给模型。
 */
export function validateSkillCall(
  name: string,
  args: Record<string, unknown>,
  ctx: SkillContext
): ValidationResult {
  const skill = SKILL_BY_NAME.get(name);
  if (!skill) {
    return {
      ok: false,
      error: `AI 工具 "${name}" 不存在。可用 AI 工具：${SKILLS.map((s) => s.name).join('、')}`,
    };
  }

  for (const [argName, def] of Object.entries(skill.args)) {
    const v = args[argName];
    const absent = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (absent) {
      if (def.required) {
        return {
          ok: false,
          error: `调用 ${name} 缺少必填参数 "${argName}"。${name} 的完整签名：\n${renderArgs(skill.args)}`,
        };
      }
      continue;
    }
    const actual = typeOf(v);
    // string[] 允许传单个字符串，规范化在 execute 里做；数字允许数字字符串
    const compatible =
      actual === def.type ||
      (def.type === 'string[]' && actual === 'string') ||
      (name === 'replace-steps' && argName === 'steps' && Array.isArray(v)) ||
      (def.type === 'number' && actual === 'string' && !Number.isNaN(Number(v)));
    if (!compatible) {
      return {
        ok: false,
        error: `调用 ${name} 的参数 "${argName}" 类型应为 ${def.type}，收到 ${actual}。${name} 的完整签名：\n${renderArgs(skill.args)}`,
      };
    }
    if (def.enum && !def.enum.includes(String(v))) {
      return {
        ok: false,
        error: `调用 ${name} 的参数 "${argName}" 取值必须是 ${def.enum.map((x) => `"${x}"`).join(' | ')}，收到 ${JSON.stringify(v)}`,
      };
    }
  }

  // id 存在性：报错时列出真实可用 id，掐掉编造 id 的可能
  const procIdKeys = ['procedureId', 'checkinProcedureId', 'loginProcedureId', 'verificationProcedureId'];
  for (const key of procIdKeys) {
    const v = args[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const procedure = ctx.procedures.find((p) => p.id === v);
    if (!procedure) {
      const avail = ctx.procedures.length
        ? ctx.procedures.map((p) => `${p.id}（${p.name}）`).join('、')
        : '（当前没有任何技能，请先用 create-procedure 创建）';
      return { ok: false, error: `${key} "${v}" 不存在。当前可用技能：${avail}` };
    }
    const expectedKind = key === 'checkinProcedureId'
      ? 'checkin'
      : key === 'loginProcedureId'
        ? 'login'
        : key === 'verificationProcedureId'
          ? 'verification'
          : null;
    if (expectedKind && procedure.kind !== expectedKind) {
      return {
        ok: false,
        error: `${key} 需要 ${expectedKind} 技能，但「${procedure.name}」的类型是 ${procedure.kind}`,
      };
    }
  }
  if (typeof args.siteId === 'string' && args.siteId.trim()) {
    if (!ctx.sites.some((s) => s.id === args.siteId)) {
      const avail = ctx.sites.length
        ? ctx.sites.map((s) => `${s.id}（${s.name}）`).join('、')
        : '（当前没有任何站点）';
      return { ok: false, error: `siteId "${String(args.siteId)}" 不存在。当前可用站点：${avail}` };
    }
  }
  if (Array.isArray(args.procedureIds)) {
    for (const pid of args.procedureIds) {
      if (!ctx.procedures.some((p) => p.id === pid)) {
        const avail = ctx.procedures.map((p) => `${p.id}（${p.name}）`).join('、') || '（无）';
        return { ok: false, error: `procedureIds 里的 "${String(pid)}" 不存在。当前可用技能：${avail}` };
      }
    }
  }
  if (typeof args.flowId === 'string' && args.flowId.trim()) {
    const flow = ctx.flows.find((item) => item.id === args.flowId);
    if (!flow) {
      const avail = ctx.flows.length
        ? ctx.flows.map((flow) => `${flow.id}（${flow.name}）`).join('、')
        : '（当前没有任何流程，请先创建流程）';
      return { ok: false, error: `flowId "${args.flowId}" 不存在。当前可用流程：${avail}` };
    }
    if (name === 'update-flow-node') {
      const nodeId = String(args.nodeId || '').trim();
      if (!flow.nodes.some((node) => node.id === nodeId)) {
        return { ok: false, error: `nodeId "${nodeId}" 不存在于流程「${flow.name}」，请先用 get-flow 查看真实节点 id` };
      }
    }
  }

  if (name === 'add-step' || name === 'update-step') {
    const r = validateStep(args.step);
    if (!r.ok) return r;
    const procedure = typeof args.procedureId === 'string'
      ? ctx.procedures.find((item) => item.id === args.procedureId)
      : undefined;
    if (procedure?.kind === 'login' && (args.step as Record<string, unknown>)?.type === 'manual') {
      return { ok: false, error: '登录技能不能添加 manual 人工步骤。请使用真实登录入口的 click/goto/wait/waitFor/waitForUrl 标准动作；执行器会自动提交 Chrome 自动填充的账号密码。' };
    }
  }
  if (name === 'replace-steps') {
    if (!Array.isArray(args.steps)) return { ok: false, error: 'replace-steps 的 steps 必须是数组' };
    const procedure = typeof args.procedureId === 'string'
      ? ctx.procedures.find((item) => item.id === args.procedureId)
      : undefined;
    for (const [index, step] of args.steps.entries()) {
      const r = validateStep(step);
      if (!r.ok) return { ok: false, error: `steps[${index}] 无效：${r.error}` };
      if (procedure?.kind === 'login' && (step as Record<string, unknown>)?.type === 'manual') {
        return { ok: false, error: `steps[${index}]：登录技能不能添加 manual 人工步骤，请改用标准点击/等待动作。` };
      }
    }
  }
  if ((name === 'read-page' || name === 'test-procedure' || name === 'explore-page' || name === 'create-site' || name === 'update-procedure') &&
      typeof args.url === 'string' && !/^https?:\/\//i.test(args.url)) {
    return { ok: false, error: `url 必须是 http:// 或 https:// 开头的完整网址，收到 "${args.url}"` };
  }

  return { ok: true };
}

// —— 执行 ——

export interface SkillResult {
  ok: boolean;
  /** 回灌给模型的结果数据（会被 JSON 序列化） */
  data?: Record<string, unknown>;
  /** 失败原因，同样回灌给模型 */
  error?: string;
  /** 本次调用新建/改动的实体，供 UI 展示与「撤销」入口 */
  touched?: { kind: 'procedure' | 'site' | 'flow'; id: string; name: string }[];
  /** control 类 AI 工具的语义：暂停等用户 / 结束本轮 */
  halt?: 'ask' | 'done';
  /** halt 时给用户看的文本 */
  text?: string;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function summarizeObservation(observation: PageObservation): string {
  const change = observation.changes.length ? `；${observation.changes.join('、')}` : '';
  const text = String(redactAgentValue(observation.text)).replace(/\s+/g, ' ').trim().slice(0, 260);
  const elements = observation.elements
    .slice(0, 8)
    .map((element) => {
      const elementText = String(redactAgentValue(element.text));
      return `${element.tag}${elementText ? `「${elementText}」` : ''}`;
    })
    .join('、');
  return `页面观察：${observation.phase} · 步骤 ${observation.stepIndex >= 0 ? observation.stepIndex + 1 : '打开'} · ${observation.url}${change}${text ? `；正文：${text}` : ''}${elements ? `；交互：${elements}` : ''}`;
}

function redactPageElements<T extends { type?: string; text?: string }>(elements: T[]): Array<T & { text: string }> {
  return elements.map((element) => ({
    ...element,
    text: element.type?.toLowerCase() === 'password'
      ? '[密码字段]'
      : String(redactAgentValue(element.text || '')),
  }));
}

const AGENT_SENSITIVE_KEY = /(?:api[-_ ]?key|authorization|cookie|password|passwd|secret|token|credential|headers?)/i;
const AGENT_TOKEN = /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g;

/**
 * 清理回灌给模型和持久化到 AI 会话的值。headers 作为整体隐藏，避免字符串形式的
 * Authorization/API Key 绕过字段名检测；普通长 token 仍由 AGENT_TOKEN 兜底遮盖。
 */
export function redactAgentValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (AGENT_SENSITIVE_KEY.test(key)) return '[已隐藏]';
  if (typeof value === 'string') return value.replace(AGENT_TOKEN, '[已隐藏]');
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactAgentValue(item, '', seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
    entryKey,
    redactAgentValue(entryValue, entryKey, seen),
  ]));
}

function compactObservations(observations: PageObservation[]): Array<Record<string, unknown>> {
  return observations.slice(-24).map((observation) => ({
    at: observation.at,
    phase: observation.phase,
    stepIndex: observation.stepIndex,
    stepType: observation.stepType,
    url: observation.url,
    title: observation.title,
    changed: observation.changed,
    changes: observation.changes,
    text: String(redactAgentValue(observation.text)).slice(0, 900),
    elements: redactAgentValue(observation.elements.slice(0, 20)),
  }));
}

/** 从页面快照提取登录表单的非敏感事实，帮助 Agent 区分普通表单与弹窗授权。 */
function inferLoginPageSignals(observations: PageObservation[]): Record<string, boolean> {
  const elements = observations.flatMap((observation) => observation.elements || []);
  const hasPasswordField = elements.some((element) => element.type?.toLowerCase() === 'password');
  const hasLoginButton = elements.some((element) => {
    const text = `${element.text || ''} ${element.type || ''}`;
    return /登录|登錄|sign\s*in|log\s*in|submit/i.test(text);
  });
  return {
    hasPasswordField,
    hasLoginButton,
    ordinaryFormLikely: hasPasswordField && hasLoginButton,
  };
}

/** 供 prompt 使用的紧凑技能摘要 */
export function summarizeProcedure(p: Procedure): Record<string, unknown> {
  return { id: p.id, name: p.name, kind: p.kind, siteId: p.siteId || '', stepCount: p.steps.length, url: p.url || '', hasOutput: p.output?.enabled === true };
}

export function summarizeSite(s: Site, skillCount?: number): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    enabled: s.enabled,
    ...(skillCount === undefined ? {} : { skillCount }),
    checkinProcedureId: s.checkinProcedureId,
    loginProcedureId: s.loginProcedureId,
    verificationProcedureId: s.verificationProcedureId,
  };
}

export function summarizeFlow(flow: Flow): Record<string, unknown> {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    nodeCount: flow.nodes.length,
    edgeCount: flow.edges.length,
    procedureIds: flow.nodes
      .filter((node) => node.type === 'procedure' && typeof node.data?.procedureId === 'string')
      .map((node) => String(node.data?.procedureId)),
  };
}

async function validateSiteBindings(site: Site): Promise<string | null> {
  const bindings: Array<[string, string | null, Procedure['kind']]> = [
    ['自动化技能', site.checkinProcedureId, 'checkin'],
    ['登录技能', site.loginProcedureId, 'login'],
    ['验证技能', site.verificationProcedureId, 'verification'],
  ];
  for (const [label, procedureId, expectedKind] of bindings) {
    if (!procedureId) continue;
    const procedure = await getProcedure(procedureId);
    if (!procedure) return `${label} ${procedureId} 不存在，请先用 list-procedures 获取真实 id`;
    if (procedure.siteId !== site.id) return `${label}「${procedure.name}」属于其他网站，不能绑定到「${site.name}」；请先为当前网站创建或安装一份技能`;
    if (procedure.kind !== expectedKind) return `${label}「${procedure.name}」类型为 ${procedure.kind}，需要 ${expectedKind} 技能`;
  }
  return null;
}

/**
 * 执行一个已通过校验的 AI 工具调用。
 * 约定：可预期的失败走 { ok:false, error } 回灌给模型自我修正；
 * 只有真正异常（storage 挂了之类）才抛出。
 */
export async function executeSkill(
  name: string,
  args: Record<string, unknown>,
  ctx: SkillContext
): Promise<SkillResult> {
  const report = (m: string) => ctx.onProgress?.(m);

  switch (name) {
    case 'list-procedures': {
      const [list, sites] = await Promise.all([getProcedures(), getSites()]);
      const siteNames = new Map(sites.map((site) => [site.id, site.name]));
      return {
        ok: true,
        data: {
          procedures: list.map((procedure) => ({
            ...summarizeProcedure(procedure),
            siteName: siteNames.get(procedure.siteId) || '',
            source: procedure.source,
            version: procedure.version,
          })),
        },
      };
    }

    case 'list-sites': {
      const list = await getSites();
      const procedures = await getProcedures();
      return { ok: true, data: { sites: list.map((site) => summarizeSite(site, procedures.filter((p) => p.siteId === site.id).length)) } };
    }

    case 'get-procedure': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      const site = (await getSites()).find((item) => item.id === proc.siteId);
      return {
        ok: true,
        data: {
          procedure: {
            id: proc.id,
            name: proc.name,
            kind: proc.kind,
            siteId: proc.siteId || '',
            siteName: site?.name || '',
            url: proc.url || '',
            description: proc.description,
            script: proc.script,
            version: proc.version,
            source: proc.source,
            marketId: proc.marketId || '',
            detect: proc.detect,
            steps: proc.steps,
            output: proc.output || { enabled: false, fields: [] },
            lastResult: proc.lastResult,
          },
        },
      };
    }

    case 'get-site': {
      const site = (await getSites()).find((item) => item.id === String(args.siteId));
      if (!site) return { ok: false, error: `站点 ${String(args.siteId)} 已不存在` };
      return {
        ok: true,
        data: {
          site: {
            id: site.id,
            name: site.name,
            url: site.url,
            enabled: site.enabled,
            mode: site.mode,
            checkinProcedureId: site.checkinProcedureId,
            loginProcedureId: site.loginProcedureId,
            verificationProcedureId: site.verificationProcedureId,
            cfTimeoutMs: site.cfTimeoutMs,
            pageLoadTimeoutMs: site.pageLoadTimeoutMs,
            stepsTimeoutMs: site.stepsTimeoutMs,
            keepTabOnError: site.keepTabOnError,
            openInBackground: site.openInBackground,
            schedule: site.schedule,
            lastResult: site.lastResult,
          },
        },
      };
    }

    case 'list-logs': {
      const siteId = typeof args.siteId === 'string' ? args.siteId.trim() : '';
      const limit = Math.min(50, Math.max(1, Math.floor(num(args.limit, 20))));
      const logs = (await getLogs())
        .filter((log) => !siteId || log.siteId === siteId)
        .slice(0, limit)
        .map((log) => ({
          id: log.id,
          taskId: log.taskId,
          siteId: log.siteId,
          siteName: log.siteName,
          status: log.status,
          message: log.message,
          startedAt: log.startedAt,
          finishedAt: log.finishedAt,
          cfWaitedMs: log.cfWaitedMs,
        }));
      return { ok: true, data: { logs, siteId: siteId || undefined, limit } };
    }

    case 'list-flows': {
      const flows = await getFlows();
      return { ok: true, data: { flows: flows.map(summarizeFlow) } };
    }

    case 'get-flow': {
      const flowId = String(args.flowId || '').trim();
      const flow = (await getFlows()).find((item) => item.id === flowId);
      if (!flow) return { ok: false, error: `流程 ${flowId} 已不存在` };
      return { ok: true, data: { flow: redactAgentValue(flow) as Record<string, unknown> } };
    }

    case 'create-procedure': {
      const kind: Procedure['kind'] = args.kind === 'login' || args.kind === 'verification'
        ? args.kind
        : 'checkin';
      const proc = createProcedure({
        kind,
        name: String(args.name),
        siteId: String(args.siteId),
        description: args.description ? String(args.description) : '',
        url: args.url ? String(args.url) : '',
        output: {
          enabled: args.outputEnabled === true,
          fields: toStringArray(args.outputFields),
        },
      });
      const site = (await getSites()).find((item) => item.id === proc.siteId);
      if (!site) return { ok: false, error: `网站 ${proc.siteId} 不存在，请先用 list-sites 获取真实 id` };
      if (!proc.url) proc.url = site.url;
      // 工厂会塞示例步骤，默认清空——模型接着会用 add-step 明确加自己要的步骤，
      // 留着示例反而会让它误以为已有步骤可用。
      if (args.clearSteps !== false) {
        proc.steps = [];
        // AI 会在后续通过 add-step 构建标准动作；清空示例步骤时也必须清空脚本模板，
        // 否则技能在尚未添加步骤的中间状态会被误认为脚本技能。
        proc.script = '';
      }
      const saved = await upsertProcedure(proc);
      report(`已创建技能「${saved.name}」`);
      return {
        ok: true,
        data: { procedureId: saved.id, name: saved.name, kind: saved.kind, siteId: saved.siteId, stepCount: saved.steps.length, output: saved.output },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'add-step': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      proc.steps.push(args.step as Step);
      const saved = await upsertProcedure(proc);
      report(`已给「${saved.name}」加第 ${saved.steps.length} 步`);
      return {
        ok: true,
        data: { procedureId: saved.id, stepIndex: saved.steps.length - 1, stepCount: saved.steps.length },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'update-step': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      const idx = num(args.stepIndex, -1);
      if (idx < 0 || idx >= proc.steps.length) {
        return {
          ok: false,
          error: `stepIndex ${idx} 越界，「${proc.name}」当前有 ${proc.steps.length} 个步骤（有效下标 0..${proc.steps.length - 1}）`,
        };
      }
      proc.steps[idx] = args.step as Step;
      const saved = await upsertProcedure(proc);
      return {
        ok: true,
        data: { procedureId: saved.id, stepIndex: idx, stepCount: saved.steps.length },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'remove-step': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      const idx = num(args.stepIndex, -1);
      if (idx < 0 || idx >= proc.steps.length) {
        return {
          ok: false,
          error: `stepIndex ${idx} 越界，「${proc.name}」当前有 ${proc.steps.length} 个步骤`,
        };
      }
      proc.steps.splice(idx, 1);
      const saved = await upsertProcedure(proc);
      return {
        ok: true,
        data: { procedureId: saved.id, stepCount: saved.steps.length },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'replace-steps': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      if (!Array.isArray(args.steps)) return { ok: false, error: 'steps 必须是数组' };
      proc.steps = args.steps as Step[];
      // 标准步骤序列是唯一事实来源；替换为标准步骤后不要继续执行旧脚本。
      proc.script = '';
      const saved = await upsertProcedure(proc);
      report(`已重写「${saved.name}」的 ${saved.steps.length} 个步骤`);
      return {
        ok: true,
        data: { procedureId: saved.id, stepCount: saved.steps.length, steps: saved.steps },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'update-procedure': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      if (args.name !== undefined) {
        const name = String(args.name).trim();
        if (!name) return { ok: false, error: '技能名称不能为空' };
        proc.name = name;
      }
      if (args.description !== undefined) proc.description = String(args.description);
      if (args.url !== undefined) proc.url = String(args.url).trim();
      if (args.script !== undefined) proc.script = String(args.script);
      if (args.clearScript === true) proc.script = '';
      const saved = await upsertProcedure(proc);
      report(`已更新技能「${saved.name}」`);
      return {
        ok: true,
        data: {
          procedureId: saved.id,
          name: saved.name,
          description: saved.description,
          url: saved.url || '',
          scriptLength: saved.script.length,
          stepCount: saved.steps.length,
        },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'set-detect': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      if (proc.kind === 'checkin') {
        const d = proc.detect;
        if (args.successKeywords !== undefined) d.successKeywords = toStringArray(args.successKeywords);
        if (args.failKeywords !== undefined) d.failKeywords = toStringArray(args.failKeywords);
        if (args.loginUrlPattern !== undefined) d.loginUrlPattern = String(args.loginUrlPattern);
      } else if (proc.kind === 'login') {
        const d = proc.detect;
        if (args.loggedInSelector !== undefined) d.loggedInSelector = String(args.loggedInSelector);
        if (args.loggedInUrlIncludes !== undefined) d.loggedInUrlIncludes = String(args.loggedInUrlIncludes);
        if (args.loginUrlPattern !== undefined) d.loginUrlPattern = String(args.loginUrlPattern);
        if (args.notLoggedInKeywords !== undefined) {
          d.notLoggedInKeywords = toStringArray(args.notLoggedInKeywords);
        }
      } else {
        const d = proc.detect;
        if (args.completedSelector !== undefined) d.completedSelector = String(args.completedSelector);
        if (args.completedUrlIncludes !== undefined) d.completedUrlIncludes = String(args.completedUrlIncludes);
      }
      const saved = await upsertProcedure(proc);
      return {
        ok: true,
        data: { procedureId: saved.id, detect: saved.detect as unknown as Record<string, unknown> },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'set-output': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      proc.output = {
        enabled: args.enabled === true,
        fields: args.fields === undefined ? (proc.output?.fields || []) : toStringArray(args.fields),
      };
      const saved = await upsertProcedure(proc);
      return {
        ok: true,
        data: { procedureId: saved.id, output: saved.output as unknown as Record<string, unknown> },
        touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
      };
    }

    case 'create-site': {
      const site = createSite({
        name: String(args.name),
        url: String(args.url),
        checkinProcedureId: args.checkinProcedureId ? String(args.checkinProcedureId) : '',
        loginProcedureId: args.loginProcedureId ? String(args.loginProcedureId) : null,
        verificationProcedureId: args.verificationProcedureId ? String(args.verificationProcedureId) : null,
      });
      const bindingError = await validateSiteBindings(site);
      if (bindingError) return { ok: false, error: bindingError };
      if (args.scheduleEnabled !== undefined) site.schedule.enabled = !!args.scheduleEnabled;
      if (args.scheduleHour !== undefined) site.schedule.hour = num(args.scheduleHour, site.schedule.hour);
      if (args.scheduleMinute !== undefined) {
        site.schedule.minute = num(args.scheduleMinute, site.schedule.minute);
      }
      const saved = await upsertSite(site);
      report(`已创建站点「${saved.name}」`);
      return {
        ok: true,
        data: { siteId: saved.id, name: saved.name, url: saved.url },
        touched: [{ kind: 'site', id: saved.id, name: saved.name }],
      };
    }

    case 'update-site': {
      const sites = await getSites();
      const site = sites.find((s) => s.id === String(args.siteId));
      if (!site) return { ok: false, error: `站点 ${String(args.siteId)} 已不存在` };
      if (args.name !== undefined) site.name = String(args.name);
      if (args.url !== undefined) site.url = String(args.url);
      if (args.enabled !== undefined) site.enabled = !!args.enabled;
      if (args.checkinProcedureId !== undefined) site.checkinProcedureId = String(args.checkinProcedureId);
      if (args.loginProcedureId !== undefined) {
        site.loginProcedureId = args.loginProcedureId ? String(args.loginProcedureId) : null;
      }
      if (args.verificationProcedureId !== undefined) {
        site.verificationProcedureId = args.verificationProcedureId ? String(args.verificationProcedureId) : null;
      }
      if (args.scheduleEnabled !== undefined) site.schedule.enabled = !!args.scheduleEnabled;
      if (args.scheduleHour !== undefined) site.schedule.hour = num(args.scheduleHour, site.schedule.hour);
      if (args.scheduleMinute !== undefined) {
        site.schedule.minute = num(args.scheduleMinute, site.schedule.minute);
      }
      const bindingError = await validateSiteBindings(site);
      if (bindingError) return { ok: false, error: bindingError };
      const saved = await upsertSite(site);
      return {
        ok: true,
        data: { siteId: saved.id, name: saved.name, url: saved.url, enabled: saved.enabled },
        touched: [{ kind: 'site', id: saved.id, name: saved.name }],
      };
    }

    case 'create-flow': {
      const allSites = await getSites();
      const all = await getProcedures();
      const siteScope = String(args.siteScope || 'explicit');
      const includeDisabled = args.includeDisabled === true;
      const includeMissingSiteId = args.includeMissingSiteId === true;
      const includeLoginProcedures = args.includeLoginProcedures === true;
      let procIds = toStringArray(args.procedureIds);
      const siteSync = siteScope === 'all-sites' ? {
        mode: 'all-sites' as const,
        includeDisabled,
        includeMissingSiteId,
        includeLoginProcedures,
        autoSync: args.autoSyncSites === true,
      } : undefined;
      if (siteScope === 'all-sites') {
        const allowedSites = allSites.filter((site) => includeDisabled || site.enabled);
        const candidates = all.filter((procedure) => {
          if (!includeLoginProcedures && procedure.kind === 'login') return false;
          if (!procedure.siteId) return includeMissingSiteId;
          return allowedSites.some((site) => site.id === procedure.siteId);
        });
        procIds = candidates.map((procedure) => procedure.id);
        if (procIds.length === 0) return { ok: false, error: '当前站点范围内没有可编排的技能；请确认站点已启用且技能已归属网站' };
      }
      // 串行链：start → 每个技能一个节点 → end，节点坐标按顺序铺开
      const nodes: import('./models.js').FlowNode[] = [];
      const edges: import('./models.js').FlowEdge[] = [];
      let x = 80;
      const y = 160;
      const startId = 'n_start';
      nodes.push({ id: startId, type: 'start', x, y, data: {} });
      let prev = startId;
      procIds.forEach((pid, i) => {
        x += 200;
        const nodeId = `n_proc_${i}`;
        const p = all.find((it) => it.id === pid);
        nodes.push({
          id: nodeId,
          type: 'procedure',
          x,
          y,
          data: { procedureId: pid, siteId: p?.siteId || '', label: p?.name || pid },
        });
        edges.push({ id: `e_${prev}_${nodeId}`, from: prev, to: nodeId });
        prev = nodeId;
      });
      x += 200;
      nodes.push({ id: 'n_end', type: 'end', x, y, data: {} });
      edges.push({ id: `e_${prev}_n_end`, from: prev, to: 'n_end' });

      const flow = createFlow({
        name: String(args.name),
        description: args.description ? String(args.description) : '',
        nodes,
        edges,
        siteSync,
      });
      const saved = await saveFlow(flow);
      report(`已创建流程「${saved.name}」`);
      return {
        ok: true,
        data: { flowId: saved.id, name: saved.name, nodeCount: saved.nodes.length },
        touched: [{ kind: 'flow', id: saved.id, name: saved.name }],
      };
    }

    case 'update-flow-node': {
      const flowId = String(args.flowId || '').trim();
      const nodeId = String(args.nodeId || '').trim();
      const flow = (await getFlows()).find((item) => item.id === flowId);
      if (!flow) return { ok: false, error: `流程 ${flowId} 已不存在` };
      const node = flow.nodes.find((item) => item.id === nodeId);
      if (!node) return { ok: false, error: `流程「${flow.name}」中不存在节点 ${nodeId}` };
      const data = args.data as Record<string, unknown>;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'update-flow-node 的 data 必须是对象' };
      }
      // 流程节点同时保存 siteId + procedureId。定点修复也必须沿用这条
      // 归属约束，避免 AI 把其他网站的技能误接到当前节点后才在运行期失败。
      const nextProcedureId = data.procedureId === undefined
        ? String(node.data?.procedureId || '').trim()
        : String(data.procedureId || '').trim();
      const nextSiteId = data.siteId === undefined
        ? String(node.data?.siteId || '').trim()
        : String(data.siteId || '').trim();
      if (node.type === 'procedure' || data.procedureId !== undefined) {
        if (!nextProcedureId) return { ok: false, error: '技能节点必须保留 procedureId，请先从 get-flow 获取真实技能 id' };
        const procedure = await getProcedure(nextProcedureId);
        if (!procedure) return { ok: false, error: `技能 ${nextProcedureId} 不存在，请先用 list-procedures 获取真实 id` };
        if (!nextSiteId) return { ok: false, error: '技能节点必须同时绑定 siteId' };
        if (!(await getSites()).some((site) => site.id === nextSiteId)) {
          return { ok: false, error: `站点 ${nextSiteId} 不存在，请先用 list-sites 获取真实 id` };
        }
        if (procedure.siteId !== nextSiteId) {
          return { ok: false, error: `技能「${procedure.name}」不属于站点 ${nextSiteId}，不能绑定到该节点` };
        }
        if (procedure.kind === 'login') {
          return { ok: false, error: '流程节点不能直接调用登录技能，请调用自动化技能或执行站点' };
        }
      } else if (node.type === 'site' && data.siteId !== undefined) {
        if (!nextSiteId || !(await getSites()).some((site) => site.id === nextSiteId)) {
          return { ok: false, error: `站点 ${nextSiteId || '(空)'} 不存在，请先用 list-sites 获取真实 id` };
        }
      }
      node.data = { ...(node.data || {}), ...data };
      const saved = await saveFlow(flow);
      report(`已更新流程「${saved.name}」的节点 ${nodeId}`);
      return {
        ok: true,
        data: { flowId: saved.id, nodeId, nodeType: node.type, data: redactAgentValue(node.data) as Record<string, unknown> },
        touched: [{ kind: 'flow', id: saved.id, name: saved.name }],
      };
    }

    case 'read-page': {
      report(`正在查看页面：${String(args.url)}`);
      // 动态 import：这两个模块会拉进 chrome.tabs / chrome.scripting，
      // 只在真正需要开标签时才加载。
      const { TabSession } = await import('./tab-session.js');
      const { samplePageState } = await import('./page/explorer-sample.js');
      let tab: import('./tab-session.js').TabSession | null = null;
      try {
        tab = await TabSession.create({ url: String(args.url), active: false }, ctx.signal);
        await tab.waitComplete(ctx.settings.defaultPageLoadTimeoutMs || 45000, 600);
        const state = await tab.inject(samplePageState, []);
        if (!state) return { ok: false, error: '未能读取页面状态（页面可能拒绝注入）' };
        return {
          ok: true,
          data: {
            url: state.url,
            title: state.title,
            text: String(redactAgentValue(state.text || '')).slice(0, 1500),
            elements: redactPageElements((state.elements || []).slice(0, 30)),
          },
        };
      } catch (e) {
        return { ok: false, error: `打开页面失败：${(e as Error)?.message || String(e)}` };
      } finally {
        // 只是看一眼，看完就关，不给用户留一堆标签
        if (tab) await tab.close().catch(() => {});
      }
    }

    case 'test-procedure': {
      const procedureId = String(args.procedureId || '').trim();
      const procedure = await getProcedure(procedureId);
      if (!procedure) return { ok: false, error: `技能 ${procedureId} 已不存在` };
      if (procedure.kind === 'login') {
        return { ok: false, error: `登录技能不能独立测试，请测试绑定该登录技能的站点或包含它的流程` };
      }
      const site = procedure.siteId ? (await getSites()).find((item) => item.id === procedure.siteId) : undefined;
      const url = String(args.url || procedure.url || site?.url || '').trim();
      if (!url) return { ok: false, error: `技能「${procedure.name}」没有可测试的网址，请补充 url 或先完善技能配置` };
      report(`开始测试技能「${procedure.name}」，会实时观察页面变化`);
      try {
        const { runProcedureStandalone } = await import('./run-context.js');
        const result = await runProcedureStandalone(procedureId, {
          url,
          // 登录诊断必须让目标页进入前台：Chrome 密码管理器通常只会在可见
          // 标签页完成自动填充，后台隔离标签会导致“已手动登录仍需登录”。
          active: true,
          keepTab: false,
          diagnostic: true,
          withSiteLogin: true,
          onObservation: (observation) => report(summarizeObservation(observation)),
        });
        const observations = result.observations || [];
        const loginRequired = result.status === 'need_login' || /登录|未登录|login\s*(required|failed)|sign\s*in|OAuth.*超时|授权.*超时/i.test(result.message || '');
        const loginSignals = loginRequired ? inferLoginPageSignals(observations) : {
          hasPasswordField: false,
          hasLoginButton: false,
          ordinaryFormLikely: false,
        };
        // 测试不写回技能执行历史，但“需要登录”是站点级运行状态，必须让站点列表
        // 明确显示出来，用户可从站点卡片打开真实页面完成 Chrome 自动填充后的登录。
        if (loginRequired && site) {
          await updateSiteLastResult(site.id, {
            status: 'need_login',
            message: '需要登录：请在站点页面完成登录后再测试或执行',
            at: Date.now(),
          });
        }
        const data = {
          testOk: result.ok,
          status: result.status,
          message: result.message,
          siteId: site?.id || procedure.siteId || '',
          siteName: site?.name || '',
          loginRequired,
          loginHint: loginRequired
            ? '请在站点页面完成登录。普通表单登录可使用 Chrome 已保存的账号密码自动填充；扩展不会读取或上传密码。'
            : '',
          loginSignals,
          procedureId,
          procedureName: procedure.name,
          failedStepIndex: result.failedStepIndex,
          failedStepType: result.failedStepType,
          observations: compactObservations(observations),
        };
        report(result.ok ? `技能「${procedure.name}」测试通过` : `技能「${procedure.name}」测试失败：${result.message}`);
        // 工具本身已成功完成诊断，即使被测技能失败也把报告作为正常数据回灌，
        // 这样 Agent 能基于页面事实选择 get-procedure / update-step / replace-steps。
        if (loginRequired) {
          return {
            ok: true,
            data,
            halt: 'ask',
            text: `站点「${site?.name || procedure.siteId || '当前站点'}」需要登录。请在站点列表的“需要登录”提示中点击“打开站点并登录”，Chrome 可自动填充已保存的账号密码；完成后点击登录，再发送“继续测试”。扩展不会读取或上传密码。`,
          };
        }
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: `测试技能失败：${(e as Error)?.message || String(e)}` };
      }
    }

    case 'test-flow': {
      const flowId = String(args.flowId || '').trim();
      const flow = (await getFlows()).find((item) => item.id === flowId);
      if (!flow) return { ok: false, error: `流程 ${flowId} 已不存在` };
      report(`开始测试流程「${flow.name}」，将复用正式 React Flow 执行引擎`);
      try {
        const result = await runFlowTest(flowId, ctx.signal, (message) => {
          // 流程执行日志会实时回流；先做同样的敏感值遮盖，避免 HTTP 响应或
          // 变量摘要在最终报告返回前短暂暴露给模型/会话历史。
          report(String(redactAgentValue(message)));
        });
        report(result.ok ? `流程「${flow.name}」测试通过` : `流程「${flow.name}」测试失败：${result.message}`);
        return {
          ok: true,
          data: {
            testOk: result.ok,
            flowId,
            flowName: flow.name,
            status: result.status,
            message: result.message,
            logs: redactAgentValue(result.logs.slice(-120)),
            nodeReports: redactAgentValue(result.nodeReports || []),
            summary: result.summary,
            variables: redactAgentValue(result.variables) as Record<string, unknown>,
          },
        };
      } catch (e) {
        return { ok: false, error: `测试流程失败：${(e as Error)?.message || String(e)}` };
      }
    }

    case 'explore-page': {
      report(`开始 AI 探索：${String(args.goal)}`);
      const { exploreAndGenerate } = await import('./explorer.js');
      const url = String(args.url);
      const siteId = String(args.siteId || '').trim();
      const goal = String(args.goal);
      const successKws = toStringArray(args.successKeywords);
      const site = (await getSites()).find((item) => item.id === siteId);
      if (!site) return { ok: false, error: `网站 ${siteId} 不存在，请先用 list-sites 获取真实 id` };
      try {
        const result = await exploreAndGenerate(url, goal, successKws, ctx.settings, (p) => {
          if (p.message) report(p.message);
        });
        if (!result.ok) {
          // 探索失败但可能已归纳出部分步骤，把这个事实告诉模型，让它决定是补步骤还是问用户
          return {
            ok: false,
            error: `${result.message}（已归纳 ${result.steps.length} 个步骤，未保存）`,
          };
        }
        const outputFields = result.steps
          .map((step, index) => (step.type === 'extract' ? step.variable || `step_${index + 1}` : ''))
          .filter(Boolean);
        const proc = createProcedure({
          kind: 'checkin',
          siteId,
          name: goal.slice(0, 40) || 'AI 探索生成技能',
          description: `由 AI 助手探索生成（${url}）`,
          url,
          steps: result.steps,
          // 探索归纳出的结果必须以标准步骤执行；脚本仅是用户主动选择的高级兜底。
          script: '',
          detect: { successKeywords: successKws, failKeywords: [] },
          // 探索包含提取动作时自动开启返回契约；普通点击/输入技能仍不暴露页面数据。
          output: { enabled: outputFields.length > 0, fields: outputFields },
          explorationHistory: [
            {
              id: result.explorationId,
              url,
              goal,
              llmProvider: ctx.settings.llmProvider,
              llmModel: ctx.settings.llmModel,
              stepsGenerated: result.steps.length,
              at: Date.now(),
            },
          ],
        });
        const saved = await upsertProcedure(proc);
        return {
          ok: true,
          data: {
            ok: true,
            procedureId: saved.id,
            siteId: saved.siteId,
            stepCount: saved.steps.length,
            message: result.message,
          },
          touched: [{ kind: 'procedure', id: saved.id, name: saved.name }],
        };
      } catch (e) {
        return { ok: false, error: `探索失败：${(e as Error)?.message || String(e)}` };
      }
    }

    case 'ask':
      return { ok: true, halt: 'ask', text: String(args.question) };

    case 'done':
      return { ok: true, halt: 'done', text: String(args.summary) };

    default:
      return { ok: false, error: `技能 "${name}" 未实现` };
  }
}
