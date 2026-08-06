/**
 * 数据迁移纯函数：把旧版内联 steps/login 的站点转成引用 Procedure 实体。
 * 不读写存储，也不 import storage —— 迁移启动与导入旧导出文件共用这段逻辑，
 * 抽到独立模块以打断 storage ↔ migrate 的循环依赖。
 * 幂等：已迁移的站点不会重复生成 procedure。
 */

import {
  createProcedure,
  defaultCheckinSteps,
  uid,
  type Procedure,
  type Site,
} from './models.js';

export interface ConvertResult {
  newProcedures: Procedure[];
  changed: boolean;
}

export function convertV1Sites(sites: Site[]): ConvertResult {
  const newProcedures: Procedure[] = [];
  let changed = false;

  for (const site of sites) {
    // 已有引用就跳过（即使旧字段还在）
    if (site.checkinProcedureId) continue;

    // 旧版站点可能带内联 steps/script（v1 字段，v2 类型上不保留，按宽松结构读取）
    const legacy = site as unknown as {
      steps?: unknown;
      script?: string;
      successKeywords?: string[];
      failKeywords?: string[];
      login?: {
        enabled?: boolean;
        steps?: unknown;
        loggedInSelector?: string;
        loggedInUrlIncludes?: string;
      };
    };

    // 自动化技能：只有当站点确实带了内联 steps/script 才迁移
    const hasInlineCheckin =
      (Array.isArray(legacy.steps) && legacy.steps.length > 0) || !!legacy.script;
    if (hasInlineCheckin) {
      const base = createProcedure({ kind: 'checkin', siteId: site.id, url: site.url }) as Extract<Procedure, { kind: 'checkin' }>;
      const proc: Procedure = {
        ...base,
        name: `${site.name || '站点'} · 执行`,
        description: '从旧版站点配置迁移',
        steps:
          Array.isArray(legacy.steps) && legacy.steps.length
            ? (legacy.steps as Procedure['steps'])
            : defaultCheckinSteps(),
        script: legacy.script || '',
        detect: {
          ...base.detect,
          successKeywords:
            Array.isArray(legacy.successKeywords) && legacy.successKeywords.length
              ? legacy.successKeywords
              : base.detect.successKeywords,
          failKeywords:
            Array.isArray(legacy.failKeywords) && legacy.failKeywords.length
              ? legacy.failKeywords
              : base.detect.failKeywords,
        },
      };
      newProcedures.push(proc);
      site.checkinProcedureId = proc.id;
      changed = true;
    }

    // 登录技能：login.enabled 且有 steps
    if (legacy.login && legacy.login.enabled && Array.isArray(legacy.login.steps) && legacy.login.steps.length) {
      const base = createProcedure({ kind: 'login', siteId: site.id, url: site.url }) as Extract<Procedure, { kind: 'login' }>;
      const loginProc: Procedure = {
        ...base,
        name: `${site.name || '站点'} · 登录`,
        description: '从旧版站点配置迁移',
        steps: legacy.login.steps as Procedure['steps'],
        detect: {
          ...base.detect,
          loggedInSelector: legacy.login.loggedInSelector || '',
          loggedInUrlIncludes: legacy.login.loggedInUrlIncludes || '',
        },
      };
      newProcedures.push(loginProc);
      site.loginProcedureId = loginProc.id;
      changed = true;
    }
  }

  return { newProcedures, changed };
}

type SiteProcedureKey = 'checkinProcedureId' | 'loginProcedureId' | 'verificationProcedureId';

const SITE_PROCEDURE_KEYS: readonly SiteProcedureKey[] = [
  'checkinProcedureId',
  'loginProcedureId',
  'verificationProcedureId',
];

function sameOrigin(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * 将旧的“站点引用技能”数据归一成“技能属于站点”的一对多模型。
 * 若同一旧技能被多个站点复用，会为后续站点复制独立技能并改写绑定，
 * 保证一个技能只属于一个网站，同时不破坏各站点原有执行入口。
 */
export function normalizeProcedureSiteOwnership(
  sites: Site[],
  procedures: Procedure[]
): { sites: Site[]; procedures: Procedure[]; changed: boolean } {
  const nextSites = sites.map((site) => ({ ...site }));
  const siteById = new Map(nextSites.map((site) => [site.id, site]));
  const refs = new Map<string, Map<string, SiteProcedureKey[]>>();

  for (const site of nextSites) {
    for (const key of SITE_PROCEDURE_KEYS) {
      const procedureId = site[key];
      if (!procedureId) continue;
      const bySite = refs.get(procedureId) ?? new Map<string, SiteProcedureKey[]>();
      const keys = bySite.get(site.id) ?? [];
      keys.push(key);
      bySite.set(site.id, keys);
      refs.set(procedureId, bySite);
    }
  }

  const nextProcedures: Procedure[] = [];
  let changed = false;

  for (const procedure of procedures) {
    const referencedBy = refs.get(procedure.id) ?? new Map<string, SiteProcedureKey[]>();
    const currentOwner = procedure.siteId && siteById.has(procedure.siteId)
      ? siteById.get(procedure.siteId)!
      : null;
    const firstReferencedSiteId = referencedBy.keys().next().value as string | undefined;
    const inferredOwner = currentOwner
      ?? (firstReferencedSiteId ? siteById.get(firstReferencedSiteId) ?? null : null)
      ?? nextSites.find((site) => sameOrigin(site.url, procedure.url))
      ?? (nextSites.length === 1 ? nextSites[0]! : null);
    const ownerId = inferredOwner?.id ?? '';
    const normalized = {
      ...procedure,
      siteId: ownerId,
      url: procedure.url || inferredOwner?.url || '',
    } as Procedure;
    if (normalized.siteId !== procedure.siteId || normalized.url !== procedure.url) changed = true;
    nextProcedures.push(normalized);

    for (const [siteId, keys] of referencedBy) {
      if (siteId === ownerId) continue;
      const site = siteById.get(siteId);
      if (!site) continue;
      const clone = {
        ...normalized,
        id: uid('proc'),
        siteId,
        url: site.url || normalized.url,
        source: normalized.source === 'market' ? 'local' : normalized.source,
        marketId: '',
        installedAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Procedure;
      nextProcedures.push(clone);
      for (const key of keys) site[key] = clone.id;
      changed = true;
    }
  }

  return { sites: nextSites, procedures: nextProcedures, changed };
}
