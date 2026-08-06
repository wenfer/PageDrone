import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  Bot,
  BrainCircuit,
  Boxes,
  CheckCircle2,
  CircleGauge,
  ClipboardList,
  DatabaseBackup,
  Download,
  Eye,
  FileJson2,
  Globe2,
  ListChecks,
  SearchX,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Store,
  Upload,
  Workflow,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { MSG } from '../../src/lib/messaging.js';
import {
  PROCEDURE_KIND_LABEL,
  STATUS_LABEL,
  TASK_TRIGGER_LABEL,
  createProcedure,
  createSite,
  defaultSettings,
  type CheckinDetect,
  type Flow,
  type Log,
  type LoginDetect,
  type VerificationDetect,
  type Procedure,
  type ExtractStep,
  type ExtractMode,
  type RunStatus,
  type Settings,
  type Site,
  type Step,
  type StepType,
  type Task,
} from '../../src/lib/models.js';
import { createFlow } from '../../src/lib/flows.js';
import { exportAll, importSites } from '../../src/lib/storage.js';
import { compareVersions, type MarketItem } from '../../src/lib/market.js';
import type { ChatTurn, ExploreProgressEvent, InterventionContext, RecordingPreview, RuntimeState } from '../../src/lib/types.js';
import { AiChatPanel } from './components/ai-chat/AiChatPanel';

type Tab = 'overview' | 'sites' | 'procedures' | 'market' | 'flows' | 'logs' | 'agent' | 'data' | 'settings';

type ServiceResponse<T = Record<string, unknown>> = T & { ok: boolean; error?: string };
type StatusPayload = {
  runtime: RuntimeState;
  sites: Site[];
  settings: Settings;
  procedures: Procedure[];
  queueRunning?: boolean;
};

const EMPTY_RUNTIME: RuntimeState = {
  state: 'idle', currentSiteId: null, currentSiteName: null, queue: [], message: '', updatedAt: 0,
};

const NAV: { id: Tab; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'overview', label: '概览', hint: '运行状态', icon: CircleGauge },
  { id: 'sites', label: '站点', hint: '执行入口', icon: Globe2 },
  { id: 'procedures', label: '技能', hint: '可复用操作', icon: ListChecks },
  { id: 'market', label: '技能市场', hint: '共享模板', icon: Store },
  { id: 'flows', label: '流程', hint: '画布编排', icon: Workflow },
  { id: 'logs', label: '日志', hint: '执行记录', icon: ScrollText },
  { id: 'agent', label: 'AI 对话', hint: '自然语言操作', icon: Bot },
  { id: 'data', label: '导入 / 导出', hint: '备份与迁移', icon: DatabaseBackup },
  { id: 'settings', label: '设置', hint: '全局与 AI', icon: Settings2 },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

async function send<T = Record<string, unknown>>(message: object): Promise<ServiceResponse<T>> {
  const response = await chrome.runtime.sendMessage(message) as ServiceResponse<T> | undefined;
  if (!response) throw new Error('扩展后台没有响应，请重新加载扩展');
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response;
}

async function writeEntity<T extends { id: string }>(key: string, entity: T): Promise<void> {
  const data = await chrome.storage.local.get(key);
  const list = Array.isArray(data[key]) ? data[key] as T[] : [];
  const index = list.findIndex((item) => item.id === entity.id);
  const next = [...list];
  if (index >= 0) next[index] = entity;
  else next.push(entity);
  await chrome.storage.local.set({ [key]: next });
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function statusClass(status?: RunStatus): string {
  if (status === 'success') return 'tone-success';
  if (status === 'running' || status === 'waiting_cf') return 'tone-info';
  if (status === 'skipped') return 'tone-muted';
  return status ? 'tone-error' : 'tone-muted';
}

function useExtensionState() {
  const [sites, setSites] = useState<Site[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  const [runtime, setRuntime] = useState<RuntimeState>(EMPTY_RUNTIME);
  const [queueRunning, setQueueRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [status, local] = await Promise.all([
      send<StatusPayload>({ type: MSG.GET_STATUS }),
      chrome.storage.local.get(['flows', 'logs', 'tasks']),
    ]);
    setSites(status.sites || []);
    setProcedures(status.procedures || []);
    setSettings({ ...defaultSettings(), ...(status.settings || {}) });
    setRuntime(status.runtime || EMPTY_RUNTIME);
    setQueueRunning(Boolean(status.queueRunning));
    setFlows(Array.isArray(local.flows) ? local.flows as Flow[] : []);
    setLogs(Array.isArray(local.logs) ? local.logs as Log[] : []);
    setTasks(Array.isArray(local.tasks) ? local.tasks as Task[] : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setLoading(false));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.sites) setSites(Array.isArray(changes.sites.newValue) ? changes.sites.newValue as Site[] : []);
      if (changes.procedures) setProcedures(Array.isArray(changes.procedures.newValue) ? changes.procedures.newValue as Procedure[] : []);
      if (changes.flows) setFlows(Array.isArray(changes.flows.newValue) ? changes.flows.newValue as Flow[] : []);
      if (changes.logs) setLogs(Array.isArray(changes.logs.newValue) ? changes.logs.newValue as Log[] : []);
      if (changes.tasks) setTasks(Array.isArray(changes.tasks.newValue) ? changes.tasks.newValue as Task[] : []);
      if (changes.settings?.newValue) setSettings({ ...defaultSettings(), ...changes.settings.newValue as Partial<Settings> });
      if (changes.runtime?.newValue) {
        const next = changes.runtime.newValue as RuntimeState;
        setRuntime(next || EMPTY_RUNTIME);
        const queueState = next?.state === 'running' || next?.state === 'waiting_cf' || next?.state === 'need_manual' || next?.state === 'need_intervention';
        setQueueRunning(Boolean(queueState && (next?.currentSiteId || next?.queue?.length)));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  return { sites, procedures, flows, logs, tasks, settings, runtime, queueRunning, loading, refresh, applySettings: setSettings };
}

export default function App() {
  const state = useExtensionState();
  const deepLinkedProcedure = decodeURIComponent(location.hash.match(/^#proc\/(.+)$/)?.[1] || '');
  const [tab, setTab] = useState<Tab>(deepLinkedProcedure ? 'procedures' : 'overview');
  const [procedureLink, setProcedureLink] = useState(deepLinkedProcedure);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    const followHash = () => {
      const id = decodeURIComponent(location.hash.match(/^#proc\/(.+)$/)?.[1] || '');
      if (id) { setProcedureLink(id); setTab('procedures'); }
    };
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  const notify = useCallback((text: string, error = false) => {
    setNotice({ text, error });
    window.setTimeout(() => setNotice(null), 3600);
  }, []);

  const runAll = async () => {
    try {
      const result = await send<{ queued: number }>({ type: MSG.RUN_ALL });
      notify(`已加入 ${result.queued} 个站点`);
      await state.refresh();
    } catch (error) { notify(errorText(error), true); }
  };
  const stop = async () => {
    try { await send({ type: MSG.STOP, reason: '用户从设置页停止' }); notify('已请求停止'); }
    catch (error) { notify(errorText(error), true); }
  };
  const openAiEntity = (entity: NonNullable<ChatTurn['touched']>[number]) => {
    if (entity.kind === 'procedure') {
      const hash = `#proc/${encodeURIComponent(entity.id)}`;
      setProcedureLink(entity.id);
      setTab('procedures');
      if (location.hash !== hash) location.hash = hash;
    } else if (entity.kind === 'site') {
      setTab('sites');
    } else {
      window.open(chrome.runtime.getURL(`canvas.html?flowId=${encodeURIComponent(entity.id)}`), '_blank');
    }
  };

  const activeNav = NAV.find((item) => item.id === tab)!;
  const ActiveNavIcon = activeNav.icon;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">a</span><span><strong>auto-page</strong><small>网页 RPA 工作台</small></span></div>
        <nav aria-label="主导航">
          {NAV.map((item) => (
            <button key={item.id} type="button" className={tab === item.id ? 'nav-button active' : 'nav-button'} onClick={() => setTab(item.id)}>
              <item.icon aria-hidden="true" />
              <span className="nav-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className={`status-dot ${state.runtime.state === 'idle' ? '' : 'busy'}`} />
          <span><strong>{state.runtime.state === 'idle' ? '已就绪' : '正在运行'}</strong><small>{state.runtime.message || 'Service Worker 已连接'}</small></span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-heading"><span className="topbar-icon"><ActiveNavIcon aria-hidden="true" /></span><div><p className="eyebrow">{activeNav.hint}</p><h1>{activeNav.label}</h1></div></div>
          <div className="top-actions">
            {state.queueRunning ? <button className="button danger" onClick={stop}>停止执行</button> : null}
            <button className="button primary" onClick={runAll} disabled={state.queueRunning}>全部自动化</button>
          </div>
        </header>
        <div className="page">
          <InterventionCard runtime={state.runtime} notify={notify} />
          {state.loading ? <div className="empty">正在读取扩展数据…</div> : null}
          {!state.loading && tab === 'overview' ? <Overview {...state} onNavigate={setTab} /> : null}
          {!state.loading && tab === 'sites' ? <SitesPanel sites={state.sites} procedures={state.procedures} settings={state.settings} notify={notify} onOpenProcedure={(id) => { setProcedureLink(id); setTab('procedures'); location.hash = `#proc/${encodeURIComponent(id)}`; }} /> : null}
          {!state.loading && tab === 'procedures' ? <ProceduresPanel sites={state.sites} procedures={state.procedures} settings={state.settings} runtime={state.runtime} initialSelectedId={procedureLink} notify={notify} /> : null}
          {!state.loading && tab === 'market' ? <MarketPanel sites={state.sites} procedures={state.procedures} notify={notify} /> : null}
          {!state.loading && tab === 'flows' ? <FlowsPanel flows={state.flows} notify={notify} /> : null}
          {!state.loading && tab === 'logs' ? <LogsPanel logs={state.logs} tasks={state.tasks} notify={notify} /> : null}
          {!state.loading && tab === 'agent' ? <AiChatPanel settings={state.settings} runtime={state.runtime} notify={notify} onOpenSettings={() => setTab('settings')} onOpenEntity={openAiEntity} /> : null}
          {!state.loading && tab === 'data' ? <DataTransferPanel notify={notify} /> : null}
          {!state.loading && tab === 'settings' ? <SettingsPanel settings={state.settings} applySettings={state.applySettings} notify={notify} /> : null}
        </div>
      </main>
      {notice ? <div className={notice.error ? 'toast error' : 'toast'} role="status">{notice.text}</div> : null}
    </div>
  );
}

function InterventionCard({ runtime, notify }: { runtime: RuntimeState; notify: (text: string, error?: boolean) => void }) {
  const intervention = (runtime as RuntimeState & { intervention?: InterventionContext }).intervention || runtime.interventionCtx;
  const stepSelector = intervention?.step && 'selector' in intervention.step && typeof intervention.step.selector === 'string' ? intervention.step.selector : '';
  const [selector, setSelector] = useState('');
  useEffect(() => {
    setSelector(stepSelector);
  }, [intervention?.token]);
  if (runtime.state !== 'need_intervention' || !intervention) return null;
  const resolve = async (action: 'retry' | 'skip' | 'patch' | 'abort') => {
    try {
      const patchStep = action === 'patch' && 'selector' in intervention.step
        ? { ...intervention.step, selector }
        : undefined;
      await send({ type: MSG.INTERVENTION_RESOLVE, token: intervention.token, action, patchStep });
      notify(action === 'patch' ? '已应用修复并重试' : '介入决策已提交');
    } catch (error) { notify(errorText(error), true); }
  };
  const canPatch = 'selector' in intervention.step;
  return <section className="panel intervention-card">
    <div className="section-head"><div><p className="eyebrow">Execution intervention</p><h2>步骤执行失败，需要你的决策</h2></div><span className="badge tone-error">步骤 {intervention.stepIndex + 1}</span></div>
    <p className="intervention-error">{intervention.error}</p>
    <div className="intervention-meta"><span>类型：<strong>{intervention.step.type}</strong></span><code>{canPatch ? stepSelector : JSON.stringify(intervention.step)}</code></div>
    {canPatch ? <Field label="修改选择器并重试"><input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="新的 CSS / XPath 选择器" /></Field> : null}
    <div className="form-actions"><button className="button danger ghost" onClick={() => resolve('abort')}>终止执行</button><span className="grow" /><button className="button" onClick={() => resolve('skip')}>跳过此步</button><button className="button" onClick={() => resolve('retry')}>原样重试</button>{canPatch ? <button className="button primary" disabled={!selector.trim()} onClick={() => resolve('patch')}>应用修复</button> : null}</div>
  </section>;
}

function Overview({ sites, procedures, flows, logs, runtime, onNavigate }: ReturnType<typeof useExtensionState> & { onNavigate: (tab: Tab) => void }) {
  const successes = logs.filter((item) => item.status === 'success').length;
  return (
    <div className="stack gap-lg">
      <section className="hero-card">
        <div><p className="eyebrow">实时状态</p><h2>{runtime.message || '自动化环境已就绪'}</h2><p>{runtime.currentSiteName ? `当前站点：${runtime.currentSiteName}` : '技能、站点和流程会随着 storage 变化实时更新。'}</p></div>
        <span className={`runtime-pill ${runtime.state === 'idle' ? '' : 'busy'}`}>{runtime.state}</span>
      </section>
      <section className="metric-grid">
        <Metric label="已配置站点" value={sites.length} onClick={() => onNavigate('sites')} />
        <Metric label="可复用技能" value={procedures.length} onClick={() => onNavigate('procedures')} />
        <Metric label="画布流程" value={flows.length} onClick={() => onNavigate('flows')} />
        <Metric label="成功记录" value={successes} onClick={() => onNavigate('logs')} />
      </section>
      <section className="panel">
        <div className="section-head"><div><p className="eyebrow">最近活动</p><h2>执行结果</h2></div><button className="button ghost" onClick={() => onNavigate('logs')}>查看全部</button></div>
        {logs.length ? <div className="activity-list">{logs.slice(0, 6).map((log) => <div className="activity" key={log.id}><span className={`badge ${statusClass(log.status)}`}>{STATUS_LABEL[log.status]}</span><div><strong>{log.siteName}</strong><small>{log.message}</small></div><time>{formatTime(log.finishedAt)}</time></div>)}</div> : <div className="empty compact">暂无执行记录</div>}
      </section>
    </div>
  );
}

function Metric({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return <button className="metric" onClick={onClick}><strong>{value}</strong><span>{label}</span><small>打开管理 →</small></button>;
}

function EmptyState({ icon: Icon, title, description, compact = false, actions }: { icon: LucideIcon; title: string; description: string; compact?: boolean; actions?: ReactNode }) {
  return <div className={compact ? 'empty-state compact' : 'empty-state'}>
    <span className="empty-state-icon"><Icon aria-hidden="true" /></span>
    <div className="empty-state-copy"><h3>{title}</h3><p>{description}</p></div>
    {actions ? <div className="empty-state-actions">{actions}</div> : null}
  </div>;
}

function SitesPanel({ sites, procedures, settings, notify, onOpenProcedure }: { sites: Site[]; procedures: Procedure[]; settings: Settings; notify: (text: string, error?: boolean) => void; onOpenProcedure: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(sites[0]?.id || null);
  const selected = sites.find((item) => item.id === selectedId) || null;
  const [draft, setDraft] = useState<Site | null>(selected);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (selected && !creating) setDraft(structuredClone(selected)); }, [creating, selected]);
  useEffect(() => {
    if (!creating && selectedId && !sites.some((item) => item.id === selectedId)) {
      const next = sites[0] || null;
      setSelectedId(next?.id || null);
      setDraft(next ? structuredClone(next) : null);
    }
  }, [creating, selectedId, sites]);
  useEffect(() => {
    if (creating && selectedId && sites.some((item) => item.id === selectedId)) setCreating(false);
  }, [creating, selectedId, sites]);

  const add = () => {
    const site = createSite({ cfTimeoutMs: settings.defaultCfTimeoutMs, pageLoadTimeoutMs: settings.defaultPageLoadTimeoutMs, openInBackground: settings.openInBackground });
    setCreating(true); setSelectedId(site.id); setDraft(site);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim() || !/^https?:\/\//i.test(draft.url)) return notify('请填写名称和有效的 http(s) 地址', true);
    const bindings: Array<[keyof Pick<Site, 'checkinProcedureId' | 'loginProcedureId' | 'verificationProcedureId'>, Procedure['kind']]> = [
      ['checkinProcedureId', 'checkin'],
      ['loginProcedureId', 'login'],
      ['verificationProcedureId', 'verification'],
    ];
    for (const [key, expectedKind] of bindings) {
      const procedureId = draft[key];
      if (!procedureId) continue;
      const procedure = procedures.find((item) => item.id === procedureId);
      if (!procedure || procedure.siteId !== draft.id || procedure.kind !== expectedKind) {
        return notify(`默认${PROCEDURE_KIND_LABEL[expectedKind]}必须选择当前网站下的${PROCEDURE_KIND_LABEL[expectedKind]}`, true);
      }
    }
    try {
      const next = { ...draft, name: draft.name.trim(), url: draft.url.trim(), updatedAt: Date.now() };
      await writeEntity('sites', next);
      await send({ type: MSG.RESCHEDULE });
      setCreating(false);
      setSelectedId(next.id); notify('站点已保存');
    } catch (error) { notify(errorText(error), true); }
  };
  const remove = async () => {
    if (!draft || !confirm(`删除站点“${draft.name}”？`)) return;
    const childCount = procedures.filter((item) => item.siteId === draft.id || [draft.checkinProcedureId, draft.loginProcedureId, draft.verificationProcedureId].includes(item.id)).length;
    if (childCount) return notify(`该网站下还有 ${childCount} 个技能，请先删除或迁移技能`, true);
    const next = sites.filter((item) => item.id !== draft.id);
    await chrome.storage.local.set({ sites: next });
    await send({ type: MSG.RESCHEDULE }).catch(() => null);
    setCreating(false); setSelectedId(next[0]?.id || null); notify('站点已删除');
  };
  const run = async () => {
    if (!draft) return;
    try { await send({ type: MSG.RUN_SITE, siteId: draft.id, force: true }); notify('站点已加入执行队列'); }
    catch (error) { notify(errorText(error), true); }
  };

  const siteSkills = draft ? procedures.filter((item) => item.siteId === draft.id) : [];
  const checkin = siteSkills.filter((item) => item.kind === 'checkin');
  const login = siteSkills.filter((item) => item.kind === 'login');
  const verification = siteSkills.filter((item) => item.kind === 'verification');
  const createSkill = async (kind: Procedure['kind']) => {
    if (!draft || creating) return notify('请先保存网站，再创建网站技能', true);
    try {
      const response = await send<{ procedure: Procedure }>({
        type: MSG.PROCEDURE_SAVE,
        procedure: createProcedure({ kind, siteId: draft.id, url: draft.url.trim() }),
      });
      notify('技能已创建');
      onOpenProcedure(response.procedure.id);
    } catch (error) { notify(errorText(error), true); }
  };
  return (
    <div className="master-detail">
      <section className="panel master-list">
        <div className="section-head"><div><p className="eyebrow">Sites</p><h2>站点列表</h2></div><button className="button primary small" onClick={add}>新建</button></div>
        <div className="list-buttons">
          {sites.map((site) => <button key={site.id} className={selectedId === site.id ? 'list-button active' : 'list-button'} onClick={() => { setCreating(false); setSelectedId(site.id); }}><span><strong>{site.name}</strong><small>{site.url}</small></span><span className={`badge ${statusClass(site.lastResult?.status)}`}>{site.lastResult ? STATUS_LABEL[site.lastResult.status] : '未运行'}</span></button>)}
          {!sites.length ? <div className="empty compact">还没有站点</div> : null}
        </div>
      </section>
      <section className="panel detail-panel">
        {draft ? <>
        <form onSubmit={save} className="form-stack">
          <div className="section-head"><div><p className="eyebrow">Site editor</p><h2>{sites.some((item) => item.id === draft.id) ? '编辑站点' : '新建站点'}</h2></div><label className="switch"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /><span>启用</span></label></div>
          <div className="form-grid two"><Field label="名称"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="目标 URL"><input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com" /></Field></div>
          <div className="form-grid three"><Field label="自动化技能"><select value={draft.checkinProcedureId} onChange={(e) => setDraft({ ...draft, checkinProcedureId: e.target.value })}><option value="">请选择技能</option>{checkin.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="登录技能"><select value={draft.loginProcedureId || ''} onChange={(e) => setDraft({ ...draft, loginProcedureId: e.target.value || null })}><option value="">无需登录技能</option>{login.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="验证技能"><select value={draft.verificationProcedureId || ''} onChange={(e) => setDraft({ ...draft, verificationProcedureId: e.target.value || null })}><option value="">使用内置人工验证</option>{verification.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>
          <div className="form-grid three"><NumberField label="页面加载超时（ms）" value={draft.pageLoadTimeoutMs} onChange={(value) => setDraft({ ...draft, pageLoadTimeoutMs: value })} /><NumberField label="防护等待（ms）" value={draft.cfTimeoutMs} onChange={(value) => setDraft({ ...draft, cfTimeoutMs: value })} /><NumberField label="步骤总超时（ms）" value={draft.stepsTimeoutMs} onChange={(value) => setDraft({ ...draft, stepsTimeoutMs: value })} /></div>
          <div className="inline-options"><label><input type="checkbox" checked={draft.openInBackground} onChange={(e) => setDraft({ ...draft, openInBackground: e.target.checked })} /> 后台打开标签页</label><label><input type="checkbox" checked={draft.keepTabOnError} onChange={(e) => setDraft({ ...draft, keepTabOnError: e.target.checked })} /> 失败时保留标签页</label><label><input type="checkbox" checked={draft.schedule.enabled} onChange={(e) => setDraft({ ...draft, schedule: { ...draft.schedule, enabled: e.target.checked } })} /> 每日定时</label>{draft.schedule.enabled ? <input className="time-input" type="time" value={`${String(draft.schedule.hour).padStart(2, '0')}:${String(draft.schedule.minute).padStart(2, '0')}`} onChange={(e) => { const [hour, minute] = e.target.value.split(':').map(Number); setDraft({ ...draft, schedule: { ...draft.schedule, hour: hour || 0, minute: minute || 0 } }); }} /> : null}</div>
          <div className="form-actions"><button type="button" className="button danger ghost" onClick={remove}>删除</button><span className="grow" /><button type="button" className="button" onClick={run} disabled={!sites.some((item) => item.id === draft.id)}>立即测试</button><button className="button primary" type="submit">保存站点</button></div>
        </form>
        {sites.some((item) => item.id === draft.id) ? <section className="site-skills-block">
          <div className="subsection-head"><div><h3>网站技能</h3><small>技能归属于当前网站，流程也会按网站筛选技能。</small></div><span className="badge tone-info">{siteSkills.length} 个</span></div>
          <div className="card-grid site-skill-grid">{siteSkills.map((skill) => <article className="entity-card" key={skill.id}><div><span className="badge tone-muted">{PROCEDURE_KIND_LABEL[skill.kind]}</span><h3>{skill.name}</h3><p>{skill.description || skill.url || '暂无说明'}</p></div><small>{skill.steps.length} 个步骤</small><div className="form-actions"><span className="grow" /><button type="button" className="button primary small" onClick={() => onOpenProcedure(skill.id)}>编辑技能</button></div></article>)}{!siteSkills.length ? <div className="empty compact wide">当前网站还没有技能，请从下方创建。</div> : null}</div>
          <div className="form-actions site-skill-actions"><button type="button" className="button" onClick={() => void createSkill('login')}>新建登录技能</button><button type="button" className="button" onClick={() => void createSkill('verification')}>新建验证技能</button><button type="button" className="button primary" onClick={() => void createSkill('checkin')}>新建自动化技能</button></div>
        </section> : null}
        </> : <div className="empty">选择一个站点，或创建新站点</div>}
      </section>
    </div>
  );
}

function ProceduresPanel({ sites, procedures, settings, runtime, initialSelectedId, notify }: { sites: Site[]; procedures: Procedure[]; settings: Settings; runtime: RuntimeState; initialSelectedId?: string; notify: (text: string, error?: boolean) => void }) {
  const initialProcedure = procedures.find((item) => item.id === initialSelectedId)
    || procedures.find((item) => item.siteId === sites[0]?.id)
    || null;
  const [selectedId, setSelectedId] = useState<string | null>(initialProcedure?.id || null);
  const [draft, setDraft] = useState<Procedure | null>(initialProcedure ? structuredClone(initialProcedure) : null);
  const [siteId, setSiteId] = useState(initialProcedure?.siteId || sites[0]?.id || '');
  const [query, setQuery] = useState('');
  const [exploreOpen, setExploreOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  useEffect(() => {
    const value = procedures.find((item) => item.id === selectedId);
    // storage 中任意技能变化都可能刷新 procedures。仅在切换技能身份时同步草稿，
    // 避免无关的实时更新覆盖用户尚未保存的编辑内容。
    if (value && draft?.id !== value.id) setDraft(structuredClone(value));
    if (value?.siteId && value.siteId !== siteId) setSiteId(value.siteId);
  }, [selectedId, procedures, draft?.id, siteId]);
  useEffect(() => { if (initialSelectedId && procedures.some((item) => item.id === initialSelectedId)) setSelectedId(initialSelectedId); }, [initialSelectedId, procedures]);
  useEffect(() => {
    if (!sites.some((site) => site.id === siteId)) setSiteId(sites[0]?.id || '');
  }, [siteId, sites]);
  const siteProcedures = useMemo(() => procedures.filter((item) => item.siteId === siteId), [procedures, siteId]);
  useEffect(() => {
    const draftBelongsToSelectedSite = draft?.id === selectedId && draft.siteId === siteId;
    if (selectedId && !siteProcedures.some((item) => item.id === selectedId) && !draftBelongsToSelectedSite) {
      setSelectedId(siteProcedures[0]?.id || null);
      setDraft(siteProcedures[0] ? structuredClone(siteProcedures[0]) : null);
    }
  }, [draft?.id, selectedId, siteProcedures]);
  const filtered = siteProcedures.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const selectProcedure = (procedure: Procedure) => {
    setSelectedId(procedure.id);
    setSiteId(procedure.siteId || '');
    setDraft(structuredClone(procedure));
  };
  const openGeneratedProcedure = async (id: string) => {
    try {
      // explorationResult 只携带 ID；主动读取后台的最终保存结果，确保编辑草稿
      // 与生成技能使用同一个 ID，不依赖 storage.onChanged 的到达时序。
      const response = await send<{ procedures: Procedure[] }>({ type: MSG.PROCEDURE_LIST });
      const generated = response.procedures.find((item) => item.id === id);
      if (!generated) throw new Error('未找到刚生成的技能，请刷新后重试');
      setQuery('');
      setSiteId(generated.siteId || siteId);
      selectProcedure(generated);
      setExploreOpen(false);
    } catch (error) { notify(errorText(error), true); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    if (!draft.siteId || !sites.some((site) => site.id === draft.siteId)) return notify('技能必须归属于一个网站，请先选择网站', true);
    try {
      // selectedId 表示用户当前正在编辑的持久化实体。保存前从后台确认一次，
      // 即使 UI 曾发生异步状态错位，也不能拿临时草稿 ID 误新增一条技能。
      const latest = await send<{ procedures: Procedure[] }>({ type: MSG.PROCEDURE_LIST });
      const persistedSelection = selectedId && latest.procedures.some((item) => item.id === selectedId) ? selectedId : null;
      const response = await send<{ procedure: Procedure }>({
        type: MSG.PROCEDURE_SAVE,
        procedure: { ...draft, output: draft.output || { enabled: false, fields: [] }, id: persistedSelection || draft.id, updatedAt: Date.now() },
      });
      setSelectedId(response.procedure.id);
      setDraft(structuredClone(response.procedure));
      notify('技能已保存');
    }
    catch (error) { notify(errorText(error), true); }
  };
  const remove = async () => {
    if (!draft || !confirm(`删除技能“${draft.name}”？`)) return;
    try { await send({ type: MSG.PROCEDURE_DELETE, id: draft.id }); setSelectedId(procedures.find((item) => item.id !== draft.id)?.id || null); setDraft(null); notify('技能已删除'); }
    catch (error) { notify(errorText(error), true); }
  };
  const run = async () => {
    if (!draft) return;
    const siteUrl = sites.find((site) => site.id === draft.siteId)?.url || draft.url || '';
    try { const result = await send<{ message?: string }>({ type: MSG.RUN_PROCEDURE, procedureId: draft.id, url: siteUrl, active: true, keepTab: true, watchDeviation: true }); notify(result.message || '技能执行完成'); }
    catch (error) { notify(errorText(error), true); }
  };
  return (
    <div className="stack gap-lg">
      <section className="panel toolbar-panel procedure-toolbar"><div className="toolbar-title"><p className="eyebrow">Skill library</p><h2>网站技能</h2><p className="section-description">先选择网站，再查看和编辑该网站下的技能。新建技能请从网站操作中进入。</p></div><div className="toolbar"><select value={siteId} onChange={(event) => { setSiteId(event.target.value); setSelectedId(null); setDraft(null); setQuery(''); }}><option value="">选择网站</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select><input className="toolbar-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索当前网站技能" /><button className="button" disabled={!siteId} onClick={() => setRecordOpen(true)}>录制生成</button><button className="button accent" disabled={!siteId || !settings.llmApiKey} onClick={() => settings.llmApiKey ? setExploreOpen(true) : notify('请先在设置中保存 AI API Key', true)}>AI 探索</button></div></section>
      <div className="master-detail procedure-workspace">
        <section className="panel master-list"><div className="master-list-head"><strong>技能列表</strong><span>{filtered.length}</span></div><div className="list-buttons">{filtered.map((item) => <button key={item.id} className={selectedId === item.id ? 'list-button active' : 'list-button'} onClick={() => selectProcedure(item)}><span><strong>{item.name}</strong><small>{item.description || item.url || '暂无描述'}{item.output?.enabled ? ' · 有返回值' : ''}</small></span><span className="badge tone-muted">{PROCEDURE_KIND_LABEL[item.kind]}</span></button>)}{!filtered.length ? <EmptyState compact icon={query ? SearchX : ClipboardList} title={query ? '没有匹配的技能' : '技能库还是空的'} description={query ? '换一个关键词，或清空搜索条件后再试。' : '创建第一个技能后，它会出现在这里。'} /> : null}</div></section>
        <section className="panel detail-panel">{draft ? <ProcedureForm draft={draft} sites={sites} setDraft={setDraft} onSave={save} onDelete={remove} onRun={run} persisted={procedures.some((item) => item.id === draft.id)} /> : <EmptyState icon={Boxes} title={siteId ? '该网站还没有技能' : '先选择一个网站'} description={siteId ? '请回到网站操作中创建自动化、登录或验证技能。' : '选择网站后，这里只展示该网站下的技能。'} />}</section>
      </div>
      {exploreOpen ? <ExploreDialog siteId={siteId} siteUrl={sites.find((site) => site.id === siteId)?.url || ''} runtime={runtime} onClose={() => setExploreOpen(false)} onGenerated={openGeneratedProcedure} notify={notify} /> : null}
      {recordOpen ? <RecordDialog siteId={siteId} siteUrl={sites.find((site) => site.id === siteId)?.url || ''} runtime={runtime} onClose={() => setRecordOpen(false)} notify={notify} /> : null}
    </div>
  );
}

function ProcedureForm({ draft, sites, setDraft, onSave, onDelete, onRun, persisted }: { draft: Procedure; sites: Site[]; setDraft: (value: Procedure) => void; onSave: (event: FormEvent) => void; onDelete: () => void; onRun: () => void; persisted: boolean }) {
  const detect = draft.detect;
  const updateStep = (index: number, step: Step) => setDraft({ ...draft, steps: draft.steps.map((item, i) => i === index ? step : item) });
  const addStep = () => setDraft({ ...draft, steps: [...draft.steps, defaultStep('click')] });
  const keywords = draft.kind === 'login'
    ? (detect as LoginDetect).notLoggedInKeywords
    : draft.kind === 'checkin'
      ? (detect as CheckinDetect).successKeywords
      : [];
  const output = {
    enabled: draft.output?.enabled === true,
    fields: Array.isArray(draft.output?.fields) ? draft.output.fields : [],
  };
  const outputNames = draft.steps
    .map((step, index) => step.type === 'extract' ? (step as ExtractStep).variable || `step_${index + 1}` : '')
    .filter(Boolean);
  const setKeywords = (value: string) => {
    const list = value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    if (draft.kind === 'login') {
      setDraft({ ...draft, detect: { ...(detect as LoginDetect), notLoggedInKeywords: list } });
    } else if (draft.kind === 'checkin') {
      setDraft({ ...draft, detect: { ...(detect as CheckinDetect), successKeywords: list } });
    }
  };
  return <form className="form-stack" onSubmit={onSave}>
    <div className="section-head"><div><p className="eyebrow">{draft.kind}</p><h2>编辑技能</h2></div><span className="badge tone-info">{PROCEDURE_KIND_LABEL[draft.kind]}</span></div>
    <div className="form-grid two"><Field label="所属网站"><select required value={draft.siteId || ''} onChange={(e) => { const site = sites.find((item) => item.id === e.target.value); setDraft({ ...draft, siteId: e.target.value, url: site?.url || draft.url || '' }); }}><option value="">请选择网站</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></Field><Field label="技能名称"><input value={draft.name} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field></div>
    <Field label="网站 URL"><input value={draft.url || sites.find((site) => site.id === draft.siteId)?.url || ''} readOnly placeholder="选择网站后自动带入" /></Field>
    <Field label="说明"><textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
    <section className="return-contract">
      <div className="subsection-head"><div><h3>技能返回值</h3><small>把提取操作或自定义脚本的结果暴露给流程节点与调用方</small></div><label className="switch"><input type="checkbox" checked={Boolean(output.enabled)} onChange={(e) => setDraft({ ...draft, output: { ...output, enabled: e.target.checked } })} />启用返回值</label></div>
      {output.enabled ? <div className="form-stack compact-stack"><Field label="返回字段（逗号分隔）" hint={outputNames.length ? `当前可用：${outputNames.join('、')}；留空返回全部结果。` : '提取步骤的变量名会自动成为可返回字段；脚本可通过 return 返回 result。'}><input value={output.fields.join(', ')} onChange={(e) => setDraft({ ...draft, output: { ...output, fields: e.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } })} placeholder="items, title" /></Field></div> : null}
    </section>
    {draft.kind === 'verification' ? <div className="form-grid two"><Field label="验证完成选择器"><input value={(detect as VerificationDetect).completedSelector} onChange={(e) => setDraft({ ...draft, detect: { ...(detect as VerificationDetect), completedSelector: e.target.value } })} placeholder="例如 .dashboard 或 #verified" /></Field><Field label="验证完成 URL 包含"><input value={(detect as VerificationDetect).completedUrlIncludes} onChange={(e) => setDraft({ ...draft, detect: { ...(detect as VerificationDetect), completedUrlIncludes: e.target.value } })} placeholder="例如 /dashboard" /></Field></div> : <div className="form-grid two"><Field label={draft.kind === 'login' ? '未登录关键词（逗号分隔）' : '成功关键词（逗号分隔）'}><input value={keywords.join(', ')} onChange={(e) => setKeywords(e.target.value)} /></Field>{draft.kind === 'login' ? <Field label="登录页 URL 模式"><input value={(detect as LoginDetect).loginUrlPattern} onChange={(e) => setDraft({ ...draft, detect: { ...(detect as LoginDetect), loginUrlPattern: e.target.value } })} /></Field> : <Field label="失败关键词（逗号分隔）"><input value={(detect as CheckinDetect).failKeywords.join(', ')} onChange={(e) => setDraft({ ...draft, detect: { ...(detect as CheckinDetect), failKeywords: e.target.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) } })} /></Field>}</div>}
    <div className="subsection-head"><div><h3>执行步骤</h3><small>按顺序在目标页面执行</small></div><button type="button" className="button small" onClick={addStep}>添加步骤</button></div>
    <div className="step-list">{draft.steps.map((step, index) => <StepRow key={`${index}-${step.type}`} step={step} index={index} onChange={(value) => updateStep(index, value)} onMove={(delta) => { const target = index + delta; if (target < 0 || target >= draft.steps.length) return; const steps = [...draft.steps]; [steps[index], steps[target]] = [steps[target]!, steps[index]!]; setDraft({ ...draft, steps }); }} onRemove={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })} />)}{!draft.steps.length ? <div className="empty compact">没有步骤，可仅使用下方自定义脚本</div> : null}</div>
    <Field label="自定义脚本（无步骤时执行）" hint={draft.steps.length ? '当前技能已有标准步骤，脚本不会执行；清空步骤后可将脚本作为高级兜底。' : '脚本仅在没有标准步骤时执行。'}><textarea className="code-input" rows={7} value={draft.script} onChange={(e) => setDraft({ ...draft, script: e.target.value })} spellCheck={false} /></Field>
    <div className="form-actions"><button type="button" className="button danger ghost" onClick={onDelete} disabled={!persisted}>删除</button><span className="grow" /><button type="button" className="button" onClick={onRun} disabled={!persisted}>运行技能</button><button className="button primary" type="submit">保存技能</button></div>
  </form>;
}

const STEP_LABEL: Record<StepType, string> = { wait: '固定等待', waitFor: '等待元素', waitForText: '等待文本', type: '输入文本', goto: '跳转 URL', waitForUrl: '等待 URL', manual: '人工操作', extract: '提取数据', click: '点击' };
function defaultStep(type: StepType): Step {
  switch (type) {
    case 'wait': return { type, ms: 1000 };
    case 'waitFor': return { type, selector: '', timeoutMs: 15000 };
    case 'waitForText': return { type, selector: 'body', includes: '', timeoutMs: 15000 };
    case 'type': return { type, selector: '', text: '', timeoutMs: 15000 };
    case 'goto': return { type, url: '' };
    case 'waitForUrl': return { type, match: '', timeoutMs: 60000 };
    case 'manual': return { type, message: '请完成页面操作', match: '', timeoutMs: 180000 };
    case 'extract': return { type, selector: '', mode: 'text', multiple: false, variable: 'data', required: true, timeoutMs: 15000 };
    case 'click': return { type, selector: '', waitNavigation: false, timeoutMs: 15000 };
  }
}

function StepRow({ step, index, onChange, onMove, onRemove }: { step: Step; index: number; onChange: (step: Step) => void; onMove: (delta: number) => void; onRemove: () => void }) {
  const patch = (value: Record<string, unknown>) => onChange({ ...step, ...value } as Step);
  return <div className="step-row"><span className="step-number">{index + 1}</span><select value={step.type} onChange={(e) => onChange(defaultStep(e.target.value as StepType))}>{Object.entries(STEP_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><StepFields step={step} patch={patch} /><input className="timeout-input" type="number" title="超时（ms）" value={step.timeoutMs || ''} placeholder="超时 ms" onChange={(e) => patch({ timeoutMs: Number(e.target.value) || undefined })} /><div className="icon-actions"><button type="button" title="上移" onClick={() => onMove(-1)}>↑</button><button type="button" title="下移" onClick={() => onMove(1)}>↓</button><button type="button" title="删除" onClick={onRemove}>×</button></div></div>;
}

function StepFields({ step, patch }: { step: Step; patch: (value: Record<string, unknown>) => void }) {
  if (step.type === 'wait') return <input type="number" value={step.ms} onChange={(e) => patch({ ms: Number(e.target.value) || 0 })} placeholder="等待毫秒" />;
  if (step.type === 'goto') return <input value={step.url} onChange={(e) => patch({ url: e.target.value })} placeholder="https://…" />;
  if (step.type === 'waitForUrl') return <input value={step.match} onChange={(e) => patch({ match: e.target.value })} placeholder="URL 子串或 /正则/" />;
  if (step.type === 'manual') return <div className="step-fields"><input value={step.message} onChange={(e) => patch({ message: e.target.value })} placeholder="操作提示" /><input value={step.match} onChange={(e) => patch({ match: e.target.value })} placeholder="完成后的 URL" /></div>;
  if (step.type === 'extract') return <div className="step-fields extract-step-fields"><input value={step.selector} onChange={(e) => patch({ selector: e.target.value })} placeholder="CSS / XPath 选择器" /><select value={step.mode} onChange={(e) => patch({ mode: e.target.value as ExtractMode })}><option value="text">文本</option><option value="attribute">属性</option><option value="html">HTML</option><option value="value">表单值</option><option value="list">列表</option><option value="table">表格</option></select>{step.mode === 'attribute' ? <input value={step.attribute || ''} onChange={(e) => patch({ attribute: e.target.value })} placeholder="属性名，如 href" /> : null}<input value={step.variable || ''} onChange={(e) => patch({ variable: e.target.value })} placeholder="结果名，如 items" /><label className="mini-check"><input type="checkbox" checked={Boolean(step.multiple)} onChange={(e) => patch({ multiple: e.target.checked })} /> 全部匹配</label><label className="mini-check"><input type="checkbox" checked={step.required !== false} onChange={(e) => patch({ required: e.target.checked })} /> 未找到时失败</label></div>;
  if (step.type === 'waitForText') return <div className="step-fields"><input value={step.selector} onChange={(e) => patch({ selector: e.target.value })} placeholder="CSS / XPath" /><input value={step.includes} onChange={(e) => patch({ includes: e.target.value })} placeholder="目标文本" /></div>;
  if (step.type === 'type') return <div className="step-fields"><input value={step.selector} onChange={(e) => patch({ selector: e.target.value })} placeholder="CSS / XPath" /><input value={step.text} onChange={(e) => patch({ text: e.target.value })} placeholder="输入内容" /></div>;
  if (step.type === 'click') return <div className="step-fields"><input value={step.selector} onChange={(e) => patch({ selector: e.target.value })} placeholder="CSS / XPath" /><label className="mini-check"><input type="checkbox" checked={step.waitNavigation} onChange={(e) => patch({ waitNavigation: e.target.checked })} /> 等待导航</label><label className="mini-check"><input type="checkbox" checked={Boolean(step.watchPopup)} onChange={(e) => patch({ watchPopup: e.target.checked, followPopup: e.target.checked ? Boolean(step.followPopup) : false })} /> 监视新标签页</label>{step.watchPopup ? <label className="mini-check"><input type="checkbox" checked={Boolean(step.followPopup)} onChange={(e) => patch({ followPopup: e.target.checked })} /> 在新标签页继续</label> : null}</div>;
  return <input value={step.selector} onChange={(e) => patch({ selector: e.target.value })} placeholder="CSS / XPath" />;
}

const EXPLORE_STAGE_LABEL: Record<ExploreProgressEvent['stage'], string> = {
  opening: '打开页面', observing: '观察页面', thinking: 'AI 分析', decision: '操作决策', executing: '执行操作', response: '浏览器响应', complete: '探索完成', error: '探索结束',
};

function ExploreTimelineItem({ event, latest }: { event: ExploreProgressEvent; latest: boolean }) {
  const EventIcon = event.status === 'error' ? XCircle : event.status === 'success' ? CheckCircle2 : event.stage === 'observing' ? Eye : event.stage === 'thinking' || event.stage === 'decision' ? BrainCircuit : event.stage === 'complete' ? Sparkles : CircleGauge;
  const response = event.response;
  const observation = response?.observation;
  const changes = observation ? [observation.urlChanged && 'URL', observation.titleChanged && '标题', observation.textChanged && '正文', observation.interactiveElementsChanged && '交互元素'].filter(Boolean) : [];
  return <article className={`explore-event status-${event.status}${latest ? ' latest' : ''}`}>
    <span className="explore-event-marker"><EventIcon aria-hidden="true" /></span>
    <div className="explore-event-body">
      <header><span>{event.step ? `第 ${event.step} 轮 · ` : ''}{EXPLORE_STAGE_LABEL[event.stage]}</span><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time></header>
      <h4>{event.title}</h4>
      {event.message && !response ? <p className="explore-event-message">{event.message}</p> : null}
      {event.action ? <div className="explore-action"><span>{event.stage === 'decision' ? 'AI 计划' : '目标操作'}</span><code>{event.action.label}</code>{event.action.reason ? <p>{event.action.reason}</p> : null}</div> : null}
      {response ? <div className="explore-response">
        <div className="explore-response-head"><strong>浏览器真实响应</strong><span className={response.ok ? response.confirmed ? 'confirmed' : 'unconfirmed' : 'failed'}>{response.ok ? response.confirmed ? '结果已确认' : '已派发 · 未确认' : '执行失败'}</span></div>
        <p>{response.message}{response.openedNewTab ? '；已接管新标签页，后续操作将在新页继续' : ''}</p>
        {changes.length ? <small>检测到变化：{changes.join('、')}</small> : <small>未检测到页面状态变化</small>}
        {response.evidence ? <details><summary>查看执行证据</summary><pre>{JSON.stringify(response.evidence, null, 2)}</pre></details> : null}
      </div> : null}
      {event.url ? <small className="explore-event-url">{event.url}</small> : null}
    </div>
  </article>;
}

function ExploreDialog({ siteId, siteUrl, runtime, onClose, onGenerated, notify }: { siteId: string; siteUrl: string; runtime: RuntimeState; onClose: () => void; onGenerated: (id: string) => void; notify: (text: string, error?: boolean) => void }) {
  const [url, setUrl] = useState(siteUrl || 'https://');
  const [goal, setGoal] = useState('');
  const [keywords, setKeywords] = useState('');
  // 每次打开弹窗都先停留在配置阶段。旧进度即使仍残留在 storage，也不能
  // 替用户触发探索；确有在途探索时只给出显式的“查看当前进度”入口。
  const [started, setStarted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const timeline = useRef<HTMLDivElement>(null);
  const existingActive = !started && runtime.state === 'exploring' && Boolean(runtime.explorationProgress) && !runtime.explorationResult;
  const progress = started ? runtime.explorationProgress : null;
  const result = started ? runtime.explorationResult : null;
  const events = progress?.events || [];
  const running = started && !result;
  const percentage = result ? 100 : progress?.total ? Math.min(100, Math.round((progress.step / progress.total) * 100)) : 0;

  useEffect(() => {
    if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [events.length]);
  useEffect(() => {
    if (started && result) { setStopping(false); notify(result.ok ? 'AI 探索完成，技能已加入技能库' : result.message || 'AI 探索失败', !result.ok); }
  }, [result, started, notify]);

  const start = async () => {
    if (!/^https?:\/\//i.test(url) || !goal.trim()) return notify('请填写有效网址和探索目标', true);
    try {
      setStopping(false);
      await send({ type: MSG.EXPLORE_GENERATE, siteId, url, goal: goal.trim(), successKws: keywords.split(/[,，]/).map((v) => v.trim()).filter(Boolean) });
      setStarted(true);
    } catch (error) { notify(errorText(error), true); }
  };
  const stop = async () => {
    setStopping(true);
    try { await send({ type: MSG.EXPLORE_ABORT }); notify('正在停止探索，等待当前页面操作结束'); }
    catch (error) { setStopping(false); notify(errorText(error), true); }
  };

  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="modal explore-modal">
    <div className="section-head explore-modal-head"><div><p className="eyebrow">AI explorer</p><h2>探索页面并生成技能</h2><p>AI 的决策与浏览器返回的事实会分开显示，只有经过页面状态验证的操作才标记为“结果已确认”。</p></div><button className="close-button" onClick={onClose}>×</button></div>
    <div className="explore-layout">
      <div className="form-stack explore-setup">
        <Field label="目标网址"><input value={url} onChange={(e) => setUrl(e.target.value)} disabled={running} /></Field>
        <Field label="目标描述"><textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例如：点击签到并确认成功" disabled={running} /></Field>
        <Field label="成功关键词"><input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="执行成功, 已签到" disabled={running} /></Field>
        {existingActive ? <div className="explore-existing"><span className="explore-live-dot active" /><div><strong>检测到一个正在执行的探索</strong><p>当前表单不会自动提交。你可以先查看已有探索，或等待其结束后再开始新的探索。</p></div></div> : null}
        <div className="explore-explainer"><Eye aria-hidden="true" /><div><strong>如何判断操作成功</strong><p>点击事件派发成功并不等于业务完成。探索器会重新读取 URL、标题、正文和交互元素，将真实变化作为下一轮依据。</p></div></div>
      </div>
      <section className="explore-process">
        <div className="explore-process-head"><div><span className={`explore-live-dot${running ? ' active' : ''}`} /><div><strong>{result ? result.ok ? '技能生成完成' : '探索未完成' : running ? progress?.message || '正在初始化探索…' : '等待开始探索'}</strong><small>{running ? `第 ${progress?.step || 0} / ${progress?.total || 0} 轮` : result?.message || '执行过程将在这里实时显示'}</small></div></div><span>{percentage}%</span></div>
        <div className="explore-progress-track"><span style={{ width: `${percentage}%` }} /></div>
        <div className="explore-timeline" ref={timeline} role="log" aria-live="polite">
          {events.length ? events.map((event, index) => <ExploreTimelineItem key={event.id} event={event} latest={index === events.length - 1 && running} />) : <div className="explore-timeline-empty"><BrainCircuit aria-hidden="true" /><strong>尚无执行记录</strong><p>开始后将依次展示页面观察、AI 决策、操作执行和浏览器真实响应。</p></div>}
        </div>
        {result ? <div className={result.ok ? 'explore-result success' : 'explore-result error'}><span>{result.ok ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}</span><div><strong>{result.ok ? `已生成技能 · ${result.steps || 0} 个步骤` : '本次探索未生成可用技能'}</strong><p>{result.message}</p></div></div> : null}
      </section>
    </div>
    <div className="form-actions explore-footer"><button className="button" onClick={onClose}>关闭</button><span className="grow" />{running ? <button className="button danger" onClick={stop} disabled={stopping}>{stopping ? '正在停止…' : '停止探索'}</button> : existingActive ? <button className="button primary" onClick={() => setStarted(true)}>查看当前执行过程</button> : result?.ok && result.procId ? <button className="button primary" onClick={() => onGenerated(result.procId!)}>查看生成的技能</button> : <button className="button accent" onClick={start}>开始探索</button>}</div>
  </section></div>;
}

function RecordDialog({ siteId, siteUrl, runtime, onClose, notify }: { siteId: string; siteUrl: string; runtime: RuntimeState; onClose: () => void; notify: (text: string, error?: boolean) => void }) {
  const [url, setUrl] = useState(siteUrl || 'https://');
  const [name, setName] = useState('录制生成技能');
  const [keywords, setKeywords] = useState('');
  const [started, setStarted] = useState(runtime.state === 'recording');
  const [saving, setSaving] = useState(false);
  const steps = Array.isArray(runtime.recordingSteps) ? runtime.recordingSteps as RecordingPreview[] : [];
  const pending = Boolean(runtime.recordingResult?.pending);
  const start = async () => {
    if (!/^https?:\/\//i.test(url)) return notify('请填写有效的 http(s) 地址', true);
    try { await send({ type: MSG.RECORD_START, url }); setStarted(true); notify('录制已开始，请在新打开的页面中操作'); }
    catch (error) { notify(errorText(error), true); }
  };
  const stop = async () => {
    setSaving(true);
    try {
      const response = await send<{ procId: string; steps: number }>({ type: MSG.RECORD_STOP, siteId, url, name: name.trim(), successKws: keywords.split(/[,，]/).map((item) => item.trim()).filter(Boolean) });
      notify(`已生成技能，共 ${response.steps} 个步骤`); setStarted(false); onClose();
    } catch (error) { notify(errorText(error), true); }
    finally { setSaving(false); }
  };
  const close = async () => {
    if ((started || pending || steps.length) && !confirm('关闭会丢弃本次未保存的录制，确定吗？')) return;
    if (started || pending || steps.length) await send({ type: MSG.RECORD_DISCARD }).catch(() => null);
    onClose();
  };
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="modal"><div className="section-head"><div><p className="eyebrow">Demonstration recorder</p><h2>录制操作并生成技能</h2></div><button className="close-button" onClick={close}>×</button></div><div className="form-stack"><div className="form-grid two"><Field label="目标网址"><input value={url} onChange={(event) => setUrl(event.target.value)} disabled={started} /></Field><Field label="技能名称"><input value={name} onChange={(event) => setName(event.target.value)} /></Field></div><Field label="成功关键词"><input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="执行成功, 已完成" /></Field><div className="record-head"><strong>{started ? '正在录制' : pending ? '录制已中断，步骤待保存' : '录制步骤'} · {steps.length}</strong><small>点击、输入等操作会实时回流到这里</small></div><div className="record-list">{steps.map((step) => <div className="record-item" key={`${step.index}-${step.type}`}><span>{step.index + 1}</span><strong>{step.type}</strong><p>{step.label}</p><button type="button" onClick={() => send({ type: MSG.RECORD_STEP_REMOVE, index: step.index }).catch((error) => notify(errorText(error), true))}>×</button></div>)}{!steps.length ? <div className="empty compact">开始后，请切到目标页面进行操作</div> : null}</div><div className="form-actions"><button className="button" onClick={close}>关闭</button><span className="grow" />{started || pending ? <button className="button primary" disabled={saving || !steps.length} onClick={stop}>{saving ? '保存中…' : '停止并保存'}</button> : <button className="button accent" onClick={start}>开始录制</button>}</div></div></section></div>;
}

function MarketPanel({ sites, procedures, notify }: { sites: Site[]; procedures: Procedure[]; notify: (text: string, error?: boolean) => void }) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await send<{ index: { items?: MarketItem[] } }>({ type: MSG.MARKET_INDEX });
      setItems(Array.isArray(response.index?.items) ? response.index.items : []);
    } catch (error) { notify(errorText(error), true); }
    finally { setLoading(false); }
  }, [notify]);
  useEffect(() => { void refresh(); }, [refresh]);
  const visible = items.filter((item) => (!kind || item.kind === kind) && `${item.name} ${item.description || ''} ${item.author || ''}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (!sites.some((site) => site.id === siteId)) setSiteId(sites[0]?.id || ''); }, [siteId, sites]);
  const installed = (item: MarketItem) => procedures.find((procedure) => procedure.marketId === item.marketId && procedure.siteId === siteId);
  const install = async (item: MarketItem) => {
    setInstalling(item.marketId);
    try {
      const response = await send<{ procedure: Procedure; upgraded: boolean }>({ type: MSG.MARKET_INSTALL, marketId: item.marketId, siteId });
      notify(response.upgraded ? `已升级“${response.procedure.name}”` : `已安装“${response.procedure.name}”`);
    } catch (error) { notify(errorText(error), true); }
    finally { setInstalling(''); }
  };
  return <div className="stack gap-lg"><section className="panel toolbar-panel"><div><p className="eyebrow">Community library</p><h2>技能市场</h2><p className="section-description">先选择网站，市场技能会安装到当前网站下。</p></div><div className="toolbar"><select value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">选择网站</option>{sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}</select><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option><option value="checkin">自动化技能</option><option value="login">登录技能</option><option value="verification">验证技能</option></select><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、作者" /><button className="button" onClick={refresh} disabled={loading}>{loading ? '刷新中…' : '刷新市场'}</button></div></section><section className="card-grid">{visible.map((item) => { const local = installed(item); const update = Boolean(local && item.version && compareVersions(item.version, local.version) > 0); return <article className="entity-card" key={`${item.marketId}-${siteId}`}><div><span className={`badge ${item.kind === 'checkin' ? 'tone-info' : 'tone-muted'}`}>{PROCEDURE_KIND_LABEL[item.kind]}</span><h3>{item.name}</h3><p>{item.description || '暂无说明'}</p></div><small>{item.author ? `作者 ${item.author} · ` : ''}版本 {item.version || '1.0.0'}</small><div className="form-actions">{item.homepage ? <button className="button ghost small" onClick={() => window.open(item.homepage, '_blank')}>主页</button> : null}<span className="grow" /><button className={local ? 'button small' : 'button primary small'} disabled={!siteId || installing === item.marketId || Boolean(local && !update)} onClick={() => install(item)}>{installing === item.marketId ? '处理中…' : !local ? '安装到当前网站' : update ? '升级' : '已安装'}</button></div></article>; })}{!visible.length ? <div className="empty wide">{loading ? '正在读取市场目录…' : !siteId ? '请先选择网站' : '没有匹配的市场技能'}</div> : null}</section></div>;
}

function FlowsPanel({ flows, notify }: { flows: Flow[]; notify: (text: string, error?: boolean) => void }) {
  const [name, setName] = useState('');
  const create = async () => {
    try { const flow = createFlow({ name: name.trim() || '新流程' }); const result = await send<{ flow: Flow }>({ type: MSG.FLOW_SAVE, flow }); setName(''); notify('流程已创建'); openCanvas(result.flow.id); }
    catch (error) { notify(errorText(error), true); }
  };
  const remove = async (flow: Flow) => { if (!confirm(`删除流程“${flow.name}”？`)) return; try { await send({ type: MSG.FLOW_DELETE, id: flow.id }); notify('流程已删除'); } catch (error) { notify(errorText(error), true); } };
  const openCanvas = (id: string, autorun = false) => window.open(chrome.runtime.getURL(`canvas.html?flowId=${encodeURIComponent(id)}${autorun ? '&autorun=1' : ''}`), '_blank');
  return <div className="stack gap-lg"><section className="panel toolbar-panel"><div><p className="eyebrow">React Flow canvas</p><h2>流程管理</h2></div><div className="toolbar"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="新流程名称" /><button className="button primary" onClick={create}>创建并打开</button></div></section><section className="card-grid">{flows.map((flow) => <article className="entity-card" key={flow.id}><div><span className="badge tone-info">{flow.nodes.length} 节点</span><h3>{flow.name}</h3><p>{flow.description || '使用画布编排技能、站点与条件分支。'}</p></div><small>更新于 {formatTime(flow.updatedAt)}</small><div className="form-actions"><button className="button danger ghost small" onClick={() => remove(flow)}>删除</button><span className="grow" /><button className="button small" onClick={() => openCanvas(flow.id, true)}>运行</button><button className="button primary small" onClick={() => openCanvas(flow.id)}>编辑画布</button></div></article>)}{!flows.length ? <div className="empty wide">还没有流程，创建后会在新的 React Flow 画布中打开。</div> : null}</section></div>;
}

function LogsPanel({ logs, tasks, notify }: { logs: Log[]; tasks: Task[]; notify: (text: string, error?: boolean) => void }) {
  const [status, setStatus] = useState('');
  const filtered = status ? logs.filter((item) => item.status === status) : logs;
  const clear = async () => { if (!confirm('清空全部执行日志？')) return; try { await chrome.storage.local.set({ logs: [], tasks: [] }); notify('日志已清空'); } catch (error) { notify(errorText(error), true); } };
  return <div className="stack gap-lg"><section className="metric-grid"><Metric label="执行批次" value={tasks.length} onClick={() => setStatus('')} /><Metric label="执行记录" value={logs.length} onClick={() => setStatus('')} /><Metric label="成功" value={logs.filter((l) => l.status === 'success').length} onClick={() => setStatus('success')} /><Metric label="失败/需处理" value={logs.filter((l) => !['success', 'skipped'].includes(l.status)).length} onClick={() => setStatus('failed')} /></section><section className="panel"><div className="section-head"><div><p className="eyebrow">Execution history</p><h2>自动化日志</h2></div><div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="button danger ghost" onClick={clear}>清空日志</button></div></div><div className="table-wrap"><table><thead><tr><th>状态</th><th>站点</th><th>消息</th><th>耗时</th><th>时间</th></tr></thead><tbody>{filtered.map((log) => <tr key={log.id}><td><span className={`badge ${statusClass(log.status)}`}>{STATUS_LABEL[log.status]}</span></td><td>{log.siteName}</td><td>{log.message}</td><td>{Math.max(0, log.finishedAt - log.startedAt)} ms</td><td>{formatTime(log.finishedAt)}</td></tr>)}</tbody></table>{!filtered.length ? <div className="empty compact">暂无匹配日志</div> : null}</div>{tasks.slice(0, 5).length ? <div className="task-strip">{tasks.slice(0, 5).map((task) => <div key={task.id}><strong>{TASK_TRIGGER_LABEL[task.trigger]}</strong><small>{task.success} 成功 · {task.failed} 失败 · {formatTime(task.startedAt)}</small></div>)}</div> : null}</section></div>;
}

function SettingsPanel({ settings, applySettings, notify }: { settings: Settings; applySettings: (settings: Settings) => void; notify: (text: string, error?: boolean) => void }) {
  const [draft, setDraft] = useState(settings); const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(settings); }, [settings, dirty]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => { setDraft((current) => ({ ...current, [key]: value })); setDirty(true); };
  const saveSettings = useCallback(async (silent = false) => {
    const clean: Settings = { ...draft, llmApiKey: draft.llmApiKey.trim(), llmModel: draft.llmModel.trim(), llmBaseUrl: draft.llmBaseUrl.trim(), llmHeaders: draft.llmHeaders.trim() };
    await chrome.storage.local.set({ settings: clean });
    await send({ type: MSG.RESCHEDULE }).catch(() => null);
    applySettings(clean); setDraft(clean); setDirty(false); if (!silent) notify('设置已保存，所有 AI 入口已立即同步');
    return clean;
  }, [applySettings, draft, notify]);
  return <form className="stack gap-lg" onSubmit={(e) => { e.preventDefault(); void saveSettings().catch((error) => notify(errorText(error), true)); }}><section className="panel form-stack"><div className="section-head"><div><p className="eyebrow">Global</p><h2>运行设置</h2></div><span className={dirty ? 'badge tone-info' : 'badge tone-success'}>{dirty ? '有未保存更改' : '已同步'}</span></div><div className="form-grid three"><NumberField label="站点间隔（ms）" value={draft.siteGapMs} onChange={(v) => update('siteGapMs', v)} /><NumberField label="默认防护等待（ms）" value={draft.defaultCfTimeoutMs} onChange={(v) => update('defaultCfTimeoutMs', v)} /><NumberField label="页面加载超时（ms）" value={draft.defaultPageLoadTimeoutMs} onChange={(v) => update('defaultPageLoadTimeoutMs', v)} /><NumberField label="人工验证宽限（ms）" value={draft.cfManualGraceMs} onChange={(v) => update('cfManualGraceMs', v)} /><NumberField label="最多保留日志" value={draft.maxLogs} onChange={(v) => update('maxLogs', v)} /><Field label="技能市场源"><input value={draft.marketUrl} onChange={(e) => update('marketUrl', e.target.value)} /></Field></div><div className="inline-options"><label><input type="checkbox" checked={draft.notifyOnComplete} onChange={(e) => update('notifyOnComplete', e.target.checked)} /> 完成时通知</label><label><input type="checkbox" checked={draft.notifyOnError} onChange={(e) => update('notifyOnError', e.target.checked)} /> 异常时通知</label><label><input type="checkbox" checked={draft.openInBackground} onChange={(e) => update('openInBackground', e.target.checked)} /> 默认后台打开</label></div></section><AiSettings draft={draft} update={update} saveSettings={saveSettings} notify={notify} /><section className="panel"><div className="form-actions"><span className="grow" /><button className="button primary" type="submit">保存全部设置</button></div></section></form>;
}

function DataTransferPanel({ notify }: { notify: (text: string, error?: boolean) => void }) {
  type ImportPayload = Parameters<typeof importSites>[0];
  type ImportPreview = { file: File; payload: ImportPayload; sites: number; procedures: number; flows: number; logs: number; tasks: number; hasSettings: boolean };

  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [replace, setReplace] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const chooseFile = async (file: File | null) => {
    if (!file) { setPreview(null); return; }
    if (file.size > 20 * 1024 * 1024) return notify('备份文件不能超过 20 MB', true);
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      if (!Array.isArray(raw) && (!raw || typeof raw !== 'object' || !Array.isArray((raw as { sites?: unknown }).sites))) {
        throw new Error('文件中缺少 sites 数组，不是有效的 auto-page 备份');
      }
      const payload = raw as ImportPayload;
      const objectPayload = Array.isArray(payload) ? null : payload;
      setPreview({
        file,
        payload,
        sites: Array.isArray(payload) ? payload.length : payload.sites?.length || 0,
        procedures: objectPayload?.procedures?.length || 0,
        flows: objectPayload?.flows?.length || 0,
        logs: objectPayload?.logs?.length || 0,
        tasks: objectPayload?.tasks?.length || 0,
        hasSettings: Boolean(objectPayload?.settings),
      });
    } catch (error) {
      setPreview(null);
      if (fileInput.current) fileInput.current.value = '';
      notify(`无法读取备份：${errorText(error)}`, true);
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const data = await exportAll();
      const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `auto-page-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      notify(`备份已导出：${data.sites.length} 个站点、${data.procedures.length} 个技能、${data.flows.length} 个流程`);
    } catch (error) { notify(errorText(error), true); }
    finally { setExporting(false); }
  };
  const importData = async () => {
    if (!preview) return notify('请先选择有效的 JSON 备份文件', true);
    if (replace && !confirm('替换模式会使用备份内容替换对应的现有数据。未包含在备份中的数据类型不会被清空，是否继续？')) return;
    setImporting(true);
    try {
      await importSites(preview.payload, { merge: !replace });
      await send({ type: MSG.RESCHEDULE }).catch(() => null);
      setPreview(null);
      if (fileInput.current) fileInput.current.value = '';
      notify(replace ? '备份已恢复，已替换备份中包含的数据' : '备份已合并，界面数据已同步更新');
    } catch (error) { notify(`导入失败：${errorText(error)}`, true); }
    finally { setImporting(false); }
  };
  return <div className="stack gap-lg transfer-page">
    <section className="panel transfer-hero">
      <div><p className="eyebrow">Backup &amp; migration</p><h2>备份、迁移或恢复工作区</h2><p>使用一个 JSON 文件保存站点、技能、流程、设置与执行记录，也兼容旧版站点备份。</p></div>
      <span className="badge tone-info">备份格式 v2</span>
    </section>
    <div className="transfer-grid">
      <section className="panel transfer-card">
        <div className="transfer-card-head"><span className="transfer-icon"><Download aria-hidden="true" /></span><div><p className="eyebrow">Export</p><h2>导出当前数据</h2></div></div>
        <p className="transfer-description">生成可读的 JSON 备份，适合迁移到其他浏览器，或在修改技能和流程前留存快照。</p>
        <ul className="transfer-features"><li>全部站点、技能与画布流程</li><li>运行设置、AI 设置和技能市场源</li><li>执行日志与批次记录</li></ul>
        <div className="transfer-card-actions"><span className="transfer-file-hint">文件名按当天日期自动生成</span><button type="button" className="button primary" onClick={exportData} disabled={exporting}><Download aria-hidden="true" />{exporting ? '正在导出…' : '导出完整备份'}</button></div>
      </section>
      <section className="panel transfer-card">
        <div className="transfer-card-head"><span className="transfer-icon"><Upload aria-hidden="true" /></span><div><p className="eyebrow">Import</p><h2>从备份恢复</h2></div></div>
        <label className={preview ? 'file-drop has-file' : 'file-drop'} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void chooseFile(event.dataTransfer.files[0] || null); }}>
          <input ref={fileInput} className="file-input-hidden" type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event.target.files?.[0] || null)} />
          <FileJson2 aria-hidden="true" />
          <span><strong>{preview ? preview.file.name : '选择或拖入 JSON 备份'}</strong><small>{preview ? `${(preview.file.size / 1024).toFixed(1)} KB · 文件校验通过` : '支持新版完整备份与旧版站点数组，最大 20 MB'}</small></span>
        </label>
        {preview ? <div className="transfer-summary"><span>{preview.sites} 站点</span><span>{preview.procedures} 技能</span><span>{preview.flows} 流程</span><span>{preview.logs} 日志</span><span>{preview.tasks} 批次</span>{preview.hasSettings ? <span>包含设置</span> : null}</div> : null}
        <label className="switch transfer-mode"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /><span><strong>替换备份中包含的数据</strong><small>关闭时按 ID 合并，适合把另一台设备的数据加入当前工作区</small></span></label>
        <div className="transfer-card-actions"><span className="transfer-file-hint">导入成功后页面会自动刷新状态</span><button type="button" className="button primary" onClick={importData} disabled={!preview || importing}><Upload aria-hidden="true" />{importing ? '正在导入…' : '导入并恢复'}</button></div>
      </section>
    </div>
    <section className="panel transfer-security"><ShieldCheck aria-hidden="true" /><div><strong>备份文件仅在本机处理</strong><p>完整备份包含已保存的 AI API Key。请像保管密码一样保管该文件，不要上传到公共仓库或发送给无关人员。</p></div></section>
  </div>;
}

function AiSettings({ draft, update, saveSettings, notify }: { draft: Settings; update: <K extends keyof Settings>(key: K, value: Settings[K]) => void; saveSettings: (silent?: boolean) => Promise<Settings>; notify: (text: string, error?: boolean) => void }) {
  const [models, setModels] = useState<string[]>([]); const [fetching, setFetching] = useState(false); const [testing, setTesting] = useState(false); const [testPrompt, setTestPrompt] = useState('请只回复：连接成功');
  const fetchModels = async () => {
    if (!draft.llmApiKey.trim()) return notify('请先填写 API Key（无需先保存）', true);
    setFetching(true);
    try { const result = await send<{ models: string[] }>({ type: MSG.LLM_MODELS, config: { provider: draft.llmProvider, apiKey: draft.llmApiKey.trim(), baseUrl: draft.llmBaseUrl.trim(), model: draft.llmModel.trim(), headers: draft.llmHeaders.trim() } }); const unique = [...new Set((result.models || []).map(String).filter(Boolean))]; setModels(unique); notify(unique.length ? `已获取 ${unique.length} 个模型` : '接口没有返回模型，可继续手动输入'); }
    catch (error) { notify(`获取模型失败：${errorText(error)}`, true); } finally { setFetching(false); }
  };
  const test = async () => { setTesting(true); try { await saveSettings(true); const result = await send<{ message?: string }>({ type: MSG.LLM_TEST, prompt: testPrompt.trim() }); notify(result.message || '连接测试成功'); } catch (error) { notify(`连接测试失败：${errorText(error)}`, true); } finally { setTesting(false); } };
  return <section className="panel form-stack"><div className="section-head"><div><p className="eyebrow">Artificial intelligence</p><h2>AI 设置</h2></div><span className="privacy-note">API Key 仅保存在本机</span></div><div className="form-grid two"><Field label="Provider"><select value={draft.llmProvider} onChange={(e) => update('llmProvider', e.target.value as Settings['llmProvider'])}><option value="anthropic">Anthropic</option><option value="openai">OpenAI 兼容</option></select></Field><Field label="Base URL（留空使用官方地址）"><input value={draft.llmBaseUrl} onChange={(e) => update('llmBaseUrl', e.target.value)} placeholder={draft.llmProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'} /></Field></div><Field label="API Key"><input type="password" autoComplete="off" value={draft.llmApiKey} onChange={(e) => update('llmApiKey', e.target.value)} placeholder="sk-…" /></Field><div className="model-row"><Field label="模型（可输入，也可展开选择）"><ModelCombobox value={draft.llmModel} models={models} onChange={(value) => update('llmModel', value)} /></Field><button type="button" className="button" onClick={fetchModels} disabled={fetching}>{fetching ? '获取中…' : '获取模型'}</button></div><Field label="自定义请求头（每行 Key: Value）"><textarea rows={4} value={draft.llmHeaders} onChange={(e) => update('llmHeaders', e.target.value)} placeholder={'X-Custom: value\nAuthorization: Bearer {{apiKey}}'} /></Field><div className="form-grid three"><NumberField label="AI 对话最大步骤" value={draft.agentMaxSteps} onChange={(v) => update('agentMaxSteps', v)} /><NumberField label="AI 对话超时（ms）" value={draft.agentTimeoutMs} onChange={(v) => update('agentTimeoutMs', v)} /><Field label="测试消息"><input value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} /></Field></div><div className="form-actions"><span className="grow" /><button type="button" className="button accent" onClick={test} disabled={testing}>{testing ? '测试中…' : '保存并测试连接'}</button></div></section>;
}

function ModelCombobox({ value, models, onChange }: { value: string; models: string[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false); const [active, setActive] = useState(-1); const [showAll, setShowAll] = useState(true); const root = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => { const q = value.trim().toLowerCase(); return (showAll || !q ? models : models.filter((item) => item.toLowerCase().includes(q))).slice(0, 200); }, [models, showAll, value]);
  useEffect(() => { if (models.length) { setShowAll(true); setOpen(true); setActive(-1); } }, [models]);
  useEffect(() => { const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, []);
  const select = (model: string) => { onChange(model); setOpen(false); setShowAll(true); setActive(-1); };
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') return setOpen(false);
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    if (!open) { setShowAll(true); setOpen(true); if (event.key !== 'Enter') event.preventDefault(); return; }
    if (event.key === 'Enter') { if (active >= 0 && filtered[active]) { event.preventDefault(); select(filtered[active]!); } return; }
    event.preventDefault(); setActive((current) => Math.max(0, Math.min(filtered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
  };
  return <div className="combobox" ref={root}><div className="combobox-input"><input role="combobox" aria-expanded={open} aria-controls="model-options" value={value} onChange={(e) => { onChange(e.target.value); setShowAll(false); setOpen(Boolean(models.length)); setActive(-1); }} onClick={() => { if (models.length) { setShowAll(true); setOpen(true); } }} onKeyDown={keydown} placeholder="输入模型 ID" /><button type="button" aria-label="展开模型列表" onClick={() => { if (models.length) { setShowAll(true); setOpen((current) => !current); } }}>⌄</button></div>{open ? <div id="model-options" className="combobox-menu" role="listbox">{filtered.length ? filtered.map((model, index) => <button type="button" role="option" aria-selected={value === model} className={index === active ? 'active' : ''} key={model} onPointerDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(model)}>{model}</button>) : <div className="combobox-empty">没有匹配模型，可继续手动输入</div>}</div> : null}</div>;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>; }
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <Field label={label}><input type="number" min="0" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} /></Field>; }
