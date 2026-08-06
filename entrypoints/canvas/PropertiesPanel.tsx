import type { ReactNode } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import type { CanvasEdge, CanvasNode, EdgeWhen, FlowNodeData, Procedure, Site } from './types';
import { typeMeta } from './flow-model';

interface Props {
  node: CanvasNode | null;
  edge: CanvasEdge | null;
  procedures: Procedure[];
  sites: Site[];
  onNodeData: (id: string, patch: Partial<FlowNodeData>) => void;
  onEdgeWhen: (id: string, when: EdgeWhen) => void;
  onDuplicate: (id: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function NodeFields({
  node,
  procedures,
  sites,
  update,
}: {
  node: CanvasNode;
  procedures: Procedure[];
  sites: Site[];
  update: (patch: Partial<FlowNodeData>) => void;
}) {
  const data = node.data;
  switch (node.type) {
    case 'start':
    case 'end':
    case 'parallel':
      return <p className="panel-hint">该节点无可配置参数。</p>;
    case 'condition':
      return (
        <Field label="条件表达式（可使用 vars）" hint="真/假分支由连线的分支条件决定。">
          <Textarea value={String(data.expr ?? '')} onChange={(event) => update({ expr: event.target.value })} placeholder={'vars.get("x") === "1"'} />
        </Field>
      );
    case 'loop':
      return <>
        <Field label="循环次数"><Input type="number" value={String(data.count ?? 3)} onChange={(event) => update({ count: Number(event.target.value) || 0 })} /></Field>
        <Field label="循环变量名"><Input value={String(data.loopVar ?? 'i')} onChange={(event) => update({ loopVar: event.target.value })} /></Field>
        <p className="panel-hint">第一条出边是循环体，其余出边在循环结束后继续。</p>
      </>;
    case 'delay':
      return <Field label="等待毫秒"><Input type="number" value={String(data.ms ?? 1000)} onChange={(event) => update({ ms: Number(event.target.value) || 0 })} /></Field>;
    case 'variable':
      return <>
        <Field label="变量名"><Input value={String(data.name ?? '')} onChange={(event) => update({ name: event.target.value })} /></Field>
        <Field label={'值（支持 ${vars.get("x")}）'}><Input value={String(data.value ?? '')} onChange={(event) => update({ value: event.target.value })} /></Field>
      </>;
    case 'log':
      return <>
        <Field label="日志级别">
          <select value={data.level ?? 'info'} onChange={(event) => update({ level: event.target.value as FlowNodeData['level'] })}>
            <option value="info">info</option><option value="warn">warn</option><option value="error">error</option><option value="success">success</option>
          </select>
        </Field>
        <Field label="消息"><Input value={String(data.message ?? '')} onChange={(event) => update({ message: event.target.value })} /></Field>
      </>;
    case 'extract':
      return <>
        <Field label="CSS / XPath 选择器" hint="支持 body、.class、#id 等 CSS；XPath 可使用 xpath:/... 前缀。">
          <Input value={String(data.selector ?? 'body')} onChange={(event) => update({ selector: event.target.value })} placeholder="body" />
        </Field>
        <Field label="提取模式">
          <select value={data.mode ?? 'text'} onChange={(event) => update({ mode: event.target.value as FlowNodeData['mode'] })}>
            <option value="text">文本内容</option>
            <option value="html">HTML</option>
            <option value="list">列表数据</option>
            <option value="table">表格数据</option>
            <option value="attribute">元素属性</option>
          </select>
        </Field>
        {data.mode === 'attribute' ? <Field label="属性名"><Input value={String(data.attribute ?? '')} onChange={(event) => update({ attribute: event.target.value })} placeholder="href" /></Field> : null}
        <Field label="写入变量名"><Input value={String(data.variable ?? 'extracted')} onChange={(event) => update({ variable: event.target.value })} placeholder="extracted" /></Field>
        <label className="check-field"><input type="checkbox" checked={Boolean(data.multiple)} onChange={(event) => update({ multiple: event.target.checked })} />匹配所有元素（返回数组）</label>
      </>;
    case 'request':
    case 'http':
      return <>
        <Field label="请求 URL" hint={'支持 ${vars.get("url")} 变量插值。'}>
          <Input value={String(data.url ?? '')} onChange={(event) => update({ url: event.target.value })} placeholder="https://api.example.com/data" />
        </Field>
        <Field label="请求方法">
          <select value={String(data.method ?? 'GET')} onChange={(event) => update({ method: event.target.value })}>
            <option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option><option value="HEAD">HEAD</option>
          </select>
        </Field>
        <Field label="请求头" hint="每行 Key: Value；也可留空。">
          <Textarea rows={3} value={String(data.headers ?? '')} onChange={(event) => update({ headers: event.target.value })} placeholder="Content-Type: application/json" />
        </Field>
        <Field label="请求体" hint={'支持变量插值，例如 {"items": ${vars.get("items")}}；GET/HEAD 通常留空。'}>
          <Textarea rows={4} value={String(data.body ?? '')} onChange={(event) => update({ body: event.target.value })} placeholder={'{"items": ${vars.get("items")}}'} />
        </Field>
        <Field label="超时毫秒"><Input type="number" min={0} value={String(data.timeoutMs ?? 30000)} onChange={(event) => update({ timeoutMs: Number(event.target.value) || 0 })} /></Field>
        <Field label="写入变量名"><Input value={String(data.variable ?? 'response')} onChange={(event) => update({ variable: event.target.value })} placeholder="response" /></Field>
      </>;
    case 'procedure': {
      const selected = procedures.find((item) => item.id === data.procedureId);
      const effectiveSiteId = String(data.siteId || selected?.siteId || '');
      const selectedSite = sites.find((item) => item.id === effectiveSiteId);
      const siteProcedures = effectiveSiteId ? procedures.filter((item) => item.siteId === effectiveSiteId) : [];
      return <>
        <Field label="先选择网站">
          <select value={effectiveSiteId} onChange={(event) => update({ siteId: event.target.value, procedureId: '', url: '' })}>
            <option value="">（选择一个网站）</option>
            {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </Field>
        <Field label="选择技能" hint={effectiveSiteId ? '这里只显示当前网站下的技能。' : '选择网站后才能选择技能。'}>
          <select disabled={!effectiveSiteId} value={String(data.procedureId ?? '')} onChange={(event) => update({ siteId: effectiveSiteId, procedureId: event.target.value })}>
            <option value="">{effectiveSiteId ? '（选择一个技能）' : '（请先选择网站）'}</option>
            {siteProcedures.map((procedure) => <option key={procedure.id} value={procedure.id}>{procedure.name} ({procedure.kind})</option>)}
          </select>
        </Field>
        <Field label="网站网址" hint="技能节点运行时使用所属网站的网址。">
          <Input value={selectedSite?.url || String(data.url ?? '')} readOnly placeholder="选择网站后自动带入" />
        </Field>
        <Field label="技能返回值变量" hint="技能启用返回值后，留空会按字段名合并到流程变量；填写后保存完整返回值。">
          <Input value={String(data.resultVariable ?? '')} onChange={(event) => update({ resultVariable: event.target.value })} placeholder="例如 articleData（可留空）" />
        </Field>
        {selected && selected.siteId === effectiveSiteId ? <p className="resource-info"><strong>{selected.name}</strong><br />{selected.description || '无简介'}<br />类型：{selected.kind} · 步骤 {selected.steps?.length ?? 0} 个</p> : null}
      </>;
    }
    case 'site':
      return <>
        <Field label="选择站点">
          <select value={String(data.siteId ?? '')} onChange={(event) => update({ siteId: event.target.value })}>
            <option value="">（选择一个站点）</option>
            {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </Field>
        <label className="check-field"><input type="checkbox" checked={Boolean(data.force)} onChange={(event) => update({ force: event.target.checked })} />强制重新执行</label>
      </>;
    default:
      return <p className="panel-hint">未知节点类型。</p>;
  }
}

export function PropertiesPanel({
  node,
  edge,
  procedures,
  sites,
  onNodeData,
  onEdgeWhen,
  onDuplicate,
  onDeleteNode,
  onDeleteEdge,
}: Props) {
  if (!node && !edge) return <div className="panel-empty">选择一个节点或连线查看属性</div>;

  if (edge) {
    return (
      <div className="properties-body">
        <h3>连线属性</h3>
        <Field label="分支条件">
          <select value={edge.data?.when ?? 'always'} onChange={(event) => onEdgeWhen(edge.id, event.target.value as EdgeWhen)}>
            <option value="always">始终（默认）</option>
            <option value="true">true（条件为真）</option>
            <option value="false">false（条件为假）</option>
          </select>
        </Field>
        <p className="panel-hint">仅上游为“条件分支”时生效。</p>
        <Button variant="destructive" className="w-full" onClick={() => onDeleteEdge(edge.id)}><Trash2 />删除连线</Button>
      </div>
    );
  }

  if (!node) return null;
  const meta = typeMeta(node.type);
  return (
    <div className="properties-body">
      <h3>{meta.icon} {meta.label}</h3>
      <Field label="节点标签"><Input value={String(node.data.label ?? '')} onChange={(event) => onNodeData(node.id, { label: event.target.value })} /></Field>
      <NodeFields node={node} procedures={procedures} sites={sites} update={(patch) => onNodeData(node.id, patch)} />
      <Separator className="properties-separator" />
      <div className="panel-actions">
        <Button variant="outline" onClick={() => onDuplicate(node.id)}><Copy />复制</Button>
        <Button variant="destructive" onClick={() => onDeleteNode(node.id)}><Trash2 />删除</Button>
      </div>
    </div>
  );
}
