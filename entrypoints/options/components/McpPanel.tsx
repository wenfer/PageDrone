import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { MSG } from '../../../src/lib/messaging.js';
import type { McpAuditEntry, McpConfig, McpPendingConfirm, McpSessionState } from '../../../src/lib/types.js';

type ServiceResponse<T = Record<string, unknown>> = T & { ok: boolean; error?: string };

interface McpStatePayload {
  config: McpConfig;
  session: McpSessionState;
  pendingConfirms: McpPendingConfirm[];
  audits: McpAuditEntry[];
}

const MODE_LABEL: Record<McpConfig['mode'], string> = {
  readonly: '只读（默认）',
  standard: '标准',
  full: '完全',
};

async function send<T>(message: object): Promise<ServiceResponse<T>> {
  const response = await chrome.runtime.sendMessage(message) as ServiceResponse<T> | undefined;
  if (!response) throw new Error('扩展后台没有响应，请重新加载扩展');
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response;
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

/** MCP 服务管理面板：总开关 / 配对令牌 / 三级授权 / 域名白名单 / 用户确认 / 审计日志 */
export function McpPanel({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [state, setState] = useState<McpStatePayload | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [rememberDecisions, setRememberDecisions] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const payload = await send<McpStatePayload>({ type: MSG.MCP_GET_STATE });
      setState(payload);
      setBridgeUrl((current) => (current === '' ? payload.config.bridgeUrl : current));
    } catch (error) {
      notify(`读取 MCP 状态失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);

  // storage 变化实时同步：连接状态、待确认请求与审计日志都由 SW 落盘后回流
  useEffect(() => {
    const listener = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      void refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  const update = async (patch: Record<string, unknown>, action?: 'reconnect' | 'disconnect', successText?: string) => {
    setSaving(true);
    try {
      const payload = await send<{ config: McpConfig; session: McpSessionState }>({
        type: MSG.MCP_SET_CONFIG,
        ...patch,
        ...(action ? { action } : {}),
      });
      setState((current) => (current ? { ...current, config: payload.config, session: payload.session } : current));
      if (successText) notify(successText);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setSaving(false);
    }
  };

  if (!state) return <div className="empty">正在读取 MCP 服务状态…</div>;
  const { config, session, pendingConfirms, audits } = state;

  const resolveConfirm = async (confirmId: string, approve: boolean) => {
    try {
      await send({ type: MSG.MCP_RESOLVE_CONFIRM, confirmId, approve, remember: rememberDecisions });
      notify(approve ? '已允许该请求' : '已拒绝该请求');
      void refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  };

  const exportAudit = () => {
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(audits, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `mcp-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };

  return (
    <div className="stack gap-lg">
      {/* —— 开关与连接状态 —— */}
      <section className="panel form-stack">
        <div className="section-head">
          <div>
            <p className="eyebrow">Model Context Protocol</p>
            <h2>MCP 服务</h2>
            <p className="section-description">让外部 AI Agent（Claude Desktop、Cursor 等）通过本地桥接进程操控本扩展。默认关闭。</p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={saving}
              onChange={(e) => void update({ enabled: e.target.checked }, undefined, e.target.checked ? 'MCP 服务已开启' : 'MCP 服务已关闭')}
            />
            <span>{config.enabled ? '已开启' : '已关闭'}</span>
          </label>
        </div>
        <div className={`site-login-alert${session.connected ? '' : ' muted'}`}>
          <div className="site-login-alert-copy">
            <span className={`badge ${session.connected ? 'badge-success tone-success' : 'badge-ghost tone-muted'}`}>
              {config.enabled ? (session.connected ? '已连接' : '未连接 · 自动重连中') : '服务未开启'}
            </span>
            <div>
              <strong>{session.connected ? `客户端：${session.clientLabel || 'bridge'}` : session.lastError || '等待桥接进程接入'}</strong>
              <small>
                最近连接 {formatTime(session.lastConnectedAt)} · 最近断开 {formatTime(session.lastDisconnectedAt)}
                {session.reconnectAttempts ? ` · 重连次数 ${session.reconnectAttempts}` : ''}
              </small>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="button ghost small" disabled={!config.enabled || saving} onClick={() => void update({}, 'reconnect', '已尝试重新连接')}>
              <RefreshCw aria-hidden="true" /> 立即重连
            </button>
            <button type="button" className="button danger ghost small" disabled={!session.connected || saving} onClick={() => void update({}, 'disconnect', '已断开当前会话')}>
              断开会话
            </button>
          </div>
        </div>

        <div className="form-grid two">
          <label className="field">
            <span>桥接地址（仅允许本机回环或下方已确认主机）</span>
            <input value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} placeholder="ws://127.0.0.1:9377" />
          </label>
          <label className="field">
            <span>配对令牌</span>
            <div className="toolbar">
              <input readOnly value={config.token || '开启开关后自动生成'} />
              <button type="button" className="button small" onClick={() => void navigator.clipboard.writeText(config.token).then(() => notify('令牌已复制'))}>复制</button>
              <button type="button" className="button small" disabled={saving} onClick={() => void update({ rotateToken: true }, 'reconnect', '已轮换配对令牌，旧令牌立即失效')}>重新生成</button>
            </div>
          </label>
        </div>
        <div className="form-actions">
          <span />
          <span className="grow" />
          <button type="button" className="button primary small" disabled={bridgeUrl.trim() === config.bridgeUrl || saving} onClick={() => void update({ bridgeUrl: bridgeUrl.trim() }, 'reconnect', '桥接地址已保存并重连')}>
            保存桥接地址
          </button>
        </div>
      </section>

      {/* —— 授权模式 —— */}
      <section className="panel form-stack">
        <div className="section-head"><div><p className="eyebrow">Authorization</p><h2>授权模式</h2></div></div>
        <div className="form-grid three">
          {(Object.keys(MODE_LABEL) as Array<McpConfig['mode']>).map((mode) => (
            <button key={mode} type="button" className={config.mode === mode ? 'list-button active' : 'list-button'} disabled={saving} onClick={() => void update({ mode }, undefined, `已切换为「${MODE_LABEL[mode]}」`)}>
              <span><strong>{MODE_LABEL[mode]}</strong><small>{
                mode === 'readonly'
                  ? '仅放行只读工具，最安全'
                  : mode === 'standard'
                    ? '放行只读 + 执行 + 浏览器；写入工具需逐次确认'
                    : '全部工具免确认——仅供完全信任本机环境时开启'
              }</small></span>
              {mode === 'full' ? <span className="badge tone-error">高危</span> : null}
            </button>
          ))}
        </div>
        {config.mode === 'full' ? (
          <div className="transfer-security"><ShieldCheck aria-hidden="true" /><div><strong>完全模式已开启</strong><p>外部 Agent 可以不经确认地创建、修改站点、技能与流程配置。请确保你了解正在接入的客户端行为。</p></div></div>
        ) : null}

        {/* —— 域名白名单 / 黑名单 —— */}
        <div className="subsection-head"><div><h3>浏览器操作域名</h3><small>browser 组工具访问不属于任何已配置站点的新域名时需要你逐次确认；可在此预先放行，黑名单则始终硬拒。</small></div></div>
        <div className="toolbar">
          <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="example.com" />
          <button
            type="button"
            className="button small"
            disabled={!newDomain.trim() || saving}
            onClick={() => {
              const domain = newDomain.trim().toLowerCase();
              void update({ allowedDomains: [...config.allowedDomains, domain] }, undefined, `已放行 ${domain}`);
              setNewDomain('');
            }}
          >
            加入白名单
          </button>
          <button
            type="button"
            className="button danger ghost small"
            disabled={!newDomain.trim() || saving}
            onClick={() => {
              const domain = newDomain.trim().toLowerCase();
              void update({ blockedDomains: [...config.blockedDomains, domain] }, undefined, `已拉黑 ${domain}`);
              setNewDomain('');
            }}
          >
            加入黑名单
          </button>
        </div>
        <div className="form-grid two">
          <div className="card-grid site-skill-grid">
            {config.allowedDomains.map((domain) => (
              <article className="entity-card" key={domain}>
                <div><code>{domain}</code></div>
                <div className="form-actions"><span className="grow" /><button type="button" className="button ghost small" onClick={() => void update({ allowedDomains: config.allowedDomains.filter((item) => item !== domain) })}>移除</button></div>
              </article>
            ))}
            {!config.allowedDomains.length ? <div className="empty compact wide">白名单为空</div> : null}
          </div>
          <div className="card-grid site-skill-grid">
            {config.blockedDomains.map((domain) => (
              <article className="entity-card" key={domain}>
                <div><code>{domain}</code></div>
                <div className="form-actions"><span className="grow" /><button type="button" className="button ghost small" onClick={() => void update({ blockedDomains: config.blockedDomains.filter((item) => item !== domain) })}>移除</button></div>
              </article>
            ))}
            {!config.blockedDomains.length ? <div className="empty compact wide">黑名单为空</div> : null}
          </div>
        </div>
      </section>

      {/* —— 待用户确认的请求 —— */}
      <section className="panel form-stack">
        <div className="section-head">
          <div><p className="eyebrow">Confirmations</p><h2>待确认请求</h2></div>
          <label className="mini-check">
            <input type="checkbox" checked={rememberDecisions} onChange={(e) => setRememberDecisions(e.target.checked)} /> 本会话内记住决策
          </label>
        </div>
        {pendingConfirms.length ? (
          <div className="activity-list">
            {pendingConfirms.map((confirmItem) => (
              <div className="activity" key={confirmItem.id}>
                <span className={`badge ${confirmItem.kind === 'write' ? 'badge-warning tone-info' : 'tone-info'}`}>
                  {confirmItem.kind === 'write' ? '写入' : '新域名'}
                </span>
                <div>
                  <strong>{confirmItem.kind === 'write' ? `工具 ${confirmItem.target}` : confirmItem.target}</strong>
                  <small>{confirmItem.summary}</small>
                </div>
                <div className="form-actions">
                  <time>{formatTime(confirmItem.createdAt)}</time>
                  <button type="button" className="button primary small" onClick={() => void resolveConfirm(confirmItem.id, true)}>允许</button>
                  <button type="button" className="button danger ghost small" onClick={() => void resolveConfirm(confirmItem.id, false)}>拒绝</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty compact">没有待确认的外部请求</div>
        )}
      </section>

      {/* —— 审计日志 —— */}
      <section className="panel">
        <div className="section-head">
          <div><p className="eyebrow">Audit log</p><h2>MCP 审计日志</h2><p className="section-description">所有外部调用的工具、参数摘要与结果状态（最多保留 2000 条，敏感字段自动遮盖）。</p></div>
          <div className="toolbar">
            <button type="button" className="button small" disabled={!audits.length} onClick={exportAudit}>导出 JSON</button>
            <button
              type="button"
              className="button danger ghost small"
              disabled={!audits.length}
              onClick={async () => {
                try {
                  await send({ type: MSG.MCP_CLEAR_AUDIT });
                  notify('审计日志已清空');
                  void refresh();
                } catch (error) {
                  notify(error instanceof Error ? error.message : String(error), true);
                }
              }}
            >
              清空
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>结果</th><th>工具</th><th>来源</th><th>参数摘要</th></tr></thead>
            <tbody>
              {audits.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatTime(entry.at)}</td>
                  <td><span className={`badge ${entry.status === 'ok' ? 'badge-success tone-success' : entry.status === 'denied' ? 'badge-warning tone-info' : 'badge-error tone-error'}`}>{entry.status === 'ok' ? '成功' : entry.status === 'denied' ? '已拒绝' : '失败'}{entry.code ? ` · ${entry.code}` : ''}</span></td>
                  <td><code>{entry.tool}</code></td>
                  <td>{entry.client || '—'}</td>
                  <td><code style={{ wordBreak: 'break-all' }}>{entry.summary}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!audits.length ? <div className="empty compact">暂无审计记录</div> : null}
        </div>
      </section>
    </div>
  );
}
