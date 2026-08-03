/**
 * 流程市场：从远端 index.json 拉取目录、安装单个流程。
 * index 格式：{ version, updated, items: [{ marketId, name, kind, description, author, version, homepage, updatedAt }] }
 * 单流程格式：{ spec: 'auto-checkin-procedure/1', procedure: {...Procedure 字段} }
 */

import { getSettings, upsertProcedure, getProcedureByMarketId } from './storage.js';
import { createProcedure } from './models.js';

const PROCEDURE_SPEC = 'auto-checkin-procedure/1';

export async function fetchMarketIndex() {
  const settings = await getSettings();
  const url = settings.marketUrl;
  if (!url) throw new Error('未配置市场源 URL');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`市场目录请求失败：HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.items)) throw new Error('市场目录格式无效：缺少 items');
  return data;
}

/** 拉取单个流程详情并写入本地 */
export async function installFromMarket(marketId) {
  if (!marketId) throw new Error('缺少 marketId');
  const settings = await getSettings();
  const base = settings.marketUrl;
  if (!base) throw new Error('未配置市场源 URL');

  // index.json 同级 procedures/<marketId>.json
  const baseUrl = base.replace(/\/[^/]*$/, '/');
  const detailUrl = new URL(`procedures/${encodeURIComponent(marketId)}.json`, baseUrl).toString();
  const res = await fetch(detailUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`流程下载失败：HTTP ${res.status}`);
  const payload = await res.json();
  if (payload?.spec !== PROCEDURE_SPEC || !payload.procedure) {
    throw new Error('流程文件格式无效');
  }

  const raw = payload.procedure;
  const now = Date.now();
  const existing = await getProcedureByMarketId(marketId);

  const proc = createProcedure({
    ...raw,
    id: existing?.id || undefined,
    kind: raw.kind === 'login' ? 'login' : 'checkin',
    source: 'market',
    marketId,
    installedAt: existing?.installedAt || now,
    updatedAt: now,
  });

  await upsertProcedure(proc);
  return { procedure: proc, upgraded: !!existing };
}

/** 比较版本号：a > b 返回 1，相等 0，否则 -1 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
