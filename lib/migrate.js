/**
 * 数据迁移：把旧版内联 steps/login 的站点转成引用 Procedure 实体。
 * 幂等：已迁移的站点不会重复生成 procedure。
 */

import { getSites, saveSites, getProcedures, saveProcedures, getSchemaVersion, setSchemaVersion } from './storage.js';
import { createProcedure, defaultCheckinSteps, defaultLoginSteps } from './models.js';

const CURRENT_VERSION = 2;

export async function runMigrations() {
  const v = await getSchemaVersion();
  if (v >= CURRENT_VERSION) return;

  if (v < 2) await migrateV1ToV2();

  await setSchemaVersion(CURRENT_VERSION);
}

async function migrateV1ToV2() {
  const [sites, procedures] = await Promise.all([getSites(), getProcedures()]);
  const procList = [...procedures];
  let changed = false;

  for (const site of sites) {
    // 已有引用就跳过（即使旧字段还在）
    if (site.checkinProcedureId) continue;

    // 签到流程：只有当站点确实带了内联 steps/script 才迁移
    const hasInlineCheckin =
      Array.isArray(site.steps) && site.steps.length > 0
        ? true
        : !!site.script;
    if (hasInlineCheckin) {
      const base = createProcedure({ kind: 'checkin' });
      const proc = {
        ...base,
        name: `${site.name || '站点'} · 签到`,
        description: '从旧版站点配置迁移',
        steps: Array.isArray(site.steps) && site.steps.length ? site.steps : defaultCheckinSteps(),
        script: site.script || '',
        detect: {
          ...base.detect,
          successKeywords: Array.isArray(site.successKeywords) && site.successKeywords.length
            ? site.successKeywords
            : base.detect.successKeywords,
          failKeywords: Array.isArray(site.failKeywords) && site.failKeywords.length
            ? site.failKeywords
            : base.detect.failKeywords,
        },
      };
      procList.push(proc);
      site.checkinProcedureId = proc.id;
      changed = true;
    }

    // 登录流程：login.enabled 且有 steps
    if (site.login && site.login.enabled && Array.isArray(site.login.steps) && site.login.steps.length) {
      const base = createProcedure({ kind: 'login' });
      const loginProc = {
        ...base,
        name: `${site.name || '站点'} · 登录`,
        description: '从旧版站点配置迁移',
        steps: site.login.steps,
        detect: {
          ...base.detect,
          loggedInSelector: site.login.loggedInSelector || '',
          loggedInUrlIncludes: site.login.loggedInUrlIncludes || '',
        },
      };
      procList.push(loginProc);
      site.loginProcedureId = loginProc.id;
      changed = true;
    }
  }

  if (changed) {
    await Promise.all([saveSites(sites), saveProcedures(procList)]);
  }
}
