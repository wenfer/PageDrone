/**
 * Background Service Worker — 调度中枢
 */

import { MSG } from '../lib/messaging.js';
import {
  getRuntime,
  getSites,
  getSettings,
  setRuntime,
} from '../lib/storage.js';
import {
  enqueueSites,
  rescheduleAllAlarms,
  handleAlarm,
  updateBadgeFromLogs,
  isQueueRunning,
  stopQueue,
} from '../lib/runner.js';

chrome.runtime.onInstalled.addListener(async (details) => {
  await setRuntime({ state: 'idle', message: '已安装', queue: [] });
  await rescheduleAllAlarms();
  await updateBadgeFromLogs();
  if (details.reason === 'install') {
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启后内存队列已空，复位运行态
  await setRuntime({
    state: 'idle',
    message: '空闲',
    queue: [],
    currentSiteId: null,
    currentSiteName: null,
  });
  await rescheduleAllAlarms();
  await updateBadgeFromLogs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAlarm(alarm);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sites) {
    rescheduleAllAlarms();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // STOP 优先处理：用字面量兼容旧/新前端，避免「未知消息类型」
  const type = message?.type;
  if (type === 'STOP' || type === 'stop' || type === MSG.STOP) {
    Promise.resolve()
      .then(() => stopQueue(message?.reason || '用户强制停止'))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) })
      );
    return true;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) =>
      sendResponse({ ok: false, error: err?.message || String(err) })
    );
  return true;
});

async function handleMessage(message) {
  const type = message?.type;
  switch (type) {
    case MSG.PING:
    case 'PING':
      return { pong: true, running: isQueueRunning() };

    case MSG.GET_STATUS:
    case 'GET_STATUS': {
      const [runtime, sites, settings] = await Promise.all([
        getRuntime(),
        getSites(),
        getSettings(),
      ]);
      return { runtime, sites, settings, queueRunning: isQueueRunning() };
    }

    case MSG.RUN_ALL:
    case 'RUN_ALL': {
      const sites = await getSites();
      const ids = sites.filter((s) => s.enabled).map((s) => s.id);
      if (!ids.length) throw new Error('没有已启用的站点');
      enqueueSites(ids, { reason: 'manual' });
      return { queued: ids.length };
    }

    case MSG.RUN_SITE:
    case 'RUN_SITE': {
      const siteId = message.siteId;
      if (!siteId) throw new Error('缺少 siteId');
      enqueueSites([siteId], {
        reason: message.force ? 'manual-force' : 'manual',
      });
      return { queued: 1, siteId };
    }

    case MSG.RESCHEDULE:
    case 'RESCHEDULE': {
      await rescheduleAllAlarms();
      return { rescheduled: true };
    }

    case MSG.STOP:
    case 'STOP':
    case 'stop': {
      return stopQueue(message.reason || '用户强制停止');
    }

    default:
      throw new Error(`未知消息类型: ${type}`);
  }
}
