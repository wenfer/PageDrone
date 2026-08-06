/**
 * 内置 AI 工具库（Agent Skills）—— 对话式代理可调用的能力白名单。
 *
 * 设计目标是「尽量减少推理产生的不确定因素」，手段是四层：
 *  1. 白名单 + 机器可读的参数声明（SKILLS 表），prompt 里的 AI 工具文档由这张表
 *     自动生成（renderSkillCatalog），不存在第二份需要同步的副本。
 *  2. 执行前强制校验（validateSkillCall / validateStep），校验失败时把
 *     「正确签名」回灌给模型让它自己改——比让它凭空猜有效得多。
 *  3. 只读 AI 工具（list-procedures / get-procedure / read-page）先于写入工具提供，
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
  type Step,
  type StepType,
} from './models.js';
import { createFlow, saveFlow } from './flows.js';
import {
  getProcedure,
  getProcedures,
  getSites,
  upsertProcedure,
  upsertSite,
} from './storage.js';

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
    returns: '{ procedure: { id, name, kind, siteId, url, detect, steps: [...] } }',
  },

  // —— 写入 ——
  {
    name: 'create-procedure',
    group: 'write',
    summary: '创建一个新的可编排技能。创建后会返回它的 id，后续用 add-step 往里加步骤。',
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
    summary: '往可编排技能末尾追加一个执行步骤。',
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
    summary: '创建流程（画布节点图）。给出 procedureIds 时按顺序串成一条链。',
    args: {
      name: { type: 'string', required: true, desc: '流程名称' },
      description: { type: 'string', desc: '流程说明' },
      procedureIds: { type: 'string[]', desc: '要串行执行的技能 id，按先后顺序' },
    },
    returns: '{ flowId, name, nodeCount }',
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

  if (name === 'add-step' || name === 'update-step') {
    const r = validateStep(args.step);
    if (!r.ok) return r;
  }
  if ((name === 'read-page' || name === 'explore-page' || name === 'create-site') &&
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
      const list = await getProcedures();
      return { ok: true, data: { procedures: list.map(summarizeProcedure) } };
    }

    case 'list-sites': {
      const list = await getSites();
      const procedures = await getProcedures();
      return { ok: true, data: { sites: list.map((site) => summarizeSite(site, procedures.filter((p) => p.siteId === site.id).length)) } };
    }

    case 'get-procedure': {
      const proc = await getProcedure(String(args.procedureId));
      if (!proc) return { ok: false, error: `技能 ${String(args.procedureId)} 已不存在` };
      return {
        ok: true,
        data: {
          procedure: {
            id: proc.id,
            name: proc.name,
            kind: proc.kind,
            siteId: proc.siteId || '',
            url: proc.url || '',
            detect: proc.detect,
            steps: proc.steps,
            output: proc.output || { enabled: false, fields: [] },
          },
        },
      };
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
      const procIds = toStringArray(args.procedureIds);
      const all = await getProcedures();
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
      });
      const saved = await saveFlow(flow);
      report(`已创建流程「${saved.name}」`);
      return {
        ok: true,
        data: { flowId: saved.id, name: saved.name, nodeCount: saved.nodes.length },
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
            text: (state.text || '').slice(0, 1500),
            elements: (state.elements || []).slice(0, 30),
          },
        };
      } catch (e) {
        return { ok: false, error: `打开页面失败：${(e as Error)?.message || String(e)}` };
      } finally {
        // 只是看一眼，看完就关，不给用户留一堆标签
        if (tab) await tab.close().catch(() => {});
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
