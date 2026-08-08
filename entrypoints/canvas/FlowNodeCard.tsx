import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { typeMeta } from './flow-model';
import { useCanvasResources } from './resources';
import type { CanvasNode, FlowNodeData } from './types';

function Summary({ type, data }: { type: string; data: FlowNodeData }) {
  const { procedures, sites } = useCanvasResources();
  const row = (key: string, value: unknown) => (
    <div className="node-summary-row">
      <span>{key}</span>
      <strong>{String(value ?? '')}</strong>
    </div>
  );

  switch (type) {
    case 'start': return <em>流程入口</em>;
    case 'end': return <em>流程出口</em>;
    case 'parallel': return <em>所有分支同时执行</em>;
    case 'condition': return data.expr ? row('if', data.expr) : <em>未设置条件</em>;
    case 'loop': return <>{row('次数', data.count ?? '?')}{data.loopVar ? row('变量', data.loopVar) : null}</>;
    case 'delay': return row('等待', `${data.ms ?? 1000} ms`);
    case 'variable': return data.name ? row(data.name, data.value) : <em>未设置变量</em>;
    case 'log': return row('日志', data.message || '(空)');
    case 'request':
    case 'http': return <>{row('请求', `${data.method || 'GET'} ${data.url || '(未设置)'}`)}{row('变量', data.variable || '?')}</>;
    case 'procedure': {
      if (!data.procedureId) return <em>未选择技能</em>;
      const procedure = procedures.find((item) => item.id === data.procedureId);
      const site = sites.find((item) => item.id === (data.siteId || procedure?.siteId));
      return <>{row('网站', site?.name ?? data.siteId ?? '未选择')}{row('技能', procedure?.name ?? data.procedureId)}{site?.url || data.url ? row('网址', site?.url || data.url) : null}{data.resultVariable ? row('返回', data.resultVariable) : procedure?.output?.enabled ? row('返回', '合并字段') : null}</>;
    }
    case 'site': {
      if (!data.siteId) return <em>未选择站点</em>;
      const site = sites.find((item) => item.id === data.siteId);
      return row('站点', site?.name ?? data.siteId);
    }
    default: return null;
  }
}

function FlowNodeCard({ data, type, selected }: NodeProps<CanvasNode>) {
  const meta = typeMeta(type);
  const mark = data.runMark ?? 'idle';
  const report = data.lastReport;
  return (
    <div className={`flow-node flow-node-${meta.type} run-${mark}${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-node-head">
        <span className="flow-node-icon">{meta.icon}</span>
        <span className="flow-node-title">{data.label || meta.label}</span>
        <small>{meta.type}</small>
      </div>
      <div className="flow-node-body"><Summary type={meta.type} data={data} />{report && mark !== 'idle' ? <div className="node-summary-report">{report.durationMs}ms{report.errorType ? ` · ${report.errorType}` : ''}</div> : null}</div>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

export default memo(FlowNodeCard);
