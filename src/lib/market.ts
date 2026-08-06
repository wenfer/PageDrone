/**
 * 技能市场：从远端 index.json 拉取目录、安装单个技能。
 * index 格式：{ version, updated, items: [{ marketId, name, kind, description, author, version, homepage, updatedAt }] }
 * 单技能格式：{ spec: 'auto-checkin-procedure/1', procedure: {...Procedure 字段} }
 */

import { getSettings, getSite, upsertProcedure, getProcedureByMarketId } from './storage.js';
import { createProcedure, type Procedure } from './models.js';

const PROCEDURE_SPEC = 'auto-checkin-procedure/1';

export interface MarketItem {
  marketId: string;
  name: string;
  kind: Procedure['kind'];
  description?: string;
  author?: string;
  version?: string;
  homepage?: string;
  updatedAt?: number;
  installed?: boolean;
  installedVersion?: string;
  updateAvailable?: number;
}

export interface MarketIndex {
  version: number;
  updated: number;
  items: MarketItem[];
}

export async function fetchMarketIndex(): Promise<MarketIndex> {
  const settings = await getSettings();
  const url = settings.marketUrl;
  if (!url) throw new Error('未配置市场源 URL');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`市场目录请求失败：HTTP ${res.status}`);
  const data = (await res.json()) as MarketIndex;
  if (!Array.isArray(data?.items)) throw new Error('市场目录格式无效：缺少 items');
  return data;
}

/** 拉取单个技能详情并写入目标网站下；同一市场技能可分别安装到多个网站。 */
export async function installFromMarket(marketId: string, siteId = ''): Promise<{ procedure: Procedure; upgraded: boolean }> {
  if (!marketId) throw new Error('缺少 marketId');
  if (!siteId) throw new Error('请先选择要安装技能的网站');
  const settings = await getSettings();
  const base = settings.marketUrl;
  if (!base) throw new Error('未配置市场源 URL');

  // index.json 同级 procedures/<marketId>.json
  const baseUrl = base.replace(/\/[^/]*$/, '/');
  const detailUrl = new URL(`procedures/${encodeURIComponent(marketId)}.json`, baseUrl).toString();
  const res = await fetch(detailUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`技能下载失败：HTTP ${res.status}`);
  const payload = (await res.json()) as { spec?: string; procedure?: Partial<Procedure> };
  if (payload?.spec !== PROCEDURE_SPEC || !payload.procedure) {
    throw new Error('技能文件格式无效');
  }

  const raw = payload.procedure;
  const now = Date.now();
  const site = await getSite(siteId);
  if (!site) throw new Error('目标网站不存在，请刷新后重试');
  const existing = await getProcedureByMarketId(marketId, siteId);

  const proc = createProcedure({
    ...raw,
    id: existing?.id || undefined,
    kind: raw.kind === 'login' || raw.kind === 'verification' ? raw.kind : 'checkin',
    siteId,
    url: raw.url || site.url,
    source: 'market',
    marketId,
    installedAt: existing?.installedAt || now,
    updatedAt: now,
  } as Partial<Procedure>);

  await upsertProcedure(proc);
  return { procedure: proc, upgraded: !!existing };
}

/** 比较版本号：a > b 返回 1，相等 0，否则 -1 */
export function compareVersions(a: string, b: string): number {
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
