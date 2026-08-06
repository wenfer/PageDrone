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
import type { Site } from './models.js';

const CURRENT_VERSION = 5;

export async function runMigrations(): Promise<void> {
  const v = await getSchemaVersion();
  if (v >= CURRENT_VERSION) return;

  if (v < 2) await migrateV1ToV2();
  if (v < 3) await migrateV2ToV3();
  if (v < 4) await migrateV3ToV4();
  if (v < 5) await migrateV4ToV5();

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
