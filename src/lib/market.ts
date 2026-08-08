/**
 * 技能市场：从远端 index.json 拉取目录、安装单个技能。
 * index 格式：{ spec, version, updated, items: [{ marketId, name, kind, description, author, version, homepage, download, updatedAt }] }
 * 单技能格式：{ spec: 'auto-checkin-procedure/1', marketId, version, updatedAt, procedure: {...Procedure 字段} }
 */

import { getSettings, getSite, upsertProcedure, getProcedureByMarketId } from './storage.js';
import { createProcedure, type Procedure } from './models.js';

const PROCEDURE_SPEC = 'auto-checkin-procedure/1';
const MARKET_SPEC = 'auto-checkin-market/1';

export interface MarketItem {
  marketId: string;
  name: string;
  kind: Procedure['kind'];
  description?: string;
  author?: string;
  version?: string;
  homepage?: string;
  /** 相对于 index.json 所在目录的技能包路径。 */
  download?: string;
  updatedAt?: number | string;
  installed?: boolean;
  installedVersion?: string;
  updateAvailable?: number;
}

export interface MarketIndex {
  spec?: string;
  version?: number;
  updated?: number | string;
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
  // 旧市场未声明 spec 时仍兼容；一旦声明则必须是当前索引协议。
  if (data.spec !== undefined && data.spec !== MARKET_SPEC) {
    throw new Error(`市场目录协议不受支持：${String(data.spec)}`);
  }
  return data;
}

type MarketPackage = {
  spec?: unknown;
  marketId?: unknown;
  version?: unknown;
  updatedAt?: unknown;
  procedure?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 将市场源中的相对路径安全地解析到 index.json 的同源目录。
 * 市场源是用户可配置的，因此不能接受外域、协议相对 URL 或目录逃逸。
 */
function resolveDownloadUrl(indexUrl: string, download: string): string {
  const value = download.trim();
  if (!value || value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new Error('技能下载路径必须是 index.json 目录下的相对路径');
  }
  const pathPart = value.split(/[?#]/, 1)[0] || value;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    throw new Error('技能下载路径无效：包含错误的 URL 编码');
  }
  if (
    decodedPath.startsWith('/')
    || decodedPath.includes('\\')
    || /^[a-z][a-z\d+.-]*:/i.test(value)
    || decodedPath.split('/').some((part) => part === '..')
  ) {
    throw new Error('技能下载路径无效：禁止外域、协议相对 URL 或目录逃逸');
  }

  let index: URL;
  try {
    index = new URL(indexUrl);
  } catch {
    throw new Error('市场源 URL 无效');
  }
  if (index.protocol !== 'http:' && index.protocol !== 'https:') {
    throw new Error('市场源只支持 HTTP(S) URL');
  }
  const directory = new URL('.', index);
  const resolved = new URL(value, directory);
  if (resolved.origin !== index.origin || !resolved.pathname.startsWith(directory.pathname)) {
    throw new Error('技能下载路径无效：必须位于市场源目录内');
  }
  return resolved.toString();
}

function assertResponseInMarketScope(indexUrl: string, responseUrl: string): void {
  if (!responseUrl) return;
  const directory = new URL('.', new URL(indexUrl));
  const response = new URL(responseUrl);
  if (response.origin !== directory.origin || !response.pathname.startsWith(directory.pathname)) {
    throw new Error('技能下载被重定向到市场源目录之外，已拒绝安装');
  }
}

function legacyDownloadPaths(marketId: string): string[] {
  const encoded = `procedures/${encodeURIComponent(marketId)}.json`;
  const paths = [encoded];
  // 早期示例市场把带斜杠的 marketId 写成了短横线文件名。
  if (/[\\/]/.test(marketId)) {
    const flattened = marketId.replace(/[\\/]+/g, '-');
    paths.push(`procedures/${encodeURIComponent(flattened)}.json`);
    paths.push(`procedures/${marketId}.json`);
  }
  return [...new Set(paths)];
}

function asVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 拉取单个技能详情并写入目标网站下；同一市场技能可分别安装到多个网站。 */
export async function installFromMarket(
  marketId: string,
  siteId = '',
  options: { download?: string; version?: string } = {},
): Promise<{ procedure: Procedure; upgraded: boolean }> {
  if (!marketId) throw new Error('缺少 marketId');
  if (!siteId) throw new Error('请先选择要安装技能的网站');
  const settings = await getSettings();
  const base = settings.marketUrl;
  if (!base) throw new Error('未配置市场源 URL');

  // index.json 同级 procedures/<marketId>.json；新索引可显式提供 download，旧索引继续走约定路径。
  const paths = options.download ? [options.download] : legacyDownloadPaths(marketId);
  let payload: MarketPackage | null = null;
  let lastStatus = 0;
  for (const path of paths) {
    const detailUrl = resolveDownloadUrl(base, path);
    const res = await fetch(detailUrl, { cache: 'no-store' });
    assertResponseInMarketScope(base, res.url);
    lastStatus = res.status;
    if (res.ok) {
      payload = (await res.json()) as MarketPackage;
      break;
    }
    // 仅对旧约定路径尝试下一个候选；显式 download 的错误应直接反馈给用户。
    if (options.download || res.status !== 404) break;
  }
  if (!payload) throw new Error(`技能下载失败：HTTP ${lastStatus || 404}`);
  if (payload.spec !== PROCEDURE_SPEC || !isRecord(payload.procedure)) {
    throw new Error('技能文件格式无效');
  }

  const raw = payload.procedure;
  if (payload.marketId !== undefined && payload.marketId !== marketId) {
    throw new Error('技能文件 marketId 与目录条目不一致');
  }
  const declaredVersion = payload.version === undefined ? undefined : asVersion(payload.version);
  const procedureVersion = raw.version === undefined ? undefined : asVersion(raw.version);
  if (payload.version !== undefined && !declaredVersion) {
    throw new Error('技能文件格式无效：包版本必须是非空字符串');
  }
  if (raw.version !== undefined && !procedureVersion) {
    throw new Error('技能文件格式无效：技能版本必须是非空字符串');
  }
  if (declaredVersion && procedureVersion && declaredVersion !== procedureVersion) {
    throw new Error('技能文件版本不一致：包版本与 procedure.version 不同');
  }
  const packageVersion = declaredVersion || procedureVersion;
  const expectedVersion = asVersion(options.version);
  if (expectedVersion && packageVersion !== expectedVersion) {
    throw new Error(`技能文件版本不匹配：目录为 ${expectedVersion}，下载包为 ${packageVersion || '未知'}`);
  }

  const kind = raw.kind;
  if (kind !== 'checkin' && kind !== 'login' && kind !== 'verification') {
    throw new Error('技能文件格式无效：kind 必须是 checkin、login 或 verification');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error('技能文件格式无效：缺少技能名称');
  }
  if (!Array.isArray(raw.steps)) {
    throw new Error('技能文件格式无效：steps 必须是数组');
  }

  const now = Date.now();
  const site = await getSite(siteId);
  if (!site) throw new Error('目标网站不存在，请刷新后重试');
  const existing = await getProcedureByMarketId(marketId, siteId);

  // 只拷贝技能包允许的字段，避免远端携带 siteId/source/lastResult 等本地状态污染实体。
  const safeRaw: Record<string, unknown> = {
    kind,
    name: raw.name.trim(),
    description: typeof raw.description === 'string' ? raw.description : '',
    steps: raw.steps,
    script: typeof raw.script === 'string' ? raw.script : '',
    author: typeof raw.author === 'string' ? raw.author : '',
    homepage: typeof raw.homepage === 'string' ? raw.homepage : '',
    version: packageVersion || '1.0.0',
  };
  if (typeof raw.url === 'string' && raw.url.trim()) safeRaw.url = raw.url.trim();
  if (isRecord(raw.detect)) safeRaw.detect = raw.detect;
  if (isRecord(raw.output) && typeof raw.output.enabled === 'boolean') {
    safeRaw.output = {
      enabled: raw.output.enabled,
      fields: Array.isArray(raw.output.fields) ? raw.output.fields.filter((field): field is string => typeof field === 'string') : [],
    };
  }
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)) safeRaw.timeoutMs = raw.timeoutMs;
  const proc = createProcedure({
    ...(safeRaw as Partial<Procedure>),
    ...(existing
      ? {
          id: existing.id,
          installedAt: existing.installedAt,
          createdAt: existing.createdAt,
          // 保留本地执行与探索历史，但永不读取远端同名字段。
          lastResult: existing.lastResult,
          explorationHistory: existing.explorationHistory,
          patchHistory: existing.patchHistory,
        }
      : { installedAt: now }),
    siteId,
    url: typeof safeRaw.url === 'string' ? safeRaw.url : site.url,
    source: 'market',
    marketId,
  });

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
