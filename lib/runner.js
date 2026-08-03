/**
 * 签到编排（Service Worker 侧）
 * 打开标签 → 等待加载 → CF 等待 → 执行步骤/脚本 → 写日志
 */

import {
  getSettings,
  updateSiteLastResult,
  appendLog,
  setRuntime,
  getSite,
  getSites,
  getProcedure,
  startTask,
  upsertTask,
} from './storage.js';
import { detectChallengeInPage, getPageTextSample, hasCfClearance, isChallengeCleared } from './cf.js';
import { RUN_STATE } from './messaging.js';
import * as BrowserSkills from './browser-skills.js';

let queueRunning = false;
const queue = [];
/** 用户点停止 / 强制重置时置位，当前任务应尽快退出 */
let abortRequested = false;
let activeTabId = null;
let queueStartedAt = 0;
/** 当前站点硬截止时间戳，超时则 sleep/等待循环抛错 */
let siteDeadline = 0;
/** 递增后使旧的 drainQueue 循环失效，避免停止后双开队列 */
let drainToken = 0;
/** 当前批次任务（task）ID，用于日志按任务归档 */
let currentTaskId = null;
let currentTaskTrigger = 'manual';

export function isQueueRunning() {
  return queueRunning;
}

export function isAbortRequested() {
  return abortRequested;
}

/** 可中断的 sleep：停止队列、单站超时或标签关闭时尽快结束 */
async function sleep(ms, tabId = null) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    if (abortRequested) throw new Error('已取消签到');
    if (siteDeadline && Date.now() > siteDeadline) {
      throw new Error('单站执行总超时，已中止（可点「强制停止」后重试）');
    }
    if (tabId != null) await assertTabAlive(tabId);
    const chunk = Math.min(250, end - Date.now());
    if (chunk <= 0) break;
    await new Promise((r) => setTimeout(r, chunk));
  }
}

async function assertTabAlive(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.get(tabId);
  } catch {
    throw new Error('标签页已关闭（请勿中途关掉签到页，或点「强制停止」后重试）');
  }
}

/**
 * 强制停止队列（清空待执行任务，中断当前等待）
 */
export async function stopQueue(reason = '用户强制停止') {
  abortRequested = true;
  queue.length = 0;
  drainToken += 1; // 作废正在跑的 drainQueue
  const tabToClose = activeTabId;
  queueRunning = false;
  activeTabId = null;
  siteDeadline = 0;
  queueStartedAt = 0;
  await setRuntime({
    state: RUN_STATE.IDLE,
    currentSiteId: null,
    currentSiteName: null,
    queue: [],
    message: reason,
  });
  await updateBadgeFromLogs();
  if (tabToClose != null) {
    try {
      await chrome.tabs.remove(tabToClose);
    } catch {
      /* 可能已被用户关掉 */
    }
  }
  return { stopped: true, reason };
}

/**
 * 将站点加入串行队列
 */
export function enqueueSites(siteIds, { reason = 'manual' } = {}) {
  // 若上次任务异常卡住超过 3 分钟，自动复位
  if (queueRunning && queueStartedAt && Date.now() - queueStartedAt > 3 * 60 * 1000) {
    console.warn('[auto-checkin] queue stuck, auto-reset');
    abortRequested = true;
    queueRunning = false;
    queue.length = 0;
    activeTabId = null;
  }

  // 队列空且未跑 → 新批次任务；否则并入当前批次
  const isNewBatch = !queueRunning && queue.length === 0;
  let trigger = reason;
  if (reason === 'manual-force' && siteIds.length === 1) trigger = 'single';
  else if (reason === 'schedule') trigger = 'schedule';
  else trigger = 'manual';
  if (isNewBatch) currentTaskTrigger = trigger;

  abortRequested = false;
  for (const id of siteIds) {
    queue.push({ siteId: id, reason });
  }
  if (!queueRunning) {
    drainQueue();
  }
}

async function drainQueue() {
  if (queueRunning) return;
  const myToken = ++drainToken;
  queueRunning = true;
  abortRequested = false;
  queueStartedAt = Date.now();
  const settings = await getSettings();
  const results = [];

  // 创建本次批次任务归档
  const taskRecord = await startTask({
    trigger: currentTaskTrigger || 'manual',
    state: 'running',
    total: queue.length,
  });
  currentTaskId = taskRecord.id;

  try {
    await setRuntime({
      state: RUN_STATE.RUNNING,
      message: '签到队列启动',
      queue: queue.map((q) => q.siteId),
      taskId: taskRecord.id,
    });

    while (queue.length) {
      if (abortRequested || myToken !== drainToken) break;
      const job = queue.shift();
      await setRuntime({
        state: RUN_STATE.RUNNING,
        currentSiteId: job.siteId,
        queue: queue.map((q) => q.siteId),
      });

      const site = await getSite(job.siteId);
      if (!site) continue;
      if (!site.enabled && job.reason !== 'manual-force') {
        const log = await finishSite(site, {
          status: 'skipped',
          message: '站点已禁用',
          startedAt: Date.now(),
          cfWaitedMs: 0,
        });
        results.push(log);
        continue;
      }

      await setRuntime({
        currentSiteName: site.name,
        message: `正在签到：${site.name}`,
      });

      let result;
      const hardTimeout =
        (site.login?.enabled ? site.login.timeoutMs || 180000 : 0) +
        (site.cfTimeoutMs || settings.defaultCfTimeoutMs || 90000) +
        (settings.cfManualGraceMs || 120000) +
        (site.stepsTimeoutMs || 120000) +
        (site.pageLoadTimeoutMs || settings.defaultPageLoadTimeoutMs || 45000) +
        30000;
      siteDeadline = Date.now() + hardTimeout;
      try {
        result = await runOneSite(site, settings);
      } catch (e) {
        result = {
          status: abortRequested ? 'skipped' : 'failed',
          message: e?.message || String(e),
          startedAt: Date.now(),
          finishedAt: Date.now(),
          cfWaitedMs: 0,
        };
        // 出错时尽量关掉我们开的标签，避免残留
        if (activeTabId != null) {
          try {
            if (site.keepTabOnError === false || abortRequested || /已关闭|总超时|已取消/.test(result.message)) {
              await chrome.tabs.remove(activeTabId);
            }
          } catch {
            /* ignore */
          }
          activeTabId = null;
        }
      } finally {
        siteDeadline = 0;
      }

      if (abortRequested && result.status === 'failed') {
        result = { ...result, status: 'skipped', message: result.message || '已取消' };
      }

      const log = await finishSite(site, result);
      results.push(log);

      if (abortRequested || myToken !== drainToken) break;
      if (queue.length && settings.siteGapMs > 0) {
        try {
          await sleep(settings.siteGapMs);
        } catch {
          break;
        }
      }
    }
  } finally {
    // 仅最新一轮 drain 负责复位，避免 stop 后旧循环把新任务状态冲掉
    if (myToken === drainToken) {
      queueRunning = false;
      activeTabId = null;
      const wasAbort = abortRequested;
      abortRequested = false;
      queueStartedAt = 0;
      siteDeadline = 0;
      await setRuntime({
        state: RUN_STATE.IDLE,
        currentSiteId: null,
        currentSiteName: null,
        queue: [],
        message: wasAbort ? '已停止' : '空闲',
      });

      // 更新任务归档
      if (currentTaskId) {
        const success = results.filter((r) => r.status === 'success').length;
        const failed = results.filter(
          (r) => r.status === 'failed' || r.status === 'cf_timeout' || r.status === 'need_login'
        ).length;
        const skipped = results.filter((r) => r.status === 'skipped').length;
        await upsertTask({
          id: currentTaskId,
          state: wasAbort ? 'aborted' : 'done',
          finishedAt: Date.now(),
          total: results.length,
          success,
          failed,
          skipped,
        });
        currentTaskId = null;
      }

      await updateBadgeFromLogs();
      if (!wasAbort) {
        await notifySummary(results, settings);
      }
    }
  }

  return results;
}

async function finishSite(site, result) {
  const finishedAt = result.finishedAt || Date.now();
  const lastResult = {
    status: result.status,
    message: result.message,
    at: finishedAt,
  };
  await updateSiteLastResult(site.id, lastResult);
  return appendLog({
    taskId: currentTaskId || '',
    siteId: site.id,
    siteName: site.name,
    status: result.status,
    message: result.message,
    startedAt: result.startedAt,
    finishedAt,
    cfWaitedMs: result.cfWaitedMs || 0,
  });
}

/**
 * 取站点绑定的签到/登录流程；缺失时回退到内联旧字段。
 */
async function resolveSiteProcedures(site) {
  let checkinProc = null;
  let loginProc = null;

  if (site.checkinProcedureId) {
    checkinProc = await getProcedure(site.checkinProcedureId);
  }
  // 回退：迁移未跑或导入的旧数据
  if (!checkinProc && Array.isArray(site.steps) && site.steps.length) {
    checkinProc = {
      id: '',
      kind: 'checkin',
      name: '签到（内联）',
      detect: {
        successKeywords: site.successKeywords || [],
        failKeywords: site.failKeywords || [],
      },
      steps: site.steps,
      script: site.script || '',
    };
  }
  if (site.loginProcedureId) {
    loginProc = await getProcedure(site.loginProcedureId);
  } else if (site.login?.enabled && Array.isArray(site.login.steps)) {
    loginProc = {
      id: '',
      kind: 'login',
      name: '登录（内联）',
      detect: {
        loggedInSelector: site.login.loggedInSelector || '',
        loggedInUrlIncludes: site.login.loggedInUrlIncludes || '',
        loginUrlPattern: '',
        notLoggedInKeywords: ['请登录', '登录后操作', '您需要登录'],
      },
      steps: site.login.steps,
      timeoutMs: site.login.timeoutMs || 180000,
    };
  }
  return { checkinProc, loginProc };
}

/**
 * 判断当前标签是否处于已登录状态。
 */
async function isLoggedInProc(tabId, detect = {}) {
  try {
    if (detect.loggedInUrlIncludes) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && tab.url.includes(detect.loggedInUrlIncludes)) return true;
    }
    if (detect.loggedInSelector) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageQueryExists,
        args: [detect.loggedInSelector],
      });
      if (result) return true;
    }
    if (!detect.loggedInSelector && !detect.loggedInUrlIncludes) return false;
    return false;
  } catch {
    return false;
  }
}

/**
 * 确保已登录：未登录则执行登录步骤并重试 CF。
 * @param {string} reason precheck | step_failed | keyword | url_redirect
 */
async function ensureLoggedIn(tabId, loginProc, settings, { reason, cfTimeout = 60000 }) {
  const detect = loginProc.detect || {};
  const loggedIn = await isLoggedInProc(tabId, detect);
  if (loggedIn) return { ok: true, alreadyLoggedIn: true };

  const reasonLabel = {
    precheck: '开始前检查',
    step_failed: '签到步骤失败',
    keyword: '命中未登录关键词',
    url_redirect: '跳转到登录页',
  }[reason] || reason;

  await setRuntime({
    state: RUN_STATE.NEED_MANUAL,
    message: `需要登录（${reasonLabel}）：${loginProc.name || ''}`,
  });

  const loginTimeout = loginProc.timeoutMs || 180000;
  const loginResult = await executeSteps(tabId, loginProc.steps || [], loginTimeout, settings, {
    label: '登录',
  });
  if (!loginResult.ok) {
    return {
      ok: false,
      status: 'need_login',
      message: `自动登录失败（${reasonLabel}）：${loginResult.message || '未完成'}`,
    };
  }
  // 登录后再确认一次登录态
  const after = await isLoggedInProc(tabId, detect);
  if (!after && (detect.loggedInSelector || detect.loggedInUrlIncludes)) {
    return {
      ok: false,
      status: 'need_login',
      message: `登录步骤已完成但仍未检测到登录态（${reasonLabel}）`,
    };
  }
  // 登录回调后可能再次遇到防护
  try {
    const tab = await chrome.tabs.get(tabId);
    const cf = await waitForChallengeClear(
      tabId,
      tab.url || 'https://example.com',
      Math.min(cfTimeout, 60000),
      settings
    );
    return { ok: true, cfWaitedMs: cf.waited || 0, reason };
  } catch {
    return { ok: true, cfWaitedMs: 0, reason };
  }
}

/**
 * 根据 URL / 页面文字 / 错误信息判断是否掉到了登录页。
 */
async function looksLikeLoggedOut(tabId, { errMessage, checkinProc, loginProc, beforeUrl }) {
  if (!loginProc) return false;
  const detect = loginProc.detect || {};
  // 1. URL 命中登录页模式
  if (detect.loginUrlPattern) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || tab.pendingUrl || '';
      if (buildMatcher(detect.loginUrlPattern)(url)) return true;
    } catch {
      /* tab gone */
    }
  }
  // 2. 错误信息含登录相关词
  if (errMessage && /登录|未登录|please\s*sign?\s*in|login\s*required/i.test(errMessage)) {
    return true;
  }
  // 3. 页面文本命中未登录关键词
  const kws = detect.notLoggedInKeywords || [];
  if (kws.length) {
    try {
      const text = await getPageText(tabId);
      if (kws.some((k) => k && text.includes(k))) return true;
    } catch {
      /* ignore */
    }
  }
  // 4. checkin 失败关键词里包含登录词（兜底）
  const failKws = checkinProc?.detect?.failKeywords || [];
  if (errMessage && failKws.some((k) => /登录|login/i.test(k) && errMessage.includes(k))) {
    return true;
  }
  return false;
}

/**
 * 执行单个站点签到
 */
export async function runOneSite(site, settings) {
  const startedAt = Date.now();
  const pageLoadTimeout = site.pageLoadTimeoutMs || settings.defaultPageLoadTimeoutMs || 45000;
  const cfTimeout = site.cfTimeoutMs || settings.defaultCfTimeoutMs || 90000;
  const openInBackground =
    site.openInBackground !== undefined ? site.openInBackground : settings.openInBackground;

  let tabId = null;
  let cfWaitedMs = 0;

  // 解析流程
  const { checkinProc, loginProc } = await resolveSiteProcedures(site);
  if (!checkinProc) {
    return {
      status: 'failed',
      message: '该站点未选择签到流程，请到设置中选择或新建一个',
      startedAt,
      finishedAt: Date.now(),
      cfWaitedMs: 0,
    };
  }

  try {
    if (abortRequested) throw new Error('已取消签到');
    const tab = await chrome.tabs.create({
      url: site.url,
      active: !openInBackground,
    });
    tabId = tab.id;
    activeTabId = tabId;

    await waitTabComplete(tabId, pageLoadTimeout);
    await assertTabAlive(tabId);

    // 快速识别网关错误页，避免在 502 页上傻等步骤超时
    try {
      const [{ result: boot }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const t = `${document.title || ''} ${(document.body?.innerText || '').slice(0, 500)}`;
          const m = t.match(/\b(502|503|504|500|404)\b/);
          return {
            title: document.title || '',
            httpError: m ? m[1] : null,
            sample: t.slice(0, 120),
          };
        },
      });
      if (boot?.httpError) {
        throw new Error(
          `页面返回错误 ${boot.httpError}（${boot.title || '无标题'}）。请检查网址是否可访问，或稍后再试`
        );
      }
    } catch (e) {
      if (/页面返回错误/.test(e?.message || '')) throw e;
      // 注入失败可能是受限页，继续走后续流程
    }

    // CF / 防护等待
    await setRuntime({
      state: RUN_STATE.WAITING_CF,
      message: `等待防护通过：${site.name}`,
    });
    const cf = await waitForChallengeClear(tabId, site.url, cfTimeout, settings);
    cfWaitedMs = cf.waited;
    if (!cf.ok) {
      if (site.keepTabOnError !== false) {
        try {
          await chrome.tabs.update(tabId, { active: true });
        } catch {
          /* ignore */
        }
      }
      return {
        status: 'cf_timeout',
        message: cf.message || '人机验证超时，请手动完成后重试',
        startedAt,
        finishedAt: Date.now(),
        cfWaitedMs,
      };
    }

    // 开始前登录检查
    if (loginProc) {
      const lr = await ensureLoggedIn(tabId, loginProc, settings, {
        reason: 'precheck',
        cfTimeout,
      });
      if (!lr.ok) {
        return {
          status: lr.status || 'need_login',
          message: lr.message,
          startedAt,
          finishedAt: Date.now(),
          cfWaitedMs,
        };
      }
      cfWaitedMs += lr.cfWaitedMs || 0;
    }

    await setRuntime({
      state: RUN_STATE.RUNNING,
      message: `执行签到：${site.name}`,
    });

    // 执行签到流程；失败且检测到掉线时自动重登并重试一次
    let execResult;
    let loginRetryUsed = false;
    let lastErr = null;

    try {
      execResult = await runCheckinProcedure(tabId, site, checkinProc, loginProc, settings);
    } catch (e) {
      lastErr = e;
      execResult = { ok: false, message: e?.message || String(e) };
    }

    if (loginProc && !loginRetryUsed) {
      let needRelogin = !!execResult.loginRedirect;
      if (!needRelogin) {
        const loggedOut = await looksLikeLoggedOut(tabId, {
          errMessage: execResult.ok ? '' : execResult.message,
          checkinProc,
          loginProc,
        });
        if (loggedOut) {
          // 步骤成功时，先确认页面没有命中成功关键词，避免误判
          if (execResult.ok) {
            const text = await getPageText(tabId);
            const hitSuccess = (checkinProc.detect?.successKeywords || []).some(
              (k) => k && text.includes(k)
            );
            needRelogin = !hitSuccess;
          } else {
            needRelogin = true;
          }
        }
      }
      if (needRelogin) {
        loginRetryUsed = true;
        let reason = 'step_failed';
        if (execResult.loginRedirect || /跳转到登录页/.test(execResult.message || '')) {
          reason = 'url_redirect';
        } else if (/关键词|请登录/.test(execResult.message || '')) {
          reason = 'keyword';
        } else if (execResult.ok) {
          reason = 'url_redirect';
        }
        const lr = await ensureLoggedIn(tabId, loginProc, settings, {
          reason,
          cfTimeout,
        });
        if (!lr.ok) {
          return {
            status: lr.status || 'need_login',
            message: lr.message,
            startedAt,
            finishedAt: Date.now(),
            cfWaitedMs,
          };
        }
        cfWaitedMs += lr.cfWaitedMs || 0;
        // 登录成功后回到签到页（若被跳走）
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url !== site.url && !tab.url?.includes(new URL(site.url).host)) {
            await chrome.tabs.update(tabId, { url: site.url });
            await waitTabComplete(tabId, pageLoadTimeout);
            const cf2 = await waitForChallengeClear(tabId, site.url, Math.min(cfTimeout, 60000), settings);
            cfWaitedMs += cf2.waited || 0;
          }
        } catch {
          /* ignore */
        }
        try {
          execResult = await runCheckinProcedure(tabId, site, checkinProc, loginProc, settings);
        } catch (e) {
          execResult = { ok: false, message: e?.message || String(e) };
        }
      }
    }

    // 关键词二次判定（脚本已返回明确结果时优先脚本）
    if (site.mode === 'script' ? execResult.needKeywordCheck : true) {
      const text = await getPageText(tabId);
      const kw = judgeKeywordsByProc(text, checkinProc);
      if (kw) execResult = { ...execResult, ...kw };
    }

    let status = execResult.ok ? 'success' : inferFailStatus(execResult.message);
    // 重试后仍失败，且错误是登录相关 → need_login
    if (!execResult.ok && loginProc && loginRetryUsed) {
      const stillLoggedOut = await looksLikeLoggedOut(tabId, {
        errMessage: execResult.message,
        checkinProc,
        loginProc,
      });
      if (stillLoggedOut) status = 'need_login';
    }

    let message = execResult.message || (execResult.ok ? '签到成功' : '签到失败');
    if (loginRetryUsed && execResult.ok) {
      message = `自动重登后重试成功 · ${message}`;
    }

    const shouldClose = status === 'success' ? true : site.keepTabOnError === false;

    if (shouldClose && tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* ignore */
      }
      tabId = null;
    } else if (status !== 'success' && tabId != null) {
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        /* ignore */
      }
    }

    if (activeTabId === tabId || tabId == null) activeTabId = null;
    return {
      status,
      message,
      startedAt,
      finishedAt: Date.now(),
      cfWaitedMs,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    const tabGone = /标签页已关闭|标签页被关闭/.test(msg);
    if (tabId != null && !tabGone && site.keepTabOnError !== false && !abortRequested) {
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        /* ignore */
      }
    } else if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* ignore */
      }
    }
    if (activeTabId === tabId || tabId == null) activeTabId = null;
    return {
      status: abortRequested ? 'skipped' : 'failed',
      message: msg,
      startedAt,
      finishedAt: Date.now(),
      cfWaitedMs,
    };
  }
}

/** 执行签到流程的步骤或脚本 */
async function runCheckinProcedure(tabId, site, proc, loginProc, settings) {
  const useScript = site.mode === 'script' || (proc.steps?.length === 0 && proc.script);
  if (useScript) {
    return executeUserScript(tabId, proc.script || '', 60000);
  }
  if (proc.kind === 'agent') {
    return agentLoop(tabId, proc, settings);
  }
  const stepsTimeout = site.stepsTimeoutMs || 120000;
  return executeSteps(tabId, proc.steps || [], stepsTimeout, settings, {
    label: '签到',
    // 优先用登录流程配置的 loginUrlPattern；签到流程也可自带
    loginUrlPattern:
      loginProc?.detect?.loginUrlPattern || proc.detect?.loginUrlPattern || '',
  });
}

function inferFailStatus(message = '') {
  if (/登录|未登录|login/i.test(message)) return 'need_login';
  return 'failed';
}

function judgeKeywordsByProc(text, proc) {
  if (!text || !proc?.detect) return null;
  const fails = proc.detect.failKeywords || [];
  const successes = proc.detect.successKeywords || [];
  for (const k of fails) {
    if (k && text.includes(k)) {
      // 失败关键词里若是登录词，交给 need_login 逻辑
      if (/登录|login/i.test(k)) continue;
      return { ok: false, message: `匹配失败关键词：${k}` };
    }
  }
  for (const k of successes) {
    if (k && text.includes(k)) {
      return { ok: true, message: `匹配成功关键词：${k}` };
    }
  }
  return null;
}

async function waitTabComplete(tabId, timeoutMs) {
  const start = Date.now();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      await sleep(500, tabId);
      return;
    }
  } catch {
    throw new Error('标签页已关闭（请勿中途关掉签到页）');
  }

  while (Date.now() - start < timeoutMs) {
    if (abortRequested) throw new Error('已取消签到');
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') {
        await sleep(600, tabId);
        return;
      }
    } catch {
      throw new Error('标签页已关闭（请勿中途关掉签到页）');
    }
    await sleep(300, tabId);
  }
  throw new Error(`页面加载超时（${timeoutMs}ms）`);
}

/**
 * 等待 Cloudflare / 防护挑战通过
 */
async function waitForChallengeClear(tabId, url, timeoutMs, settings) {
  const start = Date.now();
  let sawChallenge = false;
  let notified = false;
  const grace = settings.cfManualGraceMs || 120000;

  while (Date.now() - start < timeoutMs) {
    if (abortRequested) throw new Error('已取消签到');
    await assertTabAlive(tabId);

    let detect;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: detectChallengeInPage,
      });
      detect = result;
    } catch {
      // 可能正在跳转；若标签已关则 assert 会在下次循环抛错
      await sleep(800, tabId);
      continue;
    }

    if (detect?.isChallenge) sawChallenge = true;

    const clearance = await hasCfClearance(url);
    if (isChallengeCleared(detect, clearance) && !detect?.isChallenge) {
      await sleep(500, tabId);
      try {
        const [{ result: again }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: detectChallengeInPage,
        });
        if (!again?.isChallenge) {
          return { ok: true, waited: Date.now() - start, sawChallenge };
        }
      } catch {
        await assertTabAlive(tabId);
        return { ok: true, waited: Date.now() - start, sawChallenge };
      }
    }

    await sleep(1000, tabId);
  }

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    await assertTabAlive(tabId);
  }

  if (!notified) {
    notified = true;
    await setRuntime({
      state: RUN_STATE.NEED_MANUAL,
      message: '需要完成人机验证',
    });
    try {
      if (settings.notifyOnError !== false) {
        chrome.notifications.create(`cf_${tabId}_${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '自动签到 - 需要人机验证',
          message: '已打开标签页，请完成验证后将自动继续（宽限时间内）',
          priority: 2,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const graceStart = Date.now();
  while (Date.now() - graceStart < grace) {
    if (abortRequested) throw new Error('已取消签到');
    await assertTabAlive(tabId);
    let detect;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: detectChallengeInPage,
      });
      detect = result;
    } catch {
      await sleep(1000, tabId);
      continue;
    }
    const clearance = await hasCfClearance(url);
    if (!detect?.isChallenge && isChallengeCleared(detect, clearance)) {
      return { ok: true, waited: Date.now() - start, sawChallenge: true };
    }
    await sleep(1000, tabId);
  }

  return {
    ok: false,
    waited: Date.now() - start,
    message: '人机验证超时：请手动完成验证后重新签到',
  };
}

async function getPageText(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: getPageTextSample,
    });
    return result || '';
  } catch {
    return '';
  }
}

/** 错误类：签到中途掉到登录页，用于触发自动重登 */
class LoginRedirectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoginRedirectError';
  }
}

/**
 * SW 侧编排步骤（支持 OAuth：等待 URL / 人工授权 / 弹窗）。
 * 若配置了 loginUrlPattern，每步之间检测到跳到登录页就抛出 LoginRedirectError。
 */
async function executeSteps(
  tabId,
  steps,
  totalTimeoutMs,
  settings,
  { label = '步骤', loginUrlPattern = '' } = {}
) {
  const list = steps || [];
  if (!list.length) {
    return { ok: true, message: `无${label}可执行`, needKeywordCheck: true };
  }
  const deadline = Date.now() + (totalTimeoutMs || 120000);
  const urlMatcher = loginUrlPattern ? buildMatcher(loginUrlPattern) : null;
  try {
    for (let i = 0; i < list.length; i++) {
      if (Date.now() > deadline) throw new Error(`${label}总超时`);
      if (urlMatcher) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && urlMatcher(tab.url)) {
            throw new LoginRedirectError(`地址跳转到登录页：${tab.url}`);
          }
        } catch (e) {
          if (e instanceof LoginRedirectError) throw e;
        }
      }
      const step = list[i] || {};
      await setRuntime({
        message: `执行${label} ${i + 1}/${list.length}：${step.type}`,
      });
      await runOneStep(tabId, step, settings, deadline);
    }
    return {
      ok: true,
      message: `已完成 ${list.length} 个${label}`,
      needKeywordCheck: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: e?.message || String(e),
      loginRedirect: e instanceof LoginRedirectError,
      needKeywordCheck: true,
    };
  }
}

async function runOneStep(tabId, step, settings, deadline) {
  const type = step.type;
  const remain = () => Math.max(1000, (deadline || Date.now() + 60000) - Date.now());

  if (type === 'wait') {
    await sleep(Number(step.ms) || 1000);
    return;
  }

  if (type === 'goto') {
    const url = step.url || step.selector;
    if (!url) throw new Error('goto 缺少 url');
    await chrome.tabs.update(tabId, { url });
    await waitTabComplete(tabId, Number(step.timeoutMs) || 45000);
    return;
  }

  if (type === 'waitForUrl') {
    const match = step.match || step.includes || step.url || step.selector || '';
    if (!match) throw new Error('waitForUrl 缺少匹配串（match）');
    await waitTabUrl(tabId, match, Number(step.timeoutMs) || remain());
    await sleep(500);
    return;
  }

  if (type === 'manual') {
    await waitManualAuth(tabId, step, settings, remain());
    return;
  }

  if (type === 'callSkill') {
    const skillName = step.skillName || step.skill;
    const args = step.args || {};
    if (!BrowserSkills[skillName]) {
      throw new Error(`未知技能: ${skillName}`);
    }
    const result = await BrowserSkills[skillName](tabId, ...(Object.values(args) || []));
    return { ok: true, skillResult: result };
  }

  if (type === 'click') {
    let beforeUrl = '';
    try {
      beforeUrl = (await chrome.tabs.get(tabId)).url || '';
    } catch {
      throw new Error('标签页已关闭（请勿中途关掉签到页）');
    }
    const beforeIds = new Set((await chrome.tabs.query({})).map((t) => t.id));

    // 点击可能导致整页跳转，注入失败不一定代表没点到
    let pageResult = { ok: false, message: '点击未执行' };
    try {
      pageResult = await executePageStep(tabId, step, 2);
    } catch (e) {
      pageResult = { ok: false, message: e?.message || String(e) };
    }

    // 默认自动处理重定向/刷新；仅当显式 waitNavigation === false 时跳过
    const autoNav = step.waitNavigation !== false;
    let navigated = false;
    if (autoNav) {
      const nav = await waitForPossibleNavigation(
        tabId,
        beforeUrl,
        Number(step.navTimeoutMs) || Number(step.timeoutMs) || 45000
      );
      navigated = !!nav.navigated;
    }

    if (!pageResult?.ok && !navigated) {
      throw new Error(pageResult?.message || '点击失败');
    }

    if (step.watchPopup) {
      await waitOAuthPopupOrReturn(tabId, beforeIds, step, settings, remain());
    }
    return;
  }

  // 页内步骤：waitFor / waitForText / type（支持跳转后重试）
  const pageResult = await executePageStep(tabId, step, 8);
  if (!pageResult?.ok) throw new Error(pageResult?.message || `${type} 失败`);
}

/**
 * 点击后检测是否发生跳转/刷新，并等到加载完成
 */
async function waitForPossibleNavigation(tabId, beforeUrl, timeoutMs) {
  const detectMs = 2500;
  const detectEnd = Date.now() + detectMs;
  let navigated = false;

  while (Date.now() < detectEnd) {
    if (abortRequested) throw new Error('已取消签到');
    await assertTabAlive(tabId);
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'loading') {
        navigated = true;
        break;
      }
      if (beforeUrl && t.url && t.url !== beforeUrl) {
        navigated = true;
        break;
      }
    } catch {
      throw new Error('标签页已关闭（请勿中途关掉签到页）');
    }
    await sleep(120, tabId);
  }

  // 无论是否检测到跳转，都等到 complete（未跳转时几乎立即返回）
  try {
    await waitTabComplete(tabId, timeoutMs);
  } catch (e) {
    if (abortRequested || /已关闭|已取消|总超时/.test(e?.message || '')) throw e;
    // 加载超时但标签仍在：继续后续步骤，由后续 waitForText 再判定
  }

  // 跳转后可能再次出现 CF
  if (navigated) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const cf = await waitForChallengeClear(
        tabId,
        tab.url || beforeUrl || 'https://example.com',
        Math.min(30000, timeoutMs),
        await getSettings()
      );
      if (!cf.ok) {
        // 不直接失败：有的站跳转后无 CF，检测误报；仅记录
      }
    } catch (e) {
      if (abortRequested || /已关闭|已取消/.test(e?.message || '')) throw e;
    }
  }

  return { navigated };
}

/**
 * 页内执行一步；页面重载/跳转时自动等待并重试
 */
async function executePageStep(tabId, step, maxAttempts = 6) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortRequested) throw new Error('已取消签到');
    await assertTabAlive(tabId);

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete') {
        await waitTabComplete(tabId, 45000);
      }
    } catch (e) {
      if (/已关闭/.test(e?.message || '')) throw e;
    }

    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageRunOneStep,
        args: [step],
      });
      // waitFor / waitForText 内部有超时；若返回失败且还在跳转，可重试
      if (result?.ok) return result;
      lastErr = new Error(result?.message || '页内步骤失败');
      // 元素未找到等逻辑错误：对 waitFor/waitForText 可在跳转后重试
      if (attempt < maxAttempts && /超时|跳转|frame|destroyed|Cannot access/i.test(result?.message || '')) {
        await sleep(600, tabId);
        continue;
      }
      return result || { ok: false, message: '页内步骤无返回' };
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      // 典型：页面正在导航 Frame was removed / receiving end
      if (attempt < maxAttempts) {
        try {
          await sleep(500, tabId);
          // 若正在 loading，等加载完再试
          const t = await chrome.tabs.get(tabId);
          if (t.status === 'loading') {
            await waitTabComplete(tabId, 45000);
          }
        } catch (e2) {
          if (/已关闭|已取消/.test(e2?.message || '')) throw e2;
        }
        continue;
      }
      return { ok: false, message: msg };
    }
  }
  return { ok: false, message: lastErr?.message || '页内步骤失败' };
}

/** 等待当前标签 URL 包含 match（或 /regex/） */
async function waitTabUrl(tabId, match, timeoutMs) {
  const start = Date.now();
  const tester = buildMatcher(match);
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && tester(tab.url)) return true;
    } catch {
      throw new Error('标签页已关闭');
    }
    await sleep(400);
  }
  throw new Error(`等待 URL 超时：${match}`);
}

function buildMatcher(match) {
  const m = String(match || '');
  if (m.length >= 2 && m.startsWith('/') && m.lastIndexOf('/') > 0) {
    const last = m.lastIndexOf('/');
    try {
      const re = new RegExp(m.slice(1, last), m.slice(last + 1));
      return (url) => re.test(url);
    } catch {
      /* fallthrough */
    }
  }
  return (url) => url.includes(m);
}

/**
 * 人工 OAuth / 登录：前置标签 + 通知，等待 URL 匹配或选择器出现
 */
async function waitManualAuth(tabId, step, settings, timeoutMs) {
  const timeout = Number(step.timeoutMs) || timeoutMs || 180000;
  const message = step.message || '请完成登录或 OAuth 授权';
  const match = step.match || step.includes || step.url || '';
  const selector = step.selector || '';

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* ignore */
  }
  await setRuntime({
    state: RUN_STATE.NEED_MANUAL,
    message,
  });
  try {
    if (settings?.notifyOnError !== false) {
      chrome.notifications.create(`oauth_${tabId}_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '自动签到 - 需要登录 / OAuth',
        message: message + (match ? `（完成后等待 URL 含：${match}）` : ''),
        priority: 2,
      });
    }
  } catch {
    /* ignore */
  }

  const start = Date.now();
  const tester = match ? buildMatcher(match) : null;
  let stableHits = 0;
  let lastUrl = '';
  while (Date.now() - start < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || '';
      if (tester && url && tester(url)) return true;
      if (selector) {
        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: pageQueryExists,
            args: [selector],
          });
          if (result) return true;
        } catch {
          /* 跳转中 */
        }
      }
      // 未配置结束条件：离开常见 OAuth 域且 URL 稳定一段时间，视为完成
      if (!tester && !selector && Date.now() - start > 3000) {
        const onOauth =
          /accounts\.google|github\.com\/login|login\.microsoftonline|oauth|authorize|sso\.|auth0\.com|okta\.com/i.test(
            url
          );
        if (!onOauth && tab.status === 'complete' && url && !url.startsWith('chrome')) {
          if (url === lastUrl) stableHits += 1;
          else {
            lastUrl = url;
            stableHits = 0;
          }
          if (stableHits >= 3) return true;
        } else {
          stableHits = 0;
          lastUrl = url;
        }
      }
    } catch {
      throw new Error('标签页已关闭');
    }
    await sleep(800);
  }
  throw new Error(`人工登录 / OAuth 超时：${message}`);
}

/**
 * 点击后监视 OAuth 新标签，或同标签回调
 */
async function waitOAuthPopupOrReturn(openerTabId, beforeIds, step, settings, timeoutMs) {
  const timeout = Number(step.popupTimeoutMs) || Number(step.timeoutMs) || timeoutMs || 180000;
  const returnMatch = step.returnMatch || step.match || step.includes || '';
  const start = Date.now();
  let oauthTabId = null;

  // 查找新开标签（opener 或 id 不在 before 中）
  while (Date.now() - start < Math.min(15000, timeout)) {
    const tabs = await chrome.tabs.query({});
    const child =
      tabs.find((t) => t.openerTabId === openerTabId && !beforeIds.has(t.id)) ||
      tabs.find(
        (t) =>
          !beforeIds.has(t.id) &&
          t.id !== openerTabId &&
          /oauth|authorize|accounts\.|login\./i.test(t.url || t.pendingUrl || '')
      );
    if (child) {
      oauthTabId = child.id;
      break;
    }
    // 同标签跳转 OAuth
    try {
      const main = await chrome.tabs.get(openerTabId);
      if (/oauth|authorize|accounts\.|login\./i.test(main.url || '')) {
        oauthTabId = null;
        break;
      }
    } catch {
      throw new Error('标签页已关闭');
    }
    await sleep(400);
  }

  if (oauthTabId != null) {
    try {
      await chrome.tabs.update(oauthTabId, { active: true });
    } catch {
      /* ignore */
    }
    await setRuntime({
      state: RUN_STATE.NEED_MANUAL,
      message: '请在 OAuth 标签页完成授权',
    });
    try {
      if (settings?.notifyOnError !== false) {
        chrome.notifications.create(`oauth_pop_${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '自动签到 - OAuth 授权',
          message: '已打开授权页，完成后将自动继续',
          priority: 2,
        });
      }
    } catch {
      /* ignore */
    }

    while (Date.now() - start < timeout) {
      // 授权标签关闭 → 通常已完成
      try {
        await chrome.tabs.get(oauthTabId);
      } catch {
        await sleep(800);
        if (returnMatch) {
          try {
            await waitTabUrl(openerTabId, returnMatch, 30000);
          } catch {
            /* 无 returnMatch 成功也可 */
          }
        }
        try {
          await chrome.tabs.update(openerTabId, { active: true });
        } catch {
          /* ignore */
        }
        return;
      }
      // 主标签已回到业务站
      if (returnMatch) {
        try {
          const main = await chrome.tabs.get(openerTabId);
          if (main.url && buildMatcher(returnMatch)(main.url)) {
            try {
              await chrome.tabs.remove(oauthTabId);
            } catch {
              /* ignore */
            }
            return;
          }
        } catch {
          /* ignore */
        }
      }
      await sleep(800);
    }
    throw new Error('OAuth 弹窗授权超时');
  }

  // 同标签 OAuth：等待离开授权域或 URL 匹配
  if (returnMatch) {
    await waitTabUrl(openerTabId, returnMatch, timeout - (Date.now() - start));
    return;
  }
  await waitManualAuth(
    openerTabId,
    {
      message: step.message || '请完成 OAuth 授权，授权完成后回到业务页面',
      match: returnMatch,
      timeoutMs: timeout - (Date.now() - start),
    },
    settings,
    timeout - (Date.now() - start)
  );
}

/**
 * 执行用户自定义脚本
 */
async function executeUserScript(tabId, source, timeoutMs) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageRunUserScript,
    args: [source, timeoutMs],
  });
  if (!result) return { ok: false, message: '脚本无返回值' };
  return result;
}

/** 注入：判断选择器/XPath 是否存在（函数体自包含） */
function pageQueryExists(selector) {
  try {
    // 内联实现，避免依赖外部 pageFindElementImpl
    if (selector == null || selector === '') return false;
    const raw = String(selector).trim();
    if (!raw) return false;
    let mode = 'auto';
    let expr = raw;
    if (/^xpath\s*:/i.test(raw)) {
      mode = 'xpath';
      expr = raw.replace(/^xpath\s*:/i, '').trim();
    } else if (/^css\s*:/i.test(raw)) {
      mode = 'css';
      expr = raw.replace(/^css\s*:/i, '').trim();
    }
    const looksLikeXPath =
      mode === 'xpath' ||
      (mode === 'auto' &&
        (/^\s*(\/\/|\.\/\/|\(\/\/|\(\.\/\/)/.test(expr) ||
          /^\s*\/html\b/i.test(expr) ||
          /^\s*\/body\b/i.test(expr) ||
          /^\s*id\s*\(/i.test(expr)));
    if (looksLikeXPath) {
      const result = document.evaluate(
        expr,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return !!result.singleNodeValue;
    }
    return !!document.querySelector(expr);
  } catch {
    return false;
  }
}

/** 注入：单步页内执行（CSS + XPath，函数体自包含） */
function pageRunOneStep(step) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findElement(selector) {
    if (selector == null || selector === '') return null;
    const raw = String(selector).trim();
    if (!raw) return null;
    let mode = 'auto';
    let expr = raw;
    if (/^xpath\s*:/i.test(raw)) {
      mode = 'xpath';
      expr = raw.replace(/^xpath\s*:/i, '').trim();
    } else if (/^css\s*:/i.test(raw)) {
      mode = 'css';
      expr = raw.replace(/^css\s*:/i, '').trim();
    }
    const looksLikeXPath =
      mode === 'xpath' ||
      (mode === 'auto' &&
        (/^\s*(\/\/|\.\/\/|\(\/\/|\(\.\/\/)/.test(expr) ||
          /^\s*\/html\b/i.test(expr) ||
          /^\s*\/body\b/i.test(expr) ||
          /^\s*id\s*\(/i.test(expr)));
    if (looksLikeXPath) {
      try {
        const result = document.evaluate(
          expr,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        return result.singleNodeValue || null;
      } catch (e) {
        throw new Error(`XPath 无效: ${expr}（${e.message || e}）`);
      }
    }
    try {
      return document.querySelector(expr);
    } catch (e) {
      throw new Error(`CSS 选择器无效: ${expr}（${e.message || e}）`);
    }
  }

  async function waitForSelector(selector, timeoutMs) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const el = findElement(selector);
        if (el) return el;
      } catch (e) {
        lastErr = e;
      }
      await sleep(200);
    }
    if (lastErr) throw lastErr;
    throw new Error(`等待元素超时: ${selector}`);
  }

  async function waitForText(selector, includes, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let el = document.body;
      if (selector && selector !== 'body') {
        try {
          el = findElement(selector) || document.body;
        } catch {
          el = document.body;
        }
      }
      const text = el?.innerText || el?.textContent || '';
      if (text.includes(includes)) return true;
      await sleep(200);
    }
    throw new Error(`等待文本超时: "${includes}"`);
  }

  return (async () => {
    try {
      const type = step?.type;
      if (type === 'wait') {
        await sleep(Number(step.ms) || 1000);
      } else if (type === 'waitFor') {
        await waitForSelector(step.selector, Number(step.timeoutMs) || 15000);
      } else if (type === 'click') {
        const el = await waitForSelector(step.selector, Number(step.timeoutMs) || 10000);
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus?.();
        el.click();
      } else if (type === 'waitForText') {
        await waitForText(step.selector || 'body', step.includes || '', Number(step.timeoutMs) || 10000);
      } else if (type === 'type') {
        const el = await waitForSelector(step.selector, Number(step.timeoutMs) || 10000);
        el.focus?.();
        if ('value' in el) {
          el.value = step.text ?? '';
        } else {
          el.textContent = step.text ?? '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (type === 'goto' || type === 'waitForUrl' || type === 'manual') {
        return { ok: true, message: 'skip-in-page' };
      } else {
        throw new Error(`未知步骤类型: ${type}`);
      }
      return { ok: true, message: 'ok' };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  })();
}

/** 注入：用户脚本执行器 */
function pageRunUserScript(source, timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    const timeout = Number(timeoutMs) || 60000;
    let timer;
    try {
      const runner = async () => {
        // 包装用户代码，支持 return / async
        const fn = new Function(
          `'use strict'; return (async () => { ${source}\n })();`
        );
        return await fn();
      };
      const result = await Promise.race([
        runner(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('脚本执行超时')), timeout);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (result && typeof result === 'object' && 'ok' in result) {
        return {
          ok: !!result.ok,
          message: result.message || (result.ok ? '脚本返回成功' : '脚本返回失败'),
        };
      }
      if (typeof result === 'boolean') {
        return { ok: result, message: result ? '脚本返回 true' : '脚本返回 false' };
      }
      return {
        ok: true,
        message: result == null ? '脚本执行完毕' : String(result),
        needKeywordCheck: true,
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, message: e?.message || String(e) };
    }
  })();
}

async function notifySummary(results, settings) {
  if (!results?.length) return;
  const ok = results.filter((r) => r.status === 'success').length;
  const fail = results.length - ok;
  const title = '自动签到完成';
  const message = `成功 ${ok}，失败/其它 ${fail}，共 ${results.length} 个站点`;
  try {
    if (fail > 0 && settings.notifyOnError !== false) {
      chrome.notifications.create(`sum_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
      });
    } else if (settings.notifyOnComplete !== false) {
      chrome.notifications.create(`sum_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
      });
    }
  } catch {
    /* ignore */
  }
}

export async function updateBadgeFromLogs() {
  try {
    const sites = await getSites();
    const fails = sites.filter(
      (s) =>
        s.enabled &&
        s.lastResult &&
        s.lastResult.status &&
        s.lastResult.status !== 'success' &&
        s.lastResult.status !== 'skipped'
    ).length;
    if (queueRunning) {
      await chrome.action.setBadgeText({ text: '…' });
      await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    } else if (fails > 0) {
      await chrome.action.setBadgeText({ text: String(Math.min(fails, 99)) });
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    /* ignore */
  }
}

/**
 * 根据站点 schedule 配置 alarms
 */
export async function rescheduleAllAlarms() {
  const sites = await getSites();
  const all = await chrome.alarms.getAll();
  for (const a of all) {
    if (a.name.startsWith('checkin:')) {
      await chrome.alarms.clear(a.name);
    }
  }
  for (const site of sites) {
    if (!site.enabled || !site.schedule?.enabled) continue;
    const when = nextDailyOccurrence(site.schedule.hour, site.schedule.minute);
    await chrome.alarms.create(`checkin:${site.id}`, {
      when,
      periodInMinutes: 24 * 60,
    });
  }
}

function nextDailyOccurrence(hour = 8, minute = 0) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
  if (next.getTime() <= now.getTime() + 5000) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export async function handleAlarm(alarm) {
  if (!alarm?.name?.startsWith('checkin:')) return;
  const siteId = alarm.name.slice('checkin:'.length);
  enqueueSites([siteId], { reason: 'schedule' });
}

	/** Agent skills: encapsulated browser operations callable by LLM */
	async function getPageState(tabId) {
	  try {
	    const [{ result }] = await chrome.scripting.executeScript({
	      target: { tabId },
	      func: () => {
	        const state = {
	          url: document.location.href,
	          title: document.title,
	          text: document.body ? document.body.innerText.slice(0, 2000) : '',
	          elements: Array.from(document.querySelectorAll('a, button, input, form')).map(el => ({
	            tag: el.tagName,
	            text: el.innerText || el.value || '',
	            selector: el.getAttribute('id') || el.getAttribute('class') || el.tagName.toLowerCase() + ':n'
	          })).slice(0, 20),
	          viewport: { width: window.innerWidth, height: window.innerHeight }
	        };
	        return state;
	      }
	    });
	    return result || { url: '', text: '', elements: [] };
	  } catch (e) {
	    console.warn('getPageState failed:', e);
	    return { url: '', text: '', elements: [] };
	  }
	}

	async function callBrowserSkill(tabId, skillName, args = {}) {
	  await setRuntime({ message: `Agent skill: ${skillName}` });
	  switch (skillName) {
	    case 'executeStep':
	      return await executePageStep(tabId, args, 5);  // reuse page step logic
	    case 'wait':
	      await sleep(args.ms || 1000);
	      return { ok: true };
	    case 'goto':
	      await chrome.tabs.update(tabId, { url: args.url });
	      await waitTabComplete(tabId, args.timeoutMs || 45000);
	      return { ok: true, message: 'goto completed' };
	    case 'click':
	      // reuse existing click logic via executePageStep or pageRunOneStep
	      const pageResult = await executePageStep(tabId, { type: 'click', selector: args.selector }, 3);
	      return pageResult;
	    case 'type':
	      const typeResult = await executePageStep(tabId, { type: 'type', selector: args.selector, text: args.text }, 3);
	      return typeResult;
	    case 'waitForText':
	      const textResult = await executePageStep(tabId, { type: 'waitForText', selector: args.selector, includes: args.includes }, 10);
	      return textResult;
	    default:
	      throw new Error(`Unknown skill: ${skillName}`);
	  }
	}

	/** Agent loop: LLM decides actions using skills */
	async function agentLoop(tabId, proc, settings) {
	  if (!proc.llmApiKey && !settings.llmApiKey) {
	    throw new Error('Agent mode requires LLM API key in settings');
	  }
	  const deadline = Date.now() + (proc.timeoutMs || settings.agentTimeoutMs || 300000);
	  let stepsCompleted = 0;
	  const maxSteps = proc.maxSteps || settings.agentMaxSteps || 15;
	  let state = await getPageState(tabId);
	  let lastStateHash = JSON.stringify(state).slice(0, 200);

	  try {
	    while (Date.now() < deadline && stepsCompleted < maxSteps && !abortRequested) {
	      state = await getPageState(tabId);
	      const stateHash = JSON.stringify(state).slice(0, 200);
	      if (stateHash === lastStateHash && stepsCompleted > 0) {
	        await sleep(1000);
	        continue;
	      }

	      // Build prompt for LLM (placeholder; integrate real API call below)
	      const prompt = buildAgentPrompt(state, proc.promptTemplate);

	      lastStateHash = stateHash;
	      stepsCompleted++;

	      // TODO: integrate real LLM call (Anthropic/OpenAI fetch using settings.llmApiKey)
	      // For now, simulate with keyword check
	      const text = state.text || '';
	      if (proc.detect?.successKeywords?.some(k => text.includes(k))) {
	        return { ok: true, message: 'Agent detected success keyword' };
	      }
	      if (proc.detect?.failKeywords?.some(k => text.includes(k))) {
	        return { ok: false, message: 'Agent detected failure keyword' };
	      }
	    }
	    return { ok: true, message: `Agent loop completed ${stepsCompleted} steps` };
	  } catch (e) {
	    return { ok: false, message: e.message || String(e) };
	  }
	}

	function buildAgentPrompt(state, template) {
	  return template || `Current page state: ${JSON.stringify(state, null, 2)}.
Use only skills to perform actions. Output JSON like {"actions": [{"skill": "click", "args": {"selector": "button"}}]} or decide to stop.`;
	}
