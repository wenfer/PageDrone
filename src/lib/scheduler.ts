/**
 * 调度与汇总：alarms 重建、alarm 触发、完成通知。
 * 与队列执行分离——这里只负责「何时跑」与「跑完怎么提示」。
 */

import { getSites } from './storage.js';
import { enqueueSites } from './execution-queue.js';
import type { Settings, Log } from './models.js';

function notify(settings: Settings, id: string, title: string, message: string): void {
  if (settings && settings.notifyOnError === false) return;
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
  } catch {
    /* ignore */
  }
}

export async function notifySummary(results: Log[], settings: Settings): Promise<void> {
  if (!results?.length) return;
  const ok = results.filter((r) => r.status === 'success').length;
  const fail = results.length - ok;
  const wanted =
    fail > 0 ? settings.notifyOnError !== false : settings.notifyOnComplete !== false;
  if (!wanted) return;
  notify(
    settings,
    `sum_${Date.now()}`,
    '自动执行完成',
    `成功 ${ok}，失败/其它 ${fail}，共 ${results.length} 个站点`
  );
}

function nextDailyOccurrence(hour = 8, minute = 0): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
  if (next.getTime() <= now.getTime() + 5000) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export async function rescheduleAllAlarms(): Promise<void> {
  const sites = await getSites();
  const all = await chrome.alarms.getAll();
  for (const a of all) {
    if (a.name.startsWith('checkin:')) await chrome.alarms.clear(a.name);
  }
  for (const site of sites) {
    if (!site.enabled || !site.schedule?.enabled) continue;
    const when = nextDailyOccurrence(site.schedule.hour, site.schedule.minute);
    await chrome.alarms.create(`checkin:${site.id}`, { when, periodInMinutes: 24 * 60 });
  }
}

export async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (!alarm?.name?.startsWith('checkin:')) return;
  const siteId = alarm.name.slice('checkin:'.length);
  enqueueSites([siteId], { reason: 'schedule' });
}
