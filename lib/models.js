/** 默认配置与工厂方法 */

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultSettings() {
  return {
    notifyOnComplete: true,
    notifyOnError: true,
    openInBackground: true,
    siteGapMs: 2000,
    defaultCfTimeoutMs: 90000,
    defaultPageLoadTimeoutMs: 45000,
    cfManualGraceMs: 120000,
    maxLogs: 200,
    marketUrl: 'https://cdn.jsdelivr.net/gh/wenfer/auto-checkin-procedures@main/index.json',
  };
}

export function defaultSchedule() {
  return {
    enabled: false,
    type: 'daily',
    hour: 8,
    minute: 5,
  };
}

/** 默认两步签到步骤（点击签到 → 等待成功文案） */
export function defaultCheckinSteps() {
  return [
    { type: 'click', selector: '.checkin', timeoutMs: 15000, waitNavigation: true },
    { type: 'waitForText', selector: 'body', includes: '签到成功', timeoutMs: 15000 },
  ];
}

/** 默认登录步骤（点击 OAuth 入口 → 人工授权） */
export function defaultLoginSteps() {
  return [
    {
      type: 'click',
      selector: 'a[href*="oauth"], button.oauth, .login-oauth',
      timeoutMs: 15000,
      watchPopup: true,
    },
    { type: 'manual', message: '请完成 OAuth 授权', match: '', timeoutMs: 180000 },
    { type: 'waitForUrl', match: '', timeoutMs: 60000 },
  ];
}

/**
 * 创建一个流程（Procedure）实体。
 * kind: 'login' | 'checkin' | 'agent'
 */
export function createProcedure(partial = {}) {
  const now = Date.now();
  let kind = partial.kind || 'checkin';
  if (kind === 'login') {
    kind = 'login';
  } else if (kind === 'agent') {
    kind = 'agent';
  } else {
    kind = 'checkin';
  }
  const isAgent = kind === 'agent';
  return {
    id: uid('proc'),
    kind,
    name: kind === 'login' ? '新登录流程' : kind === 'agent' ? '新智能代理流程' : '新签到流程',
    description: '',
    detect:
      kind === 'login'
        ? {
            loggedInSelector: '',
            loggedInUrlIncludes: '',
            loginUrlPattern: '',
            notLoggedInKeywords: ['请登录', '登录后操作', '您需要登录'],
          }
        : kind === 'agent'
          ? {
              successKeywords: ['agent-success', '完成'],
              failKeywords: ['agent-fail', '错误'],
            }
          : {
              successKeywords: ['签到成功', '已签到', 'already checked', 'success'],
              failKeywords: ['失败', '未登录', '请登录', 'login required'],
            },
    steps: isAgent ? [] : kind === 'login' ? defaultLoginSteps() : defaultCheckinSteps(),
    script: kind === 'checkin' ? SCRIPT_TEMPLATE : '',
    // Agent specific
    promptTemplate: isAgent ? 'Analyze current page state and suggest next browser action using skills.' : '',
    llmProvider: isAgent ? 'openai' : '',
    llmModel: isAgent ? 'gpt-4o-mini' : '',
    timeoutMs: isAgent ? 300000 : undefined,
    maxSteps: isAgent ? 15 : undefined,
    // 市场元数据
    source: 'local', // local | market
    author: '',
    homepage: '',
    version: '1.0.0',
    marketId: '',
    installedAt: 0,
    updatedAt: now,
    createdAt: now,
    ...partial,
  };
}

export function createSite(partial = {}) {
  const now = Date.now();
  return {
    id: uid('site'),
    name: '新站点',
    url: 'https://',
    enabled: true,
    mode: 'steps', // steps | script
    checkinProcedureId: '',
    loginProcedureId: null,
    cfTimeoutMs: 90000,
    pageLoadTimeoutMs: 45000,
    stepsTimeoutMs: 120000,
    keepTabOnError: true,
    openInBackground: true,
    schedule: defaultSchedule(),
    lastResult: null, // { status, message, at }
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export const SCRIPT_TEMPLATE = `// 在目标页面中执行，需 return { ok: boolean, message: string }
// 可使用 async/await
const btn = document.querySelector('button.checkin, .checkin, #checkin');
if (!btn) {
  return { ok: false, message: '未找到签到按钮，请修改选择器' };
}
btn.click();
await new Promise((r) => setTimeout(r, 2000));
const text = document.body?.innerText || '';
const ok = /签到成功|已签到|success/i.test(text);
return { ok, message: ok ? '签到完成' : '已点击按钮，请根据页面确认结果' };
`;

export function createLog(partial = {}) {
  return {
    id: uid('log'),
    taskId: '',
    siteId: '',
    siteName: '',
    status: 'failed',
    message: '',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    cfWaitedMs: 0,
    ...partial,
  };
}

export function createTask(partial = {}) {
  const now = Date.now();
  return {
    id: uid('task'),
    trigger: 'manual', // manual | schedule | single
    state: 'running',  // running | done | aborted
    startedAt: now,
    finishedAt: 0,
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    ...partial,
  };
}

export const TASK_TRIGGER_LABEL = {
  manual: '手动全部签到',
  single: '单站点测试',
  schedule: '定时任务',
};

export const STEP_TYPES = [
  { value: 'waitFor', label: '等待元素' },
  { value: 'click', label: '点击' },
  { value: 'wait', label: '固定等待' },
  { value: 'waitForText', label: '等待文本' },
  { value: 'type', label: '输入文本' },
  { value: 'goto', label: '跳转 URL' },
  { value: 'waitForUrl', label: '等待 URL' },
  { value: 'manual', label: '人工操作(OAuth)' },
];

export const STATUS_LABEL = {
  success: '成功',
  failed: '失败',
  cf_timeout: '人机验证超时',
  need_login: '需登录',
  skipped: '已跳过',
  running: '运行中',
  waiting_cf: '等待防护',
  waiting_login: '等待登录',
};

export const PROCEDURE_KIND_LABEL = {
  checkin: '签到',
  login: '登录',
};

export function defaultAgentConfig() {
	  return {
	    promptTemplate: 'Analyze current page state (use getPageText + hasElement skills) and choose next skill from: openTab, navigateTo, click, type, waitFor, executeScript, scrollTo. Return { skillName, args, reason }. Max 15 steps.',
	    llmProvider: 'anthropic',
	    llmModel: 'claude-3-5-sonnet-20241022',
	    apiKey: '',
	    timeoutMs: 300000,
	    maxSteps: 15,
	    retryOnError: true,
	  };
}
