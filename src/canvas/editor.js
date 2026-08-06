/**
 * auto-page 流程画布编辑器
 *
 * 节点类型：
 *   start / end / condition / loop / parallel / delay / variable / log / procedure / site
 *
 * 交互：
 *   - 从左侧拖拽节点 / 任务到画布
 *   - 从输出端口拖到输入端口建立连线；拖已有连线的端点可重连
 *   - 单击选中节点 / 连线；Delete 删除；双击节点编辑
 *   - 右键节点 / 连线弹出菜单
 *   - Ctrl+滚轮缩放，空白处拖拽平移
 */

import { MSG } from '../lib/messaging.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

// ---------- 节点目录 ----------
const NODE_TYPES = {
  control: [
    { type: 'start',     label: '开始',     icon: '▶️' },
    { type: 'end',       label: '结束',     icon: '⏹️' },
    { type: 'condition', label: '条件分支', icon: '🔀' },
    { type: 'loop',      label: '循环',     icon: '🔁' },
    { type: 'parallel',  label: '并行',     icon: '⇉'  },
    { type: 'delay',     label: '延时',     icon: '⏱️' },
    { type: 'variable',  label: '设置变量', icon: '📦' },
    { type: 'log',       label: '记录日志', icon: '📝' },
  ],
  browser: [
    { type: 'procedure', label: '调用任务', icon: '🧩' },
    { type: 'site',      label: '执行站点', icon: '🌐' },
  ],
};

// ---------- 应用状态 ----------
const state = {
  flows: [],
  currentFlowId: null,
  flow: null, // { id, name, nodes, edges, variables }

  procedures: [],
  sites: [],

  selectedNodeId: null,
  selectedEdgeId: null,
  nextId: 1,

  // 拖拽（节点移动）
  drag: null,
  // 平移
  pan: null,
  // 连线
  connect: null, // { fromNodeId, fromSide, tempPath, toX, toY, edgeId? }

  zoom: 1,

  // 运行时
  running: false,
  abortCtrl: null,
  variables: {},
};

const canvas = $('canvas');
const canvasInner = $('canvasInner');
const edgesSvg = $('edges');

// =====================================================
//  数据访问
// =====================================================

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

async function loadAll() {
  const [flowsRes, procRes, statusRes] = await Promise.all([
    send(MSG.FLOW_LIST),
    send(MSG.PROCEDURE_LIST),
    send(MSG.GET_STATUS),
  ]);
  state.flows = flowsRes.flows || [];
  state.procedures = procRes.procedures || [];
  state.sites = statusRes.sites || [];
  // 支持 ?flowId= 直接打开指定流程；?autorun=1 自动开跑（从设置页流程列表跳转）
  const params = new URLSearchParams(location.search);
  const urlFlowId = params.get('flowId');
  const autorun = params.get('autorun') === '1';
  if (state.flows.length === 0) {
    await createNewFlow(true);
  } else if (urlFlowId && state.flows.some((f) => f.id === urlFlowId)) {
    selectFlow(urlFlowId);
  } else {
    selectFlow(state.flows[0].id);
  }
  if (autorun && state.flow) {
    // 延迟到画布渲染完成后再触发，避免节点还没上屏
    setTimeout(() => { runCurrentFlow(); }, 300);
  }
}

async function createNewFlow(andSelect = false) {
  const flow = {
    id: 'flow_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name: '新流程 ' + (state.flows.length + 1),
    description: '',
    nodes: [
      { id: newId('n'), type: 'start', x: 80, y: 200, data: {} },
      { id: newId('n'), type: 'end',   x: 500, y: 200, data: {} },
    ],
    edges: [
      // 不自动连，避免太呆板
    ],
    variables: {},
  };
  // 给初始节点一条边
  flow.edges.push({ id: newId('e'), from: flow.nodes[0].id, to: flow.nodes[1].id, data: {} });

  const res = await send(MSG.FLOW_SAVE, { flow });
  state.flows.push(res.flow);
  if (andSelect) selectFlow(res.flow.id);
  renderFlowSelect();
}

async function saveCurrentFlow() {
  if (!state.flow) return;
  const res = await send(MSG.FLOW_SAVE, { flow: state.flow });
  const idx = state.flows.findIndex((f) => f.id === res.flow.id);
  if (idx >= 0) state.flows[idx] = res.flow;
  else state.flows.push(res.flow);
  renderFlowSelect();
  log('success', `流程已保存：${res.flow.name}`);
}

async function deleteCurrentFlow() {
  if (!state.flow) return;
  if (!confirm(`确定删除流程「${state.flow.name}」？`)) return;
  await send(MSG.FLOW_DELETE, { id: state.flow.id });
  state.flows = state.flows.filter((f) => f.id !== state.flow.id);
  state.flow = null;
  state.currentFlowId = null;
  if (state.flows.length === 0) {
    await createNewFlow(true);
  } else {
    selectFlow(state.flows[0].id);
  }
  renderFlowSelect();
}

function selectFlow(id) {
  state.currentFlowId = id;
  state.flow = JSON.parse(JSON.stringify(state.flows.find((f) => f.id === id)));
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.variables = { ...(state.flow.variables || {}) };
  renderAll();
  $('flowSelect').value = id;
}

// =====================================================
//  工具
// =====================================================

function newId(prefix) {
  return prefix + '_' + (state.nextId++);
}

function syncNextId() {
  let max = 0;
  state.flow.nodes.forEach((n) => {
    const m = parseInt(String(n.id).replace(/\D/g, ''), 10);
    if (!isNaN(m)) max = Math.max(max, m);
  });
  state.flow.edges.forEach((e) => {
    const m = parseInt(String(e.id).replace(/\D/g, ''), 10);
    if (!isNaN(m)) max = Math.max(max, m);
  });
  state.nextId = max + 1;
}

function findNode(id) { return state.flow.nodes.find((n) => n.id === id); }
function findEdge(id) { return state.flow.edges.find((e) => e.id === id); }

function canvasPos(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left + canvas.scrollLeft) / state.zoom,
    y: (clientY - r.top + canvas.scrollTop) / state.zoom,
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// =====================================================
//  渲染
// =====================================================

function renderAll() {
  if (!state.flow) return;
  syncNextId();
  renderNodes();
  renderEdges();
  renderProperties();
  renderVariables();
  updateGridHint();
}

function updateGridHint() {
  $('gridHint').textContent =
    `节点 ${state.flow.nodes.length} · 连线 ${state.flow.edges.length} · 拖入节点/任务，拖拽端口连线，双击编辑`;
}

// ---------- Nodes ----------

function renderNodes() {
  // 清除已有（保留 svg）
  canvasInner.querySelectorAll('.node').forEach((el) => el.remove());
  state.flow.nodes.forEach((n) => {
    const el = document.createElement('div');
    el.className = `node type-${n.type}`;
    el.dataset.id = n.id;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    if (n.id === state.selectedNodeId) el.classList.add('selected');
    el.innerHTML = nodeHtml(n);
    canvasInner.appendChild(el);
    bindNodeEvents(el, n);
  });
  updatePortIndicators();
}

function nodeHtml(n) {
  const def = typeLabel(n.type);
  const summary = nodeSummary(n);
  return `
    <div class="node-header" data-drag="1">
      <span class="nh-icon">${def.icon}</span>
      <span>${escapeHtml(n.data.label || def.label)}</span>
      <span class="nh-type">${n.type}</span>
    </div>
    <div class="node-body">${summary}</div>
    <div class="port input" data-port="in"></div>
    <div class="port output" data-port="out"></div>
  `;
}

function typeLabel(type) {
  for (const group of Object.values(NODE_TYPES)) {
    const f = group.find((x) => x.type === type);
    if (f) return f;
  }
  return { label: type, icon: '❓' };
}

function nodeSummary(n) {
  const d = n.data || {};
  const line = (k, v) => `<div class="nb-line"><span class="nb-k">${k}</span><span class="nb-v">${escapeHtml(v)}</span></div>`;
  switch (n.type) {
    case 'start':
    case 'end':
      return `<div class="nb-empty">${n.type === 'start' ? '流程入口' : '流程出口'}</div>`;
    case 'condition':
      return d.expr ? line('if', d.expr) : '<div class="nb-empty">未设置条件</div>';
    case 'loop':
      return line('次数', d.count || '?') + (d.loopVar ? line('变量', d.loopVar) : '');
    case 'parallel':
      return '<div class="nb-empty">所有分支同时执行</div>';
    case 'delay':
      return line('等待', (d.ms || 1000) + ' ms');
    case 'variable':
      return d.name ? line(d.name, d.value ?? '') : '<div class="nb-empty">未设置变量</div>';
    case 'log':
      return line('日志', d.message || '(空)');
    case 'procedure': {
      if (!d.procedureId) return '<div class="nb-empty">未选择任务</div>';
      const p = state.procedures.find((x) => x.id === d.procedureId);
      return line('任务', p ? p.name : d.procedureId) + (d.url ? line('网址', d.url) : '');
    }
    case 'site': {
      if (!d.siteId) return '<div class="nb-empty">未选择站点</div>';
      const s = state.sites.find((x) => x.id === d.siteId);
      return line('站点', s ? s.name : d.siteId);
    }
    default:
      return '';
  }
}

function bindNodeEvents(el, n) {
  const header = el.querySelector('.node-header');

  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('port')) return;
    selectNode(n.id);
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.classList.contains('port')) return;
    openProperties(n.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectNode(n.id);
    showContextMenu(e.clientX, e.clientY, [
      { label: '编辑属性', action: () => openProperties(n.id) },
      { label: '复制节点', action: () => duplicateNode(n.id) },
      { hr: true },
      { label: '删除节点', danger: true, action: () => removeNode(n.id) },
    ]);
  });

  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    selectNode(n.id);
    const r = el.getBoundingClientRect();
    state.drag = {
      nodeId: n.id,
      offsetX: e.clientX - r.left,
      offsetY: e.clientY - r.top,
    };
    e.preventDefault();
  });

  el.querySelector('.port.output').addEventListener('mousedown', (e) => {
    e.stopPropagation();
    startConnect(n.id, 'out', e);
  });
  el.querySelector('.port.input').addEventListener('mousedown', (e) => {
    e.stopPropagation();
    // 从输入端反向拉线，或重连已有边
    const incoming = state.flow.edges.find((ed) => ed.to === n.id);
    if (incoming) {
      // 拆掉旧边，从源点重新开始拉线
      state.flow.edges = state.flow.edges.filter((ed) => ed.id !== incoming.id);
      startConnect(incoming.from, 'out', e, incoming.id);
    } else {
      startConnect(n.id, 'in', e);
    }
  });
}

function selectNode(id) {
  state.selectedNodeId = id;
  state.selectedEdgeId = null;
  canvasInner.querySelectorAll('.node').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  edgesSvg.querySelectorAll('.edge').forEach((el) => el.classList.remove('selected'));
  renderProperties();
}

function addNode(type, x, y, data) {
  const node = {
    id: newId('n'),
    type,
    x: x || 100,
    y: y || 100,
    data: data || defaultData(type),
  };
  state.flow.nodes.push(node);
  renderNodes();
  selectNode(node.id);
  return node;
}

function duplicateNode(id) {
  const n = findNode(id);
  if (!n) return;
  const copy = JSON.parse(JSON.stringify(n));
  copy.id = newId('n');
  copy.x += 30;
  copy.y += 30;
  state.flow.nodes.push(copy);
  renderNodes();
  selectNode(copy.id);
}

function removeNode(id) {
  state.flow.nodes = state.flow.nodes.filter((n) => n.id !== id);
  state.flow.edges = state.flow.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.selectedNodeId === id) state.selectedNodeId = null;
  renderAll();
}

function defaultData(type) {
  switch (type) {
    case 'condition': return { expr: 'true' };
    case 'loop':      return { count: 3, loopVar: 'i' };
    case 'parallel':  return {};
    case 'delay':     return { ms: 1000 };
    case 'variable':  return { name: 'var1', value: '' };
    case 'log':       return { level: 'info', message: '' };
    case 'procedure': return { procedureId: '', url: '', params: {} };
    case 'site':      return { siteId: '', force: false };
    default: return {};
  }
}

// ---------- Edges ----------

function portPos(nodeId, side) {
  const n = findNode(nodeId);
  if (!n) return { x: 0, y: 0 };
  const el = canvasInner.querySelector(`.node[data-id="${nodeId}"]`);
  const w = el ? el.offsetWidth : 170;
  const h = el ? el.offsetHeight : 60;
  return {
    x: n.x + (side === 'out' ? w : 0),
    y: n.y + h / 2,
  };
}

function bezierPath(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M ${a.x},${a.y} C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function renderEdges() {
  edgesSvg.querySelectorAll(':scope > *:not(defs)').forEach((el) => el.remove());

  state.flow.edges.forEach((e) => {
    const from = portPos(e.from, 'out');
    const to = portPos(e.to, 'in');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', bezierPath(from, to));
    path.setAttribute('class', 'edge' + (e.id === state.selectedEdgeId ? ' selected' : ''));
    path.setAttribute('marker-end', 'url(#arrow)');
    path.dataset.id = e.id;
    path.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectEdge(e.id);
    });
    path.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      selectEdge(e.id);
      showContextMenu(ev.clientX, ev.clientY, [
        { label: '设为 true 分支', action: () => setEdgeWhen(e.id, 'true') },
        { label: '设为 false 分支', action: () => setEdgeWhen(e.id, 'false') },
        { label: '清除分支条件', action: () => setEdgeWhen(e.id, 'always') },
        { hr: true },
        { label: '删除连线', danger: true, action: () => removeEdge(e.id) },
      ]);
    });
    edgesSvg.appendChild(path);

    // 标签（true / false）
    const when = e.data && e.data.when;
    if (when && when !== 'always') {
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2 - 6;
      const bg = document.createElementNS(NS, 'rect');
      bg.setAttribute('class', 'edge-label-bg');
      bg.setAttribute('x', mx - 18);
      bg.setAttribute('y', my - 9);
      bg.setAttribute('width', 36);
      bg.setAttribute('height', 14);
      bg.setAttribute('rx', 3);
      edgesSvg.appendChild(bg);
      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('class', 'edge-label');
      txt.setAttribute('x', mx);
      txt.setAttribute('y', my + 2);
      txt.setAttribute('text-anchor', 'middle');
      txt.textContent = when === 'true' ? 'true' : 'false';
      edgesSvg.appendChild(txt);
    }

    // 端点手柄（悬停时显示，这里始终显示小手柄以便重连）
    ['out', 'in'].forEach((side) => {
      const pos = side === 'out' ? from : to;
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('class', 'edge-handle');
      c.setAttribute('cx', pos.x);
      c.setAttribute('cy', pos.y);
      c.setAttribute('r', 5);
      c.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        if (side === 'out') {
          state.flow.edges = state.flow.edges.filter((x) => x.id !== e.id);
          startConnect(e.from, 'out', ev, e.id);
        } else {
          state.flow.edges = state.flow.edges.filter((x) => x.id !== e.id);
          startConnect(e.to, 'in', ev, e.id);
        }
      });
      edgesSvg.appendChild(c);
    });
  });

  updatePortIndicators();
}

function updatePortIndicators() {
  canvasInner.querySelectorAll('.port.output').forEach((p) => p.classList.remove('has-connections'));
  canvasInner.querySelectorAll('.port.input').forEach((p) => p.classList.remove('has-connections'));
  state.flow.edges.forEach((e) => {
    const outEl = canvasInner.querySelector(`.node[data-id="${e.from}"] .port.output`);
    const inEl = canvasInner.querySelector(`.node[data-id="${e.to}"] .port.input`);
    if (outEl) outEl.classList.add('has-connections');
    if (inEl) inEl.classList.add('has-connections');
  });
}

function selectEdge(id) {
  state.selectedEdgeId = id;
  state.selectedNodeId = null;
  canvasInner.querySelectorAll('.node').forEach((el) => el.classList.remove('selected'));
  edgesSvg.querySelectorAll('.edge').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderProperties();
}

function setEdgeWhen(id, when) {
  const e = findEdge(id);
  if (!e) return;
  e.data = e.data || {};
  e.data.when = when;
  renderEdges();
}

function removeEdge(id) {
  state.flow.edges = state.flow.edges.filter((e) => e.id !== id);
  if (state.selectedEdgeId === id) state.selectedEdgeId = null;
  renderEdges();
}

// ---------- 连线交互 ----------

function startConnect(nodeId, side, e, existingEdgeId) {
  const pos = canvasPos(e.clientX, e.clientY);
  const startPoint = portPos(nodeId, side);
  const temp = document.createElementNS(NS, 'path');
  temp.setAttribute('class', 'edge temp');
  edgesSvg.appendChild(temp);

  state.connect = {
    nodeId, side,
    startX: startPoint.x, startY: startPoint.y,
    tempPath: temp,
    existingEdgeId: existingEdgeId || null,
  };
  updateTempEdge(pos);

  const move = (ev) => updateTempEdge(canvasPos(ev.clientX, ev.clientY));
  const up = (ev) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    finishConnect(ev);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function updateTempEdge(pos) {
  if (!state.connect) return;
  const { startX, startY, side } = state.connect;
  // 如果是从输入端口反向拉，起点固定但路径要反向
  let a, b;
  if (side === 'out') { a = { x: startX, y: startY }; b = pos; }
  else { a = pos; b = { x: startX, y: startY }; }
  state.connect.tempPath.setAttribute('d', bezierPath(a, b));
}

function finishConnect(ev) {
  if (!state.connect) return;
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  const portEl = target && target.closest && target.closest('.port');
  const nodeEl = target && target.closest && target.closest('.node');
  let toNodeId = null;
  let toSide = null;
  if (portEl && nodeEl) {
    toNodeId = nodeEl.dataset.id;
    toSide = portEl.dataset.port;
  }

  const { nodeId, side, existingEdgeId } = state.connect;
  state.connect.tempPath.remove();
  state.connect = null;

  if (!toNodeId || toNodeId === nodeId) {
    // 无效连接；如果是重连，则不恢复
    return;
  }

  let fromId, toId;
  if (side === 'out' && toSide === 'in') {
    fromId = nodeId; toId = toNodeId;
  } else if (side === 'in' && toSide === 'out') {
    fromId = toNodeId; toId = nodeId;
  } else {
    // 两个同类端口，忽略
    return;
  }

  // 同一目标只保留一条入边
  state.flow.edges = state.flow.edges.filter((e) => e.to !== toId);
  // 去重
  state.flow.edges = state.flow.edges.filter((e) => !(e.from === fromId && e.to === toId));
  state.flow.edges.push({
    id: existingEdgeId || newId('e'),
    from: fromId,
    to: toId,
    data: {},
  });
  renderEdges();
  updateGridHint();
}

// =====================================================
//  属性面板
// =====================================================

function openProperties(id) {
  selectNode(id);
  $('panel-props').classList.add('active');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('tab-active', t.dataset.tab === 'props'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-props'));
}

function renderProperties() {
  const body = $('propsBody');
  const empty = $('propsEmpty');
  body.innerHTML = '';
  if (state.selectedNodeId) {
    empty.classList.add('hidden');
    body.classList.remove('hidden');
    renderNodeProps(body);
    return;
  }
  if (state.selectedEdgeId) {
    empty.classList.add('hidden');
    body.classList.remove('hidden');
    renderEdgeProps(body);
    return;
  }
  empty.classList.remove('hidden');
  body.classList.add('hidden');
}

function renderNodeProps(container) {
  const n = findNode(state.selectedNodeId);
  if (!n) return;
  const d = n.data || {};
  const def = typeLabel(n.type);

  // 通用：节点标签
  appendField(container, '节点标签', inputText(n.data.label || '', (v) => { n.data.label = v; refreshNodeEl(n); }));

  switch (n.type) {
    case 'start':
    case 'end':
    case 'parallel':
      hint(container, '该节点无可配置参数。');
      break;

    case 'condition':
      appendField(container, '条件表达式（可使用 vars）', textarea(d.expr || '', (v) => { n.data.expr = v; refreshNodeEl(n); }, 'vars.get("x") === "1"'));
      hint(container, '为 true 时走标记为 true 的出边；为 false 时走 false 出边。');
      break;

    case 'loop':
      appendField(container, '循环次数', inputNumber(d.count || 3, (v) => { n.data.count = v; refreshNodeEl(n); }));
      appendField(container, '循环变量名（保存当前索引）', inputText(d.loopVar || 'i', (v) => { n.data.loopVar = v; refreshNodeEl(n); }));
      hint(container, '第一条出边为循环体，执行 N 次；其余出边在循环结束后继续。');
      break;

    case 'delay':
      appendField(container, '等待毫秒', inputNumber(d.ms || 1000, (v) => { n.data.ms = v; refreshNodeEl(n); }));
      break;

    case 'variable':
      appendField(container, '变量名', inputText(d.name || '', (v) => { n.data.name = v; refreshNodeEl(n); }));
      appendField(container, '值（可使用 ${vars.get("x")}）', inputText(d.value ?? '', (v) => { n.data.value = v; refreshNodeEl(n); }));
      break;

    case 'log':
      appendField(container, '日志级别', selectOne(d.level || 'info', ['info', 'warn', 'error', 'success'], (v) => { n.data.level = v; refreshNodeEl(n); }));
      appendField(container, '消息', inputText(d.message || '', (v) => { n.data.message = v; refreshNodeEl(n); }));
      break;

    case 'procedure': {
      const opts = state.procedures.map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` }));
      appendField(container, '选择任务', selectOne(d.procedureId || '', opts, (v) => {
        n.data.procedureId = v;
        // 选中任务时若还没填网址，自动带入推导到的网址
        if (!n.data.url) {
          const derived = deriveProcUrl(v);
          if (derived.url) n.data.url = derived.url;
        }
        refreshNodeEl(n);
        renderProperties();
      }, '（选择一个任务）'));
      if (d.procedureId) {
        const proc = state.procedures.find((p) => p.id === d.procedureId);
        appendField(container, '目标网址（留空则自动推导）', inputText(d.url || '', (v) => {
          n.data.url = (v || '').trim();
          refreshNodeEl(n);
        }, '留空时使用任务步骤/绑定站点的网址'));
        if (proc) {
          if (proc.kind === 'login') {
            hint(container, '登录任务不能独立运行，请在站点或流程中配合自动化任务使用。');
          } else if (d.url) {
            hint(container, '运行时会在新标签页打开此网址并执行任务步骤。');
          } else {
            const derived = deriveProcUrl(d.procedureId);
            hint(container, derived.url
              ? `留空，将使用${derived.source}的网址：${derived.url}`
              : '未推导到网址，请在此填写目标网址（http/https）。');
          }
          const desc = document.createElement('div');
          desc.className = 'hint';
          desc.innerHTML = `<strong>${escapeHtml(proc.name)}</strong><br>${escapeHtml(proc.description || '无简介')}<br>类型：${proc.kind} · 步骤 ${(proc.steps || []).length} 个`;
          container.appendChild(desc);
          const btn = document.createElement('button');
          btn.className = 'btn btn-sm';
          btn.textContent = '在任务库中编辑';
          btn.style.marginTop = '6px';
          btn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + `#proc/${encodeURIComponent(d.procedureId)}` });
          });
          container.appendChild(btn);
        }
      }
      break;
    }

    case 'site': {
      const opts = state.sites.map((s) => ({ value: s.id, label: s.name }));
      appendField(container, '选择站点', selectOne(d.siteId || '', opts, (v) => {
        n.data.siteId = v; refreshNodeEl(n); renderProperties();
      }, '（选择一个站点）'));
      appendField(container, '', checkbox('强制重新执行（忽略已执行状态）', !!d.force, (v) => { n.data.force = v; }));
      break;
    }
  }

  // 技能按钮
  const actions = document.createElement('div');
  actions.className = 'props-actions';
  actions.innerHTML = `
    <button class="btn" id="propsDuplicate">复制</button>
    <button class="btn btn-error" id="propsDelete">删除</button>
  `;
  container.appendChild(actions);
  $('propsDuplicate').addEventListener('click', () => duplicateNode(n.id));
  $('propsDelete').addEventListener('click', () => removeNode(n.id));
}

function renderEdgeProps(container) {
  const e = findEdge(state.selectedEdgeId);
  if (!e) return;
  const from = findNode(e.from);
  const to = findNode(e.to);
  const desc = document.createElement('div');
  desc.style.fontSize = '12px';
  desc.style.color = '#555';
  desc.style.marginBottom = '10px';
  desc.innerHTML = `连线：<strong>${escapeHtml(typeLabel(from.type).label)}</strong> → <strong>${escapeHtml(typeLabel(to.type).label)}</strong>`;
  container.appendChild(desc);

  appendField(container, '分支条件（用于条件节点）',
    selectOne((e.data && e.data.when) || 'always', [
      { value: 'always', label: '始终（默认）' },
      { value: 'true', label: 'true（条件为真）' },
      { value: 'false', label: 'false（条件为假）' },
    ], (v) => { e.data = e.data || {}; e.data.when = v; renderEdges(); }));
  hint(container, '只有上游是「条件分支」节点时此设置才生效。');

  const del = document.createElement('button');
  del.className = 'btn btn-error';
  del.style.width = '100%';
  del.style.marginTop = '10px';
  del.textContent = '删除连线';
  del.addEventListener('click', () => removeEdge(e.id));
  container.appendChild(del);
}

function refreshNodeEl(n) {
  const el = canvasInner.querySelector(`.node[data-id="${n.id}"]`);
  if (!el) return;
  const def = typeLabel(n.type);
  el.querySelector('.node-header span:nth-child(2)').textContent = n.data.label || def.label;
  el.querySelector('.node-body').innerHTML = nodeSummary(n);
}

// ---------- 表单构造 ----------

function appendField(container, label, control) {
  const f = document.createElement('div');
  f.className = 'field';
  if (label) {
    const l = document.createElement('label');
    l.textContent = label;
    f.appendChild(l);
  }
  f.appendChild(control);
  container.appendChild(f);
  return f;
}

function inputText(value, onInput, placeholder) {
  const i = document.createElement('input');
  i.type = 'text';
  i.value = value || '';
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener('input', () => onInput(i.value));
  return i;
}
function inputNumber(value, onInput) {
  const i = document.createElement('input');
  i.type = 'number';
  i.value = value;
  i.addEventListener('input', () => onInput(parseInt(i.value, 10) || 0));
  return i;
}
function textarea(value, onInput, placeholder) {
  const t = document.createElement('textarea');
  t.value = value || '';
  if (placeholder) t.placeholder = placeholder;
  t.addEventListener('input', () => onInput(t.value));
  return t;
}
function selectOne(value, options, onInput, placeholderLabel) {
  const s = document.createElement('select');
  if (placeholderLabel) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = placeholderLabel;
    s.appendChild(o);
  }
  options.forEach((opt) => {
    const o = document.createElement('option');
    o.value = typeof opt === 'string' ? opt : opt.value;
    o.textContent = typeof opt === 'string' ? opt : opt.label;
    if (o.value === value) o.selected = true;
    s.appendChild(o);
  });
  s.addEventListener('change', () => onInput(s.value));
  return s;
}
function checkbox(label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;';
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.addEventListener('change', () => onChange(c.checked));
  wrap.appendChild(c);
  wrap.append(label);
  return wrap;
}
function hint(container, text) {
  const p = document.createElement('div');
  p.className = 'hint';
  p.textContent = text;
  container.appendChild(p);
}

// =====================================================
//  左侧：任务库
// =====================================================

function renderSidebar() {
  // control
  const pc = $('palette-control');
  pc.innerHTML = '';
  NODE_TYPES.control.forEach((item) => pc.appendChild(makePaletteItem(item)));
  const pb = $('palette-browser');
  pb.innerHTML = '';
  NODE_TYPES.browser.forEach((item) => pb.appendChild(makePaletteItem(item)));

  renderProcList();
}

function makePaletteItem(item) {
  const el = document.createElement('div');
  el.className = 'palette-item';
  el.draggable = true;
  el.innerHTML = `<span class="pi-icon">${item.icon}</span><span>${item.label}</span>`;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/autopage-node', item.type);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return el;
}

function renderProcList() {
  const list = $('procList');
  list.innerHTML = '';
  const filter = $('procFilter').value.trim().toLowerCase();
  const procs = state.procedures.filter((p) => !filter || p.name.toLowerCase().includes(filter));
  if (procs.length === 0) {
    list.innerHTML = '<div class="empty" style="padding:10px; font-size:11px;">暂无任务，请到任务库新建</div>';
    return;
  }
  procs.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'proc-item';
    el.draggable = true;
    el.innerHTML = `
      <div class="pi-name">
        <span class="pi-kind ${p.kind}">${p.kind === 'login' ? '登录' : '任务'}</span>${escapeHtml(p.name)}
      </div>
      <div class="pi-meta">${escapeHtml(p.description || '')}</div>
    `;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/autopage-proc', p.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('click', () => {
      // 单击：在画布中央创建一个引用该任务的节点
      const r = canvas.getBoundingClientRect();
      const pos = canvasPos(r.left + r.width / 2, r.top + r.height / 2);
      addNode('procedure', pos.x - 85, pos.y - 30, { procedureId: p.id, params: {} });
    });
    list.appendChild(el);
  });
}

// =====================================================
//  画布拖放 / 平移 / 缩放
// =====================================================

function bindCanvas() {
  canvas.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/autopage-node') ||
        e.dataTransfer.types.includes('text/autopage-proc')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const pos = canvasPos(e.clientX, e.clientY);
    const nodeType = e.dataTransfer.getData('text/autopage-node');
    const procId = e.dataTransfer.getData('text/autopage-proc');
    if (nodeType) {
      addNode(nodeType, pos.x - 85, pos.y - 30);
    } else if (procId) {
      addNode('procedure', pos.x - 85, pos.y - 30, { procedureId: procId, params: {} });
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.target === canvas || e.target === edgesSvg || e.target.id === 'gridHint') {
      // 点空白：取消选中
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      canvasInner.querySelectorAll('.node').forEach((el) => el.classList.remove('selected'));
      edgesSvg.querySelectorAll('.edge').forEach((el) => el.classList.remove('selected'));
      renderProperties();

      // 中键或空格+左键平移；这里用 Alt+左键平移，普通左键不做平移以免干扰
      if (e.button === 1 || e.altKey) {
        state.pan = { startX: e.clientX, startY: e.clientY, scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop };
        canvas.classList.add('panning');
        e.preventDefault();
      }
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (state.drag) {
      const pos = canvasPos(e.clientX, e.clientY);
      const n = findNode(state.drag.nodeId);
      if (n) {
        n.x = pos.x - state.drag.offsetX;
        n.y = pos.y - state.drag.offsetY;
        const el = canvasInner.querySelector(`.node[data-id="${n.id}"]`);
        if (el) {
          el.style.left = n.x + 'px';
          el.style.top = n.y + 'px';
        }
        renderEdges();
      }
    } else if (state.pan) {
      canvas.scrollLeft = state.pan.scrollLeft - (e.clientX - state.pan.startX);
      canvas.scrollTop = state.pan.scrollTop - (e.clientY - state.pan.startY);
    }
  });

  document.addEventListener('mouseup', () => {
    state.drag = null;
    state.pan = null;
    canvas.classList.remove('panning');
  });

  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') &&
        document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'TEXTAREA' &&
        document.activeElement.tagName !== 'SELECT') {
      if (state.selectedNodeId) removeNode(state.selectedNodeId);
      else if (state.selectedEdgeId) removeEdge(state.selectedEdgeId);
    }
  });

  // Ctrl+滚轮缩放
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(state.zoom + delta);
  }, { passive: false });

  // 右键空白
  canvas.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.node') || e.target.closest('.edge')) return;
    e.preventDefault();
    const pos = canvasPos(e.clientX, e.clientY);
    showContextMenu(e.clientX, e.clientY, [
      { label: '在此添加「调用任务」', action: () => addNode('procedure', pos.x - 85, pos.y - 30) },
      { label: '在此添加「条件」', action: () => addNode('condition', pos.x - 85, pos.y - 30) },
      { label: '在此添加「延时」', action: () => addNode('delay', pos.x - 85, pos.y - 30) },
      { hr: true },
      { label: '适应窗口', action: () => fitView() },
    ]);
  });
}

function setZoom(z) {
  state.zoom = Math.max(0.3, Math.min(2, z));
  canvasInner.style.transform = `scale(${state.zoom})`;
  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
}

function fitView() {
  if (state.flow.nodes.length === 0) return;
  const minX = Math.min(...state.flow.nodes.map((n) => n.x));
  const minY = Math.min(...state.flow.nodes.map((n) => n.y));
  const maxX = Math.max(...state.flow.nodes.map((n) => n.x + 240));
  const maxY = Math.max(...state.flow.nodes.map((n) => n.y + 100));
  const r = canvas.getBoundingClientRect();
  const z = Math.min((r.width - 40) / (maxX - minX), (r.height - 40) / (maxY - minY), 1);
  setZoom(z);
  canvas.scrollLeft = minX * z - 20;
  canvas.scrollTop = minY * z - 20;
}

// =====================================================
//  右键菜单
// =====================================================

let ctxMenuEl = null;
function showContextMenu(x, y, items) {
  closeContextMenu();
  ctxMenuEl = document.createElement('div');
  ctxMenuEl.className = 'ctx-menu';
  items.forEach((it) => {
    if (it.hr) {
      ctxMenuEl.appendChild(document.createElement('hr'));
      return;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.addEventListener('click', () => {
      closeContextMenu();
      it.action();
    });
    ctxMenuEl.appendChild(b);
  });
  ctxMenuEl.style.left = x + 'px';
  ctxMenuEl.style.top = y + 'px';
  document.body.appendChild(ctxMenuEl);
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}
function closeContextMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}

// =====================================================
//  顶部工具栏
// =====================================================

function renderFlowSelect() {
  const sel = $('flowSelect');
  sel.innerHTML = '';
  state.flows.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.name;
    sel.appendChild(o);
  });
  if (state.currentFlowId) sel.value = state.currentFlowId;
}

function bindToolbar() {
  $('flowSelect').addEventListener('change', (e) => selectFlow(e.target.value));
  $('btnNewFlow').addEventListener('click', () => createNewFlow(true));
  $('btnSaveFlow').addEventListener('click', saveCurrentFlow);
  $('btnDeleteFlow').addEventListener('click', deleteCurrentFlow);
  $('btnRunFlow').addEventListener('click', runCurrentFlow);
  $('btnStopFlow').addEventListener('click', stopCurrentFlow);
  $('btnExport').addEventListener('click', exportFlow);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importFlow(e.target.files[0]);
    e.target.value = '';
  });
  $('btnZoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
  $('btnZoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
  $('btnZoomReset').addEventListener('click', () => setZoom(1));
  $('btnRefreshProcs').addEventListener('click', async () => {
    const res = await send(MSG.PROCEDURE_LIST);
    state.procedures = res.procedures || [];
    renderProcList();
    renderNodes();
  });
  $('procFilter').addEventListener('input', renderProcList);

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('tab-active'));
      document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('tab-active');
      $('panel-' + t.dataset.tab).classList.add('active');
    });
  });
  $('btnClearLog').addEventListener('click', () => { $('logBody').innerHTML = ''; });
}

// =====================================================
//  执行
// =====================================================

async function runCurrentFlow() {
  if (!state.flow || state.running) return;

  const runBtn = $('btnRunFlow');
  const restoreBtn = () => {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = runBtn.dataset.orig || '▶ 运行'; }
  };

  // 自动切到日志面板，否则点了运行像没反应
  showPanel('logs');
  $('logBody').innerHTML = '';

  state.variables = { ...(state.flow.variables || {}) };
  state.abortCtrl = { aborted: false };
  log('info', `===== 开始执行：${state.flow.name} =====`);

  // 标记复位
  state.flow.nodes.forEach((n) => {
    const el = canvasInner.querySelector(`.node[data-id="${n.id}"]`);
    if (el) el.classList.remove('running', 'done', 'failed');
  });

  const start = state.flow.nodes.find((n) => n.type === 'start');
  if (!start) {
    log('error', '没有开始节点');
    state.abortCtrl = null;
    return;
  }
  const startEdges = state.flow.edges.filter((e) => e.from === start.id);
  if (startEdges.length === 0) {
    log('warn', '开始节点没有连线，请从开始节点的右侧端口拖出一条连线');
  }

  state.running = true;
  if (runBtn) { runBtn.disabled = true; runBtn.dataset.orig = runBtn.textContent; runBtn.textContent = '运行中…'; }

  // 先保存（失败不阻断运行，仅告警）
  try {
    await saveCurrentFlow();
  } catch (e) {
    log('warn', '自动保存失败，仍继续运行：' + e.message);
  }

  try {
    await walk(start.id, new Set());
    log('success', '===== 执行完成 =====');
  } catch (e) {
    log('error', '执行失败：' + e.message);
  } finally {
    state.running = false;
    state.abortCtrl = null;
    restoreBtn();
    renderVariables();
  }
}

function showPanel(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('tab-active', x.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
  const panel = $('panel-' + name);
  if (panel) panel.classList.add('active');
}

function stopCurrentFlow() {
  if (state.abortCtrl) state.abortCtrl.aborted = true;
  log('warn', '用户请求停止...');
}

async function walk(nodeId, visitedEdges) {
  if (state.abortCtrl.aborted) return;
  const node = findNode(nodeId);
  if (!node) return;

  markNode(nodeId, 'running');
  log('info', `▶ ${typeLabel(node.type).label}${node.data.label ? ' · ' + node.data.label : ''}`);
  // 让浏览器有机会把节点绘制成"运行中"，否则瞬时节点看不到状态变化
  await sleep(30);

  let branch = null;
  try {
    branch = await execNode(node);
  } catch (e) {
    markNode(nodeId, 'failed');
    throw e;
  }
  markNode(nodeId, 'done');

  if (branch === '__stop__') return;

  let edges = state.flow.edges.filter((e) => e.from === nodeId);
  if (node.type === 'condition') {
    const want = branch === false ? 'false' : 'true';
    const matching = edges.filter((e) => (e.data && e.data.when) === want);
    edges = matching.length ? matching : edges.filter((e) => !e.data || !e.data.when || e.data.when === 'always');
  }

  if (node.type === 'parallel') {
    await Promise.all(edges.map((e) => walk(e.to, new Set(visitedEdges))));
    return;
  }

  for (const e of edges) {
    if (state.abortCtrl.aborted) return;
    if (visitedEdges.has(e.id) && node.type !== 'loop') continue;
    visitedEdges.add(e.id);
    await walk(e.to, visitedEdges);
  }
}

function markNode(id, cls) {
  const el = canvasInner.querySelector(`.node[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('running', 'done', 'failed');
  if (cls) el.classList.add(cls);
}

function interpolate(str) {
  if (str == null) return '';
  return String(str).replace(/\$\{([^}]+)\}/g, (_, expr) => {
    try {
      // eslint-disable-next-line no-new-func
      return Function('vars', `return (${expr});`)(state.variables);
    } catch { return ''; }
  });
}

// 推导任务的目标网址：任务内首个跳转步骤 → 绑定了该任务的站点网址
function deriveProcUrl(procedureId) {
  const proc = state.procedures.find((p) => p.id === procedureId);
  if (proc && Array.isArray(proc.steps)) {
    const goto = proc.steps.find((s) => s && (s.type === 'goto' || s.type === 'waitForUrl') && (s.url || s.selector));
    if (goto) {
      const u = String(goto.url || goto.selector || '').trim();
      if (u) return { url: u, source: '任务步骤' };
    }
  }
  const site = state.sites.find((s) => s.checkinProcedureId === procedureId && s.url);
  if (site) return { url: site.url, source: `站点「${site.name}」` };
  return { url: '', source: '' };
}

async function execNode(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'start':
    case 'end':
    case 'parallel':
      return null;

    case 'delay': {
      const ms = parseInt(interpolate(d.ms || '1000'), 10) || 1000;
      log('info', `等待 ${ms}ms`);
      await sleep(ms);
      return null;
    }

    case 'variable': {
      if (d.name) {
        state.variables[d.name] = interpolate(d.value ?? '');
        log('info', `变量 ${d.name} = ${state.variables[d.name]}`);
        renderVariables();
      }
      return null;
    }

    case 'log': {
      log(d.level || 'info', interpolate(d.message || ''));
      return null;
    }

    case 'condition': {
      let result = false;
      try {
        // eslint-disable-next-line no-new-func
        result = !!Function('vars', `return (${d.expr || 'false'});`)(state.variables);
      } catch (e) {
        log('error', `条件表达式错误：${e.message}`);
      }
      log('info', `条件 = ${result}`);
      return result;
    }

    case 'loop': {
      const count = parseInt(interpolate(d.count || '1'), 10) || 1;
      const loopVar = d.loopVar || 'i';
      const edges = state.flow.edges.filter((e) => e.from === node.id);
      const bodyEdge = edges[0];
      const restEdges = edges.slice(1);
      log('info', `循环 ${count} 次`);
      if (bodyEdge) {
        for (let i = 0; i < count; i++) {
          if (state.abortCtrl.aborted) return '__stop__';
          state.variables[loopVar] = i;
          log('info', `-- 第 ${i + 1}/${count} 次 --`);
          await walk(bodyEdge.to, new Set());
        }
      }
      for (const e of restEdges) await walk(e.to, new Set());
      return '__stop__';
    }

    case 'procedure': {
      if (!d.procedureId) throw new Error('未选择任务');
      const proc = state.procedures.find((p) => p.id === d.procedureId);
      if (!proc) throw new Error('任务不存在（可能已被删除）');
      if (proc.kind === 'login') {
        throw new Error('登录任务不能独立运行，请改用「执行站点」或在站点中绑定登录任务');
      }
      const url = (interpolate(d.url || '') || '').trim() || deriveProcUrl(d.procedureId).url;
      if (url) {
        log('info', `调用任务：${proc.name}（${(proc.steps || []).length} 个步骤）→ ${url}`);
      } else {
        log('info', `调用任务：${proc.name}（${(proc.steps || []).length} 个步骤）`);
      }
      if (d.params && typeof d.params === 'object') {
        const mapped = Object.fromEntries(
          Object.entries(d.params).map(([k, v]) => [k, interpolate(v)])
        );
        if (Object.keys(mapped).length) log('info', `参数：${JSON.stringify(mapped)}`);
      }
      const res = await send(MSG.RUN_PROCEDURE, { procedureId: d.procedureId, url, keepTab: false });
      if (!res || res.ok === false) {
        throw new Error((res && res.message) || '任务执行失败');
      }
      log(res.ok ? 'success' : 'error', `任务结果：${res.message || (res.ok ? '成功' : '失败')}`);
      return null;
    }

    case 'site': {
      if (!d.siteId) throw new Error('未选择站点');
      const site = state.sites.find((s) => s.id === d.siteId);
      if (!site) throw new Error('站点不存在');
      log('info', `派发执行站点：${site.name}`);
      const res = await send(MSG.RUN_SITE, { siteId: site.id, force: !!d.force });
      log('info', `已入队：${res.queued} 个`);
      return null;
    }
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// =====================================================
//  日志 / 变量
// =====================================================

function log(level, msg) {
  const line = document.createElement('div');
  line.className = 'log-line ' + (level || 'info');
  const t = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="ll-time">${t}</span>${escapeHtml(msg)}`;
  $('logBody').appendChild(line);
  $('logBody').scrollTop = $('logBody').scrollHeight;
}

function renderVariables() {
  const body = $('varsBody');
  body.innerHTML = '';
  const keys = Object.keys(state.variables);
  if (keys.length === 0) {
    body.innerHTML = '<div class="empty">暂无变量</div>';
    return;
  }
  keys.forEach((k) => {
    const row = document.createElement('div');
    row.className = 'var-row';
    row.innerHTML = `<span class="vk">${escapeHtml(k)}</span><span class="vv">${escapeHtml(String(state.variables[k]))}</span>`;
    body.appendChild(row);
  });
}

// =====================================================
//  导入 / 导出
// =====================================================

function exportFlow() {
  if (!state.flow) return;
  const blob = new Blob([JSON.stringify(state.flow, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.flow.name || 'flow'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importFlow(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('文件格式不正确');
      data.id = 'flow_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      data.name = (data.name || '导入的流程') + ' (导入)';
      const res = await send(MSG.FLOW_SAVE, { flow: data });
      state.flows.push(res.flow);
      renderFlowSelect();
      selectFlow(res.flow.id);
      log('success', '导入成功');
    } catch (err) {
      alert('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
}

// =====================================================
//  启动
// =====================================================

async function init() {
  renderSidebar();
  bindCanvas();
  bindToolbar();
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    log('error', '加载失败：' + e.message);
  }
  renderFlowSelect();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
