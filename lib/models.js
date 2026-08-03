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

export function createSite(partial = {}) {
  const now = Date.now();
  return {
    id: uid('site'),
    name: '新站点',
    url: 'https://',
    enabled: true,
    mode: 'steps', // steps | script
    // 默认两步：点击签到 → 等待成功文案（请改成真实选择器）
    steps: [
      { type: 'click', selector: '.checkin', timeoutMs: 15000, waitNavigation: true },
      { type: 'waitForText', selector: 'body', includes: '签到成功', timeoutMs: 15000 },
    ],
    script: SCRIPT_TEMPLATE,
    // OAuth / 登录流：未检测到「已登录」标记时，先跑 loginSteps
    login: {
      enabled: false,
      /** 出现该选择器视为已登录，跳过登录步骤 */
      loggedInSelector: '',
      /** URL 包含该字符串视为已登录 */
      loggedInUrlIncludes: '',
      /** 登录步骤（可含 OAuth 点击、等待回调 URL、人工授权） */
      steps: [
        { type: 'click', selector: 'a[href*="oauth"], button.oauth, .login-oauth', timeoutMs: 15000, watchPopup: true },
        { type: 'manual', message: '请在打开的页面完成 OAuth 授权', match: '', timeoutMs: 180000 },
        { type: 'waitForUrl', match: '', timeoutMs: 60000 },
      ],
      timeoutMs: 180000,
    },
    successKeywords: ['签到成功', '已签到', 'already checked', 'success'],
    failKeywords: ['失败', '未登录', '请登录', 'login required'],
    schedule: defaultSchedule(),
    cfTimeoutMs: 90000,
    pageLoadTimeoutMs: 45000,
    stepsTimeoutMs: 120000,
    keepTabOnError: true,
    openInBackground: true,
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
