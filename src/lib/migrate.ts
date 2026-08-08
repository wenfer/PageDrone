/**
 * 数据迁移：把旧版内联 steps/login 的站点转成引用 Procedure 实体。
 * 幂等：已迁移的站点不会重复生成 procedure。
 */

import {
  getSites,
  saveSites,
  getProcedures,
  saveProcedures,
  getSchemaVersion,
  setSchemaVersion,
} from './storage.js';
import { convertV1Sites, normalizeProcedureSiteOwnership } from './v1-convert.js';
import type { LoginDetect, Procedure, Site } from './models.js';

const CURRENT_VERSION = 7;

export async function runMigrations(): Promise<void> {
  const v = await getSchemaVersion();
  if (v >= CURRENT_VERSION) return;

  if (v < 2) await migrateV1ToV2();
  if (v < 3) await migrateV2ToV3();
  if (v < 4) await migrateV3ToV4();
  if (v < 5) await migrateV4ToV5();
  if (v < 6) await migrateV5ToV6();
  if (v < 7) await migrateV6ToV7();

  await setSchemaVersion(CURRENT_VERSION);
}

/** 为技能补齐显式返回契约；旧技能保持“无返回值”，执行行为不变。 */
async function migrateV4ToV5(): Promise<void> {
  const procedures = await getProcedures();
  let changed = false;
  const next = procedures.map((procedure) => {
    if (procedure.output && typeof procedure.output.enabled === 'boolean') return procedure;
    changed = true;
    return { ...procedure, output: { enabled: false, fields: [] } };
  });
  if (changed) await saveProcedures(next);
}

/**
 * 旧版本新建登录技能默认带 OAuth 点击器和弹窗授权文案。
 * 只迁移“完全未改过默认配置”的技能，避免覆盖用户已经配置好的 OAuth 流程。
 */
async function migrateV5ToV6(): Promise<void> {
  const procedures = await getProcedures();
  let changed = false;
  const next = procedures.map((procedure) => {
    if (!isUntouchedOauthDefaultLogin(procedure)) return procedure;
    changed = true;
    return {
      ...procedure,
      detect: { ...(procedure.detect as LoginDetect), notLoggedInKeywords: [] },
      steps: [
        {
          type: 'manual' as const,
          message: '请完成当前页面要求的登录或其他人工操作',
          match: '',
          timeoutMs: 180000,
        },
      ],
      updatedAt: Date.now(),
    };
  });
  if (changed) await saveProcedures(next);
}

/**
 * 登录技能不再把“请用户手动登录”作为普通表单兜底。清理没有完成条件、
 * 也没有明确 OAuth/验证码/二次验证语义的泛化 manual 步骤；带匹配条件或
 * 明确安全验证语义的用户配置继续保留。
 */
async function migrateV6ToV7(): Promise<void> {
  const procedures = await getProcedures();
  let changed = false;
  const next = procedures.map((procedure) => {
    if (procedure.kind !== 'login' || !procedure.steps?.some(isGenericLoginManualStep)) return procedure;
    const steps = procedure.steps.filter((step) => !isGenericLoginManualStep(step));
    changed = true;
    return { ...procedure, steps, updatedAt: Date.now() };
  });
  if (changed) await saveProcedures(next);
}

function isGenericLoginManualStep(step: Procedure['steps'][number]): boolean {
  if (step.type !== 'manual') return false;
  if (step.match || step.selector || step.includes || step.url) return false;
  return !/(oauth|授权|验证码|captcha|二次验证|双重验证|安全验证|人工确认|challenge)/i.test(step.message || '');
}

function isUntouchedOauthDefaultLogin(
  procedure: Procedure
): procedure is Extract<Procedure, { kind: 'login' }> {
  if (procedure.kind !== 'login') return false;
  const detect = procedure.detect;
  if (
    detect.loggedInSelector ||
    detect.loggedInUrlIncludes ||
    detect.loginUrlPattern ||
    JSON.stringify(detect.notLoggedInKeywords || []) !== JSON.stringify(['请登录', '登录后操作', '您需要登录'])
  ) {
    return false;
  }
  const steps = procedure.steps || [];
  if (steps.length !== 3) return false;
  const [click, manual, wait] = steps;
  return Boolean(
    click?.type === 'click' &&
      click.selector === 'a[href*="oauth"], button.oauth, .login-oauth' &&
      click.watchPopup === true &&
      manual?.type === 'manual' &&
      manual.message === '请完成 OAuth 授权' &&
      wait?.type === 'waitForUrl' &&
      !(wait.match || wait.includes || wait.url || wait.selector)
  );
}

/** 建立网站 → 技能的一对多归属；共享旧技能会按网站复制。 */
async function migrateV3ToV4(): Promise<void> {
  const [sites, procedures] = await Promise.all([getSites(), getProcedures()]);
  const normalized = normalizeProcedureSiteOwnership(sites, procedures);
  if (normalized.changed) {
    await Promise.all([
      saveSites(normalized.sites),
      saveProcedures(normalized.procedures),
    ]);
  }
}

/** 为现有站点补齐可选的验证技能引用，不改变任何原有技能绑定。 */
async function migrateV2ToV3(): Promise<void> {
  const sites = await getSites();
  let changed = false;
  const next = sites.map((site) => {
    if (site.verificationProcedureId !== undefined) return site;
    changed = true;
    return { ...site, verificationProcedureId: null };
  });
  if (changed) await saveSites(next);
}

async function migrateV1ToV2(): Promise<void> {
  const [sites, procedures] = await Promise.all([getSites(), getProcedures()]);
  const { newProcedures, changed } = convertV1Sites(sites as Site[]);
  if (changed) {
    await Promise.all([saveSites(sites), saveProcedures([...procedures, ...newProcedures])]);
  }
}
