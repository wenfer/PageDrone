import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnReconnect,
  type ReactFlowProps,
} from '@xyflow/react';
import {
  Download,
  Eraser,
  Maximize2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { flowApi } from './api';
import { executeFlow } from './execution';
import FlowNodeCard from './FlowNodeCard';
import {
  NODE_CATALOG,
  defaultNodeData,
  newStoredFlow,
  toCanvas,
  toStored,
  uid,
} from './flow-model';
import { PropertiesPanel } from './PropertiesPanel';
import { CanvasResourcesContext } from './resources';
import type {
  AbortState,
  CanvasEdge,
  CanvasNode,
  EdgeWhen,
  FlowNodeData,
  FlowNodeKind,
  LogEntry,
  LogLevel,
  Procedure,
  RunMark,
  Site,
  StoredFlow,
} from './types';

const nodeTypes = Object.fromEntries(NODE_CATALOG.map((item) => [item.type, FlowNodeCard]));
const DRAG_NODE = 'application/x-autopage-node';
const DRAG_PROCEDURE = 'application/x-autopage-procedure';

type PanelTab = 'properties' | 'variables' | 'logs';

interface ContextMenuState {
  x: number;
  y: number;
  nodeId?: string;
  edgeId?: string;
}

/**
 * 旧版流程节点只保存 procedureId。加载到新画布时根据技能归属补齐 siteId，
 * 这样用户下一次保存流程就会把网站 + 技能关系固化到节点中。
 */
function hydrateProcedureSites(flow: StoredFlow, procedureList: Procedure[]): StoredFlow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.type !== 'procedure' || node.data?.siteId || !node.data?.procedureId) return node;
      const procedure = procedureList.find((item) => item.id === node.data?.procedureId);
      return procedure?.siteId
        ? { ...node, data: { ...node.data, siteId: procedure.siteId } }
        : node;
    }),
  };
}

export default function App() {
  const [flows, setFlows] = useState<StoredFlow[]>([]);
  const [currentFlow, setCurrentFlow] = useState<StoredFlow | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [filter, setFilter] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>('properties');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [variablesDraft, setVariablesDraft] = useState('{}');
  const [variablesError, setVariablesError] = useState('');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortState | null>(null);
  const reconnectSucceeded = useRef(true);
  const autorunPending = useRef(new URLSearchParams(location.search).get('autorun') === '1');
  const { screenToFlowPosition, fitView } = useReactFlow<CanvasNode, CanvasEdge>();

  const appendLog = useCallback((level: LogLevel, message: string) => {
    setLogs((items) => [...items, { id: uid('e'), level, message, at: Date.now() }]);
  }, []);

  const selectFlow = useCallback((flow: StoredFlow) => {
    const canvas = toCanvas(flow);
    setCurrentFlow(structuredClone(flow));
    setNodes(canvas.nodes);
    setEdges(canvas.edges);
    setVariables({ ...(flow.variables ?? {}) });
    setVariablesDraft(JSON.stringify(flow.variables ?? {}, null, 2));
    setVariablesError('');
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setLogs([]);
    requestAnimationFrame(() => void fitView({ padding: 0.25, maxZoom: 1 }));
  }, [fitView, setEdges, setNodes]);

  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        const [flowResponse, procedureResponse, statusResponse] = await Promise.all([
          flowApi.list(),
          flowApi.procedures(),
          flowApi.status(),
        ]);
        if (disposed) return;
        setProcedures(procedureResponse.procedures ?? []);
        setSites(statusResponse.sites ?? []);
        let loadedFlows = flowResponse.flows ?? [];
        if (loadedFlows.length === 0) {
          const response = await flowApi.save(newStoredFlow(1));
          if (!response.flow) throw new Error('后台未返回新建流程');
          loadedFlows = [response.flow];
        }
        if (disposed) return;
        setFlows(loadedFlows);
        const requestedId = new URLSearchParams(location.search).get('flowId');
        const selected = loadedFlows.find((flow) => flow.id === requestedId) ?? loadedFlows[0]!;
        selectFlow(hydrateProcedureSites(selected, procedureResponse.procedures ?? []));
      } catch (error) {
        if (!disposed) setLoadError(errorMessage(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    return () => { disposed = true; };
  }, [selectFlow]);

  // 画布与管理页共享 chrome.storage.local。网站或技能在另一个页面保存后，
  // 立即更新左侧筛选资源，避免必须刷新画布才出现新技能。
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.procedures) {
        setProcedures(Array.isArray(changes.procedures.newValue) ? changes.procedures.newValue as Procedure[] : []);
      }
      if (changes.sites) {
        setSites(Array.isArray(changes.sites.newValue) ? changes.sites.newValue as Site[] : []);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    if (selectedSiteId && !sites.some((site) => site.id === selectedSiteId)) setSelectedSiteId('');
  }, [selectedSiteId, sites]);

  const saveCurrentFlow = useCallback(async (quiet = false): Promise<StoredFlow | null> => {
    if (!currentFlow) return null;
    const candidate = toStored(currentFlow, nodes, edges);
    const response = await flowApi.save(candidate);
    if (!response.flow) throw new Error('保存流程失败：后台未返回数据');
    setCurrentFlow(response.flow);
    setFlows((items) => {
      const found = items.some((item) => item.id === response.flow!.id);
      return found ? items.map((item) => item.id === response.flow!.id ? response.flow! : item) : [...items, response.flow!];
    });
    if (!quiet) appendLog('success', `流程已保存：${response.flow.name}`);
    return response.flow;
  }, [appendLog, currentFlow, edges, nodes]);

  const createFlow = useCallback(async () => {
    try {
      const response = await flowApi.save(newStoredFlow(flows.length + 1));
      if (!response.flow) throw new Error('后台未返回新建流程');
      setFlows((items) => [...items, response.flow!]);
      selectFlow(hydrateProcedureSites(response.flow, procedures));
    } catch (error) {
      appendLog('error', `新建失败：${errorMessage(error)}`);
    }
  }, [appendLog, flows.length, procedures, selectFlow]);

  const deleteFlow = useCallback(async () => {
    if (!currentFlow || !confirm(`确定删除流程“${currentFlow.name}”？`)) return;
    try {
      await flowApi.remove(currentFlow.id);
      const remaining = flows.filter((flow) => flow.id !== currentFlow.id);
      if (remaining.length === 0) {
        const response = await flowApi.save(newStoredFlow(1));
        if (!response.flow) throw new Error('后台未返回新建流程');
        setFlows([response.flow]);
        selectFlow(hydrateProcedureSites(response.flow, procedures));
      } else {
        setFlows(remaining);
        selectFlow(hydrateProcedureSites(remaining[0]!, procedures));
      }
    } catch (error) {
      appendLog('error', `删除失败：${errorMessage(error)}`);
    }
  }, [appendLog, currentFlow, flows, procedures, selectFlow]);

  const addNodeAt = useCallback((type: FlowNodeKind, position: { x: number; y: number }, data?: FlowNodeData) => {
    const node: CanvasNode = {
      id: uid('n'),
      type,
      position,
      data: { ...defaultNodeData(type), ...data, runMark: 'idle' },
    };
    setNodes((items) => [...items, node]);
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setActiveTab('properties');
  }, [setNodes]);

  const duplicateNode = useCallback((id: string) => {
    setNodes((items) => {
      const source = items.find((item) => item.id === id);
      if (!source) return items;
      const copy: CanvasNode = {
        ...source,
        id: uid('n'),
        selected: false,
        position: { x: source.position.x + 36, y: source.position.y + 36 },
        data: structuredClone(source.data),
      };
      setSelectedNodeId(copy.id);
      return [...items, copy];
    });
  }, [setNodes]);

  const deleteNode = useCallback((id: string) => {
    setNodes((items) => items.filter((item) => item.id !== id));
    setEdges((items) => items.filter((item) => item.source !== id && item.target !== id));
    setSelectedNodeId(null);
  }, [setEdges, setNodes]);

  const deleteEdge = useCallback((id: string) => {
    setEdges((items) => items.filter((item) => item.id !== id));
    setSelectedEdgeId(null);
  }, [setEdges]);

  const updateNodeData = useCallback((id: string, patch: Partial<FlowNodeData>) => {
    setNodes((items) => items.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
  }, [setNodes]);

  const updateEdgeWhen = useCallback((id: string, when: EdgeWhen) => {
    setEdges((items) => items.map((edge) => edge.id === id ? {
      ...edge,
      label: when === 'always' ? undefined : when,
      data: { ...edge.data, when },
    } : edge));
  }, [setEdges]);

  const validConnection = useCallback((connection: Connection | CanvasEdge, currentEdges: CanvasEdge[], ignoredId?: string) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    return !currentEdges.some((edge) => edge.id !== ignoredId && (
      edge.target === connection.target ||
      (edge.source === connection.source && edge.target === connection.target)
    ));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((items) => {
      if (!validConnection(connection, items)) return items;
      return addEdge<CanvasEdge>({
        ...connection,
        id: uid('e'),
        type: 'smoothstep',
        data: { when: 'always' },
        reconnectable: true,
      }, items);
    });
  }, [setEdges, validConnection]);

  const onReconnect: OnReconnect<CanvasEdge> = useCallback((oldEdge, connection) => {
    setEdges((items) => {
      if (!validConnection(connection, items, oldEdge.id)) return items;
      reconnectSucceeded.current = true;
      return reconnectEdge(oldEdge, connection, items);
    });
  }, [setEdges, validConnection]);

  const onReconnectStart = useCallback(() => { reconnectSucceeded.current = false; }, []);
  const onReconnectEnd = useCallback((...args: Parameters<NonNullable<ReactFlowProps<CanvasNode, CanvasEdge>['onReconnectEnd']>>) => {
    const edge = args[1];
    if (!reconnectSucceeded.current) setEdges((items) => items.filter((item) => item.id !== edge.id));
  }, [setEdges]);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData(DRAG_NODE) as FlowNodeKind;
    const procedureId = event.dataTransfer.getData(DRAG_PROCEDURE);
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (type) addNodeAt(type, position);
    else if (procedureId) addNodeAt('procedure', position, { siteId: selectedSiteId, procedureId, params: {} });
  }, [addNodeAt, screenToFlowPosition, selectedSiteId]);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_event, node) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setActiveTab('properties');
    setContextMenu(null);
  }, []);

  const onEdgeClick: EdgeMouseHandler<CanvasEdge> = useCallback((_event, edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
    setActiveTab('properties');
    setContextMenu(null);
  }, []);

  const onNodeContextMenu: NodeMouseHandler<CanvasNode> = useCallback((event, node) => {
    event.preventDefault();
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  const onEdgeContextMenu: EdgeMouseHandler<CanvasEdge> = useCallback((event, edge) => {
    event.preventDefault();
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
    setContextMenu({ x: event.clientX, y: event.clientY, edgeId: edge.id });
  }, []);

  const markNode = useCallback((id: string, mark: RunMark) => {
    setNodes((items) => items.map((node) => node.id === id ? { ...node, data: { ...node.data, runMark: mark } } : node));
  }, [setNodes]);

  const runCurrentFlow = useCallback(async () => {
    if (!currentFlow || running) return;
    setRunning(true);
    setActiveTab('logs');
    setLogs([]);
    const runVariables = { ...(currentFlow.variables ?? {}) };
    setVariables(runVariables);
    setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, runMark: 'idle' } })));
    const abort: AbortState = { aborted: false };
    abortRef.current = abort;
    appendLog('info', `===== 开始执行：${currentFlow.name} =====`);
    try {
      await saveCurrentFlow(true);
    } catch (error) {
      appendLog('warn', `自动保存失败，仍继续运行：${errorMessage(error)}`);
    }
    try {
      const result = await executeFlow({
        nodes: nodes.map((node) => ({ ...node, data: { ...node.data, runMark: 'idle' } })),
        edges,
        procedures,
        sites,
        variables: runVariables,
        abort,
        log: appendLog,
        markNode,
        variablesChanged: setVariables,
      });
      appendLog(result === 'completed' ? 'success' : 'warn', result === 'completed' ? '===== 执行完成 =====' : '===== 执行已停止 =====');
    } catch (error) {
      appendLog('error', `执行失败：${errorMessage(error)}`);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [appendLog, currentFlow, edges, markNode, nodes, procedures, running, saveCurrentFlow, setNodes, sites]);

  useEffect(() => {
    if (!loading && currentFlow && autorunPending.current) {
      autorunPending.current = false;
      const timer = setTimeout(() => void runCurrentFlow(), 250);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [currentFlow, loading, runCurrentFlow]);

  const stopFlow = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.aborted = true;
    appendLog('warn', '用户请求停止...');
  }, [appendLog]);

  const exportFlow = useCallback(() => {
    if (!currentFlow) return;
    const payload = toStored(currentFlow, nodes, edges);
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${payload.name || 'flow'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [currentFlow, edges, nodes]);

  const importFlow = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<StoredFlow>;
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error('文件格式不正确');
      const now = Date.now();
      const imported: StoredFlow = {
        id: uid('flow'),
        name: `${parsed.name || '导入的流程'} (导入)`,
        description: parsed.description ?? '',
        nodes: parsed.nodes,
        edges: parsed.edges,
        variables: parsed.variables ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const response = await flowApi.save(imported);
      if (!response.flow) throw new Error('后台未返回导入流程');
      setFlows((items) => [...items, response.flow!]);
      selectFlow(hydrateProcedureSites(response.flow, procedures));
      appendLog('success', '导入成功');
    } catch (error) {
      alert(`导入失败：${errorMessage(error)}`);
    }
  }, [appendLog, procedures, selectFlow]);

  const refreshProcedures = useCallback(async () => {
    try {
      const response = await flowApi.procedures();
      setProcedures(response.procedures ?? []);
    } catch (error) {
      appendLog('error', `刷新技能失败：${errorMessage(error)}`);
    }
  }, [appendLog]);

  const applyVariablesDraft = useCallback((value: string) => {
    setVariablesDraft(value);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('变量必须是 JSON 对象');
      const next = parsed as Record<string, unknown>;
      setVariablesError('');
      setVariables(next);
      setCurrentFlow((flow) => flow ? { ...flow, variables: next } : flow);
    } catch (error) {
      setVariablesError(errorMessage(error));
    }
  }, []);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const filteredProcedures = procedures.filter((procedure) => procedure.siteId === selectedSiteId && (!filter || procedure.name.toLowerCase().includes(filter.toLowerCase())));

  if (loading) return <div className="page-state">正在加载流程画布…</div>;
  if (loadError) return <div className="page-state error"><strong>画布加载失败</strong><span>{loadError}</span><Button variant="outline" onClick={() => location.reload()}>重试</Button></div>;

  return (
    <CanvasResourcesContext.Provider value={{ procedures, sites }}>
      <div className="canvas-app" onClick={() => setContextMenu(null)}>
        <aside className="sidebar">
          <header><strong>auto-page</strong><span>React Flow 画布编排</span></header>
          <Palette title="控制节点" items={NODE_CATALOG.filter((item) => item.group === 'control')} />
          <Palette title="浏览器节点" items={NODE_CATALOG.filter((item) => item.group === 'browser')} />
          <section className="sidebar-section grow">
            <div className="section-title"><span>技能库</span><Button variant="ghost" size="icon" className="size-7" title="刷新技能库" aria-label="刷新技能库" onClick={() => void refreshProcedures()}><RefreshCw /></Button></div>
            <select className="site-filter" value={selectedSiteId} onChange={(event) => { setSelectedSiteId(event.target.value); setFilter(''); }}>
              <option value="">先选择网站</option>
              {sites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
            </select>
            <Input className="filter-input" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="过滤技能…" />
            <div className="procedure-list">
              {!selectedSiteId ? <div className="panel-empty compact">选择网站后显示该网站下的技能</div> : filteredProcedures.length === 0 ? <div className="panel-empty compact">该网站暂无技能，请在网站操作中创建</div> : filteredProcedures.map((procedure) => (
                <div
                  className="procedure-item"
                  key={procedure.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_PROCEDURE, procedure.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => addNodeAt('procedure', screenToFlowPosition({ x: innerWidth / 2, y: innerHeight / 2 }), { siteId: selectedSiteId, procedureId: procedure.id, params: {} })}
                >
                  <strong><Badge variant={procedure.kind === 'login' ? 'warning' : 'secondary'}>{procedure.kind === 'login' ? '登录' : procedure.kind === 'verification' ? '验证' : '自动化'}</Badge>{procedure.name}</strong>
                  <small>{procedure.description}</small>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <main className="workspace">
          <div className="toolbar">
            <select value={currentFlow?.id ?? ''} onChange={(event) => {
              const flow = flows.find((item) => item.id === event.target.value);
              if (flow) selectFlow(hydrateProcedureSites(flow, procedures));
            }}>
              {flows.map((flow) => <option value={flow.id} key={flow.id}>{flow.name}</option>)}
            </select>
            <Input className="flow-name" value={currentFlow?.name ?? ''} onChange={(event) => setCurrentFlow((flow) => flow ? { ...flow, name: event.target.value } : flow)} aria-label="流程名称" />
            <Button variant="outline" size="sm" onClick={() => void createFlow()}><Plus />新建</Button>
            <Button size="sm" onClick={() => void saveCurrentFlow().catch((error) => appendLog('error', errorMessage(error)))}><Save />保存</Button>
            <Button variant="outline" size="sm" className="run-button" disabled={running} onClick={() => void runCurrentFlow()}><Play />{running ? '运行中…' : '运行'}</Button>
            <Button variant="destructive" size="sm" disabled={!running} onClick={stopFlow}><Square />停止</Button>
            <span className="toolbar-spacer" />
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void deleteFlow()}><Trash2 />删除</Button>
            <Button variant="outline" size="sm" onClick={exportFlow}><Download />导出</Button>
            <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}><Upload />导入</Button>
            <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importFlow(event)} />
            <Button variant="outline" size="icon" className="size-8" title="适应窗口" aria-label="适应窗口" onClick={() => void fitView({ padding: 0.2 })}><Maximize2 /></Button>
            <Badge className="zoom-badge" variant="outline">{Math.round(zoom * 100)}%</Badge>
          </div>
          <div className="flow-area">
            <ReactFlow<CanvasNode, CanvasEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodesDelete={(deleted) => {
                const ids = new Set(deleted.map((node) => node.id));
                setEdges((items) => items.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)));
              }}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onNodeContextMenu={onNodeContextMenu}
              onEdgeContextMenu={onEdgeContextMenu}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
                setContextMenu(null);
              }}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onMove={(_event, viewport) => setZoom(viewport.zoom)}
              isValidConnection={(connection) => validConnection(connection, edges)}
              minZoom={0.25}
              maxZoom={2}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              deleteKeyCode={['Backspace', 'Delete']}
              multiSelectionKeyCode="Shift"
              panOnScroll
              selectionOnDrag
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
              <MiniMap pannable zoomable nodeColor={(node) => nodeColor(node.type)} />
              <Controls showInteractive={false} />
            </ReactFlow>
            <div className="canvas-hint">节点 {nodes.length} · 连线 {edges.length} · 拖入节点/技能，端口连线，Delete 删除</div>
          </div>
        </main>

        <aside className="rightbar">
          <div className="panel-tabs">
            {([['properties', '属性'], ['variables', '变量'], ['logs', '日志']] as const).map(([tab, label]) => (
              <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{label}</button>
            ))}
          </div>
          <div className="right-panel">
            {activeTab === 'properties' ? <PropertiesPanel
              node={selectedNode}
              edge={selectedEdge}
              procedures={procedures}
              sites={sites}
              onNodeData={updateNodeData}
              onEdgeWhen={updateEdgeWhen}
              onDuplicate={duplicateNode}
              onDeleteNode={deleteNode}
              onDeleteEdge={deleteEdge}
            /> : null}
            {activeTab === 'variables' ? <div className="variables-panel">
              <h3>初始变量</h3>
              <Textarea value={variablesDraft} onChange={(event) => applyVariablesDraft(event.target.value)} spellCheck={false} />
              {variablesError ? <p className="form-error">{variablesError}</p> : null}
              <h3>当前变量</h3>
              {Object.keys(variables).length === 0 ? <div className="panel-empty compact">暂无变量</div> : Object.entries(variables).map(([key, value]) => (
                <div className="variable-row" key={key}><strong>{key}</strong><span>{formatValue(value)}</span></div>
              ))}
            </div> : null}
            {activeTab === 'logs' ? <div className="logs-panel">
              <div className="log-toolbar"><Button variant="outline" size="sm" onClick={() => setLogs([])}><Eraser />清空</Button></div>
              <div className="log-list">{logs.length === 0 ? <div className="panel-empty compact">暂无日志</div> : logs.map((entry) => (
                <div key={entry.id} className={`log-line ${entry.level}`}><time>{new Date(entry.at).toLocaleTimeString()}</time>{entry.message}</div>
              ))}</div>
            </div> : null}
          </div>
        </aside>

        {contextMenu ? <ContextMenu
          state={contextMenu}
          onDuplicate={duplicateNode}
          onDeleteNode={deleteNode}
          onDeleteEdge={deleteEdge}
          onEdgeWhen={updateEdgeWhen}
        /> : null}
      </div>
    </CanvasResourcesContext.Provider>
  );
}

function Palette({ title, items }: { title: string; items: typeof NODE_CATALOG }) {
  return (
    <section className="sidebar-section">
      <div className="section-title">{title}</div>
      <div className="palette">
        {items.map((item) => (
          <div
            className="palette-item"
            key={item.type}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_NODE, item.type);
              event.dataTransfer.effectAllowed = 'copy';
            }}
          ><span>{item.icon}</span>{item.label}</div>
        ))}
      </div>
    </section>
  );
}

function ContextMenu({
  state,
  onDuplicate,
  onDeleteNode,
  onDeleteEdge,
  onEdgeWhen,
}: {
  state: ContextMenuState;
  onDuplicate: (id: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
  onEdgeWhen: (id: string, when: EdgeWhen) => void;
}) {
  return (
    <div className="context-menu" style={{ left: state.x, top: state.y }}>
      {state.nodeId ? <>
        <button onClick={() => onDuplicate(state.nodeId!)}>复制节点</button>
        <button className="danger" onClick={() => onDeleteNode(state.nodeId!)}>删除节点</button>
      </> : null}
      {state.edgeId ? <>
        <button onClick={() => onEdgeWhen(state.edgeId!, 'true')}>设为 true 分支</button>
        <button onClick={() => onEdgeWhen(state.edgeId!, 'false')}>设为 false 分支</button>
        <button onClick={() => onEdgeWhen(state.edgeId!, 'always')}>清除分支条件</button>
        <button className="danger" onClick={() => onDeleteEdge(state.edgeId!)}>删除连线</button>
      </> : null}
    </div>
  );
}

function nodeColor(type: string | undefined): string {
  switch (type) {
    case 'start': return 'var(--success)';
    case 'end': return 'var(--destructive)';
    case 'condition': return 'var(--warning)';
    case 'loop': return 'var(--accent-foreground)';
    case 'variable': return 'var(--info)';
    case 'procedure':
    case 'site': return 'var(--primary)';
    default: return 'var(--muted-foreground)';
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
