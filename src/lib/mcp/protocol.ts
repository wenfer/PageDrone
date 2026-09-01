/**
 * MCP 协议层：JSON-RPC 消息封装与对外工具清单声明。
 * 工具分组沿用 SKILLS 表语义：read / write / browser / exec（exec 为 MCP 新增组）。
 */

import type { McpAuthMode } from './config.js';

export type McpToolGroup = 'read' | 'write' | 'browser' | 'exec';

export interface McpToolDef {
  name: string;
  group: McpToolGroup;
  description: string;
  inputSchema: Record<string, unknown>;
}

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
const str = (description: string) => ({ type: 'string', description });
const num = (description: string, minimum?: number, maximum?: number) => ({
  type: 'integer',
  description,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const bool = (description: string) => ({ type: 'boolean', description });

/** 当前授权模式下可用的工具组 */
export function groupsForMode(mode: McpAuthMode): McpToolGroup[] {
  if (mode === 'readonly') return ['read'];
  if (mode === 'standard') return ['read', 'exec', 'browser'];
  return ['read', 'write', 'browser', 'exec'];
}

export const MCP_TOOLS: readonly McpToolDef[] = [
  // —— read ——
  {
    name: 'list-sites',
    group: 'read',
    description: '列出全部已配置站点（含 enabled、最近执行结果摘要）',
    inputSchema: obj({}),
  },
  {
    name: 'get-site',
    group: 'read',
    description: '读取单个站点完整配置、三个默认技能入口与最近执行结果',
    inputSchema: obj({ siteId: str('站点 id，来自 list-sites') }, ['siteId']),
  },
  {
    name: 'list-procedures',
    group: 'read',
    description: '列出全部技能（Procedure）摘要；修改前先拿真实 id',
    inputSchema: obj({}),
  },
  {
    name: 'get-procedure',
    group: 'read',
    description: '读取单个技能的完整步骤、判定条件、返回契约与最近结果',
    inputSchema: obj({ procedureId: str('技能 id') }, ['procedureId']),
  },
  {
    name: 'list-flows',
    group: 'read',
    description: '列出全部流程（Flow）及其节点引用',
    inputSchema: obj({}),
  },
  {
    name: 'get-flow',
    group: 'read',
    description: '读取流程完整节点、连线和变量',
    inputSchema: obj({ flowId: str('流程 id') }, ['flowId']),
  },
  {
    name: 'list-logs',
    group: 'read',
    description: '查看最近的本地执行日志，可按站点筛选',
    inputSchema: obj({
      siteId: str('可选：只看该站点'),
      limit: num('返回条数，默认 20，最多 50', 1, 50),
    }),
  },
  {
    name: 'get-status',
    group: 'read',
    description: '获取扩展运行状态：队列状态、当前运行态 runtime',
    inputSchema: obj({}),
  },

  // —— write ——
  {
    name: 'create-site',
    group: 'write',
    description: '创建站点并绑定默认技能入口',
    inputSchema: obj(
      {
        name: str('站点名称'),
        url: str('站点网址 http(s)://'),
        checkinProcedureId: str('自动化技能 id'),
        loginProcedureId: str('登录技能 id'),
        verificationProcedureId: str('验证技能 id'),
        scheduleEnabled: bool('是否每日定时'),
        scheduleHour: num('定时小时 0-23', 0, 23),
        scheduleMinute: num('定时分钟 0-59', 0, 59),
      },
      ['name', 'url'],
    ),
  },
  {
    name: 'update-site',
    group: 'write',
    description: '更新已有站点配置',
    inputSchema: obj(
      {
        siteId: str('站点 id'),
        name: str('名称'),
        url: str('网址'),
        enabled: bool('是否启用'),
        checkinProcedureId: str('自动化技能 id'),
        loginProcedureId: str('登录技能 id；空串取消绑定'),
        verificationProcedureId: str('验证技能 id；空串取消绑定'),
        scheduleEnabled: bool('是否每日定时'),
        scheduleHour: num('定时小时', 0, 23),
        scheduleMinute: num('定时分钟', 0, 59),
      },
      ['siteId'],
    ),
  },
  {
    name: 'create-procedure',
    group: 'write',
    description: '创建一个归属于指定站点的技能；之后用 add-step 添加标准动作步骤',
    inputSchema: obj(
      {
        name: str('技能名称'),
        siteId: str('所属网站 id'),
        kind: { type: 'string', enum: ['checkin', 'login', 'verification'], description: '技能种类' },
        url: str('目标网址'),
        description: str('说明'),
        clearSteps: bool('是否清空工厂示例步骤，默认 true'),
        outputEnabled: bool('是否启用返回值契约'),
        outputFields: { type: 'array', items: { type: 'string' }, description: '要返回的结果字段名' },
      },
      ['name', 'siteId', 'kind'],
    ),
  },
  {
    name: 'add-step',
    group: 'write',
    description: '向技能末尾追加一个标准动作步骤（click/type/goto/wait/waitFor/waitForText/waitForUrl/manual/extract）',
    inputSchema: obj(
      {
        procedureId: str('技能 id'),
        step: { type: 'object', description: '步骤对象，必须含 type 字段与该类型的必填字段' },
      },
      ['procedureId', 'step'],
    ),
  },
  {
    name: 'update-step',
    group: 'write',
    description: '整体替换技能中某一个步骤（不是局部合并）',
    inputSchema: obj(
      {
        procedureId: str('技能 id'),
        stepIndex: num('步骤下标，从 0 开始', 0),
        step: { type: 'object', description: '新的完整步骤对象' },
      },
      ['procedureId', 'stepIndex', 'step'],
    ),
  },
  {
    name: 'remove-step',
    group: 'write',
    description: '删除技能中某一个步骤',
    inputSchema: obj({ procedureId: str('技能 id'), stepIndex: num('步骤下标', 0) }, [
      'procedureId',
      'stepIndex',
    ]),
  },
  {
    name: 'replace-steps',
    group: 'write',
    description: '整体替换技能的标准操作序列（覆盖原步骤；仅在用户明确要求重写时使用）',
    inputSchema: obj(
      { procedureId: str('技能 id'), steps: { type: 'array', items: { type: 'object' }, description: '步骤数组' } },
      ['procedureId', 'steps'],
    ),
  },
  {
    name: 'update-procedure',
    group: 'write',
    description: '修改技能名称、说明、目标网址或自定义脚本（clearScript=true 清空脚本）',
    inputSchema: obj(
      {
        procedureId: str('技能 id'),
        name: str('名称'),
        description: str('说明'),
        url: str('目标网址'),
        script: str('自定义脚本'),
        clearScript: bool('清空现有脚本'),
      },
      ['procedureId'],
    ),
  },
  {
    name: 'set-detect',
    group: 'write',
    description: '设置技能结果判定条件（checkin 关键词 / login 登录态 / verification 完成信号）',
    inputSchema: obj({
      procedureId: str('技能 id'),
      successKeywords: { type: 'array', items: { type: 'string' }, description: '仅 checkin' },
      failKeywords: { type: 'array', items: { type: 'string' }, description: '仅 checkin' },
      loggedInSelector: str('仅 login'),
      loggedInUrlIncludes: str('仅 login'),
      loginUrlPattern: str('登录页网址特征'),
      notLoggedInKeywords: { type: 'array', items: { type: 'string' }, description: '仅 login' },
      completedSelector: str('仅 verification'),
      completedUrlIncludes: str('仅 verification'),
    }, ['procedureId']),
  },
  {
    name: 'set-output',
    group: 'write',
    description: '配置技能是否返回数据以及要暴露的提取结果字段',
    inputSchema: obj(
      {
        procedureId: str('技能 id'),
        enabled: bool('是否启用返回值'),
        fields: { type: 'array', items: { type: 'string' }, description: '字段名；留空返回全部' },
      },
      ['procedureId', 'enabled'],
    ),
  },
  {
    name: 'create-flow',
    group: 'write',
    description: '创建流程（画布节点图），可按技能 id 串行编排或圈定全部站点',
    inputSchema: obj({
      name: str('流程名称'),
      description: str('说明'),
      procedureIds: { type: 'array', items: { type: 'string' }, description: '串行执行的技能 id' },
      siteScope: { type: 'string', enum: ['explicit', 'all-sites'], description: 'explicit 用 procedureIds；all-sites 圈当前站点' },
      includeDisabled: bool('all-sites 时含禁用站点'),
      includeMissingSiteId: bool('包含无 siteId 的旧技能'),
      includeLoginProcedures: bool('包含登录技能'),
      autoSyncSites: bool('执行前自动追加新站点'),
    }, ['name']),
  },
  {
    name: 'update-flow-node',
    group: 'write',
    description: '定点合并修改流程中一个节点的 data 配置；修改后必须重新测试流程',
    inputSchema: obj(
      {
        flowId: str('流程 id'),
        nodeId: str('节点 id'),
        data: { type: 'object', description: '要合并进节点 data 的字段' },
      },
      ['flowId', 'nodeId', 'data'],
    ),
  },

  // —— exec ——
  {
    name: 'run-all',
    group: 'exec',
    description: '将全部已启用站点加入执行队列（进入同一全局串行队列），立即返回 executionId',
    inputSchema: obj({}),
  },
  {
    name: 'run-site',
    group: 'exec',
    description: '将单个站点加入执行队列，立即返回 executionId',
    inputSchema: obj({ siteId: str('站点 id'), force: bool('强制立即执行（跳过部分节流判断）') }, ['siteId']),
  },
  {
    name: 'run-procedure',
    group: 'exec',
    description: '在独立标签页真实执行一个技能（非诊断模式，会写回执行结果），立即返回 executionId',
    inputSchema: obj(
      {
        procedureId: str('技能 id'),
        siteId: str('技能归属站点 id，用于校验'),
        url: str('可选：本次执行目标网址'),
        timeoutMs: num('总超时毫秒', 1000, 600000),
      },
      ['procedureId'],
    ),
  },
  {
    name: 'run-flow',
    group: 'exec',
    description: '打开隔离画布用正式流程引擎执行流程（诊断语义，不写执行日志），立即返回 executionId',
    inputSchema: obj({ flowId: str('流程 id') }, ['flowId']),
  },
  {
    name: 'get-execution',
    group: 'exec',
    description: '查询异步作业状态与进度；waitMs>0 时阻塞至终态或超时（长轮询）',
    inputSchema: obj(
      { executionId: str('executionId'), waitMs: num('长轮询等待毫秒', 0, 300000) },
      ['executionId'],
    ),
  },
  {
    name: 'abort-execution',
    group: 'exec',
    description: '取消一个进行中的作业（技能独立运行 / 站点队列 / 流程测试 / 探索）并清理标签页',
    inputSchema: obj({ executionId: str('executionId') }, ['executionId']),
  },
  {
    name: 'http-request',
    group: 'exec',
    description: '由调用方显式给出的 HTTP 请求（在扩展 Service Worker 中发出）',
    inputSchema: obj({
      url: str('http(s) 地址'),
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: '默认 GET' },
      headers: { type: 'object', description: '请求头键值对' },
      body: { description: '字符串或可 JSON 序列化对象；GET/HEAD 忽略' },
      timeoutMs: num('超时毫秒，默认 30000，上限 120000', 1000, 120000),
    }, ['url']),
  },

  // —— browser ——
  {
    name: 'navigate',
    group: 'browser',
    description: '打开、复用或接管受管标签页跳转到指定 URL（支持 managed-new/managed-reuse/current-active）',
    inputSchema: obj(
      {
        url: str('目标网址 http(s)://；若使用 current-active 且不提供 url 则直接接管当前活跃标签页'),
        tabMode: { type: 'string', enum: ['managed-new', 'managed-reuse', 'current-active'], description: '默认 managed-new' },
      },
    ),
  },
  {
    name: 'read-page',
    group: 'browser',
    description: '读取受管标签页当前状态：URL/标题/正文/可交互元素（含坐标、视口可见性、角色），支持 compact 极简文本树',
    inputSchema: obj({
      includeElements: bool('默认 true'),
      textMaxLength: num('正文截断长度，默认 2000', 100, 30000),
      elementLimit: num('元素数量上限，默认 50，最多 200', 1, 200),
      inViewportOnly: bool('仅返回当前视口内的可见元素，默认 false'),
      format: { type: 'string', enum: ['detailed', 'compact', 'elements_only'], description: '输出格式：detailed 详细全量，compact 极简文本树，elements_only 仅元素' },
      selectorScope: str('限定采样区域的选择器（CSS/XPath）'),
    }),
  },
  {
    name: 'screenshot',
    group: 'browser',
    description: '捕获受管标签页的可视区域截图，直接返回多模态大模型可识别的图像数据；可附带元素选择器获取其精准坐标',
    inputSchema: obj({
      selector: str('可选：高亮/定位的元素选择器'),
      format: { type: 'string', enum: ['png', 'jpeg'], description: '图像格式，默认 png' },
      quality: num('JPEG 质量 1-100，默认 80', 1, 100),
    }),
  },
  {
    name: 'get-page-outline',
    group: 'browser',
    description: '获取页面宏观大纲：标题层级结构（H1-H6）、表单及输入字段、主要导航链接、Meta 元数据',
    inputSchema: obj({}),
  },
  {
    name: 'click',
    group: 'browser',
    description: '点击元素；返回 ok + confirmed 两级结果（confirmed=false 表示事件已派发但页面变化未证实）',
    inputSchema: obj(
      {
        selector: str('来自 read-page 的已转义选择器（CSS 或 xpath:// 前缀 XPath）'),
        watchPopup: bool('监视新标签页并在其上继续，默认 true'),
        followPopup: bool('接管新标签页作为后续操作的受管页'),
        timeoutMs: num('等待元素超时，默认 15000', 1000, 120000),
      },
      ['selector'],
    ),
  },
  {
    name: 'hover',
    group: 'browser',
    description: '鼠标悬停在指定元素上（触发 mouseover/mouseenter/pointerover/mousemove），用于展开下拉菜单或浮层提示',
    inputSchema: obj(
      {
        selector: str('元素选择器'),
        timeoutMs: num('等待元素超时，默认 10000', 1000, 120000),
      },
      ['selector'],
    ),
  },
  {
    name: 'type',
    group: 'browser',
    description: '向输入框写入文本并派发 input/change 事件（密码字段禁止写入）',
    inputSchema: obj(
      { selector: str('输入框选择器'), text: str('要输入的文本'), timeoutMs: num('等待元素超时', 1000, 120000) },
      ['selector', 'text'],
    ),
  },
  {
    name: 'clear-input',
    group: 'browser',
    description: '清空输入框已有内容并派发 input/change 事件',
    inputSchema: obj({ selector: str('输入框选择器') }, ['selector']),
  },
  {
    name: 'press-key',
    group: 'browser',
    description: '派发键盘按键事件（如 Enter 提交、Tab 切换焦点、Escape 关闭浮层、Backspace、ArrowDown 等）',
    inputSchema: obj(
      {
        key: str('按键名称，如 Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, Space 等'),
        selector: str('可选：派发按键的目标元素，留空则发送给当前聚焦元素'),
        ctrl: bool('是否同时按下 Ctrl 键'),
        alt: bool('是否同时按下 Alt 键'),
        shift: bool('是否同时按下 Shift 键'),
        meta: bool('是否同时按下 Meta/Command 键'),
      },
      ['key'],
    ),
  },
  {
    name: 'scroll-page',
    group: 'browser',
    description: '滚动浏览页面或指定容器（支持上下左右、顶部、底部、或滚动到指定元素）',
    inputSchema: obj({
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom', 'toElement'], description: '滚动方向，默认 down' },
      distance: num('滚动像素距离，默认 500', 1, 10000),
      selector: str('可选：滚动特定容器，或者当 direction=toElement 时要滚动至视口的元素选择器'),
    }),
  },
  {
    name: 'select-option',
    group: 'browser',
    description: '在下拉框（<select> 元素）中选择选项，按 value、文本或下标匹配',
    inputSchema: obj(
      {
        selector: str('<select> 元素选择器'),
        value: str('要选中的 option value 属性值'),
        label: str('要选中的 option 可见文本'),
        index: num('要选中的 option 索引（从 0 开始）', 0),
      },
      ['selector'],
    ),
  },
  {
    name: 'click-coordinate',
    group: 'browser',
    description: '直接向视口中的 (x, y) 坐标派发完整点击事件（适用于 Canvas、图表、无文本图标或复杂交互）',
    inputSchema: obj(
      {
        x: num('水平坐标 X（像素）', 0),
        y: num('垂直坐标 Y（像素）', 0),
      },
      ['x', 'y'],
    ),
  },
  {
    name: 'batch-actions',
    group: 'browser',
    description: '一次性批量串行执行多个页面动作（如 type -> wait -> press-key），大幅减少 MCP 往返延迟',
    inputSchema: obj(
      {
        actions: {
          type: 'array',
          items: { type: 'object', description: '动作对象，需含 type（click/hover/type/clear/pressKey/scroll/selectOption/clickCoordinate/wait/waitFor/waitForText）' },
          description: '按序执行的动作数组',
        },
        stopOnError: bool('遇到错误时是否立即停止，默认 true'),
      },
      ['actions'],
    ),
  },
  {
    name: 'wait',
    group: 'browser',
    description: '固定等待若干毫秒',
    inputSchema: obj({ ms: num('等待毫秒', 0, 120000) }, ['ms']),
  },
  {
    name: 'wait-for-text',
    group: 'browser',
    description: '等待页面出现指定文本（body 或指定选择器内）',
    inputSchema: obj(
      { selector: str('可选：限定范围选择器'), includes: str('要等待的文本'), timeoutMs: num('超时毫秒，默认 15000', 1000, 120000) },
      ['includes'],
    ),
  },
  {
    name: 'wait-for-url',
    group: 'browser',
    description: '等待受管标签页 URL 匹配子串或 /正则/ 格式',
    inputSchema: obj(
      { match: str('URL 子串或 /regex/flags'), timeoutMs: num('超时毫秒，默认 30000', 1000, 120000) },
      ['match'],
    ),
  },
  {
    name: 'extract',
    group: 'browser',
    description: '按 CSS/XPath 提取结构化数据（text/attribute/html/value/list/table）',
    inputSchema: obj(
      {
        selector: str('CSS/XPath 选择器'),
        mode: { type: 'string', enum: ['text', 'attribute', 'html', 'value', 'list', 'table'], description: '提取模式' },
        attribute: str('attribute 模式的属性名'),
        multiple: bool('取全部匹配，默认 true'),
      },
      ['selector'],
    ),
  },
  {
    name: 'list-tabs',
    group: 'browser',
    description: '查看浏览器当前所有标签页（ID、标题、URL、是否当前受管页）',
    inputSchema: obj({}),
  },
  {
    name: 'switch-tab',
    group: 'browser',
    description: '切换受管标签页至指定 tabId，并前台激活该标签页',
    inputSchema: obj({ tabId: num('标签页 ID') }, ['tabId']),
  },
  {
    name: 'new-tab',
    group: 'browser',
    description: '打开新标签页并设为受管标签页',
    inputSchema: obj({ url: str('目标网址 http(s)://') }, ['url']),
  },
  {
    name: 'go-back',
    group: 'browser',
    description: '后退至上一页面',
    inputSchema: obj({}),
  },
  {
    name: 'go-forward',
    group: 'browser',
    description: '前进至下一页面',
    inputSchema: obj({}),
  },
  {
    name: 'reload-page',
    group: 'browser',
    description: '刷新当前受管标签页',
    inputSchema: obj({ ignoreCache: bool('是否忽略缓存强制刷新，默认 false') }),
  },
  {
    name: 'close-tab',
    group: 'browser',
    description: '关闭当前受管标签页',
    inputSchema: obj({}),
  },
  {
    name: 'explore-and-create-procedure',
    group: 'browser',
    description:
      '高阶工具：LLM 反复「观察页面→决策→操作」直到达成目标，并把确认过的操作固化为归属指定站点的技能。开销大（多轮 LLM + 真实操作），需已在扩展中配置 AI API Key',
    inputSchema: obj(
      {
        url: str('起始网址 http(s)://'),
        siteId: str('生成技能所属网站 id'),
        goal: str('目标描述'),
        successKeywords: { type: 'array', items: { type: 'string' }, description: '成功判定关键词' },
      },
      ['url', 'siteId', 'goal'],
    ),
  },
];

export const MCP_TOOL_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

// —— JSON-RPC 封装 ——

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/** 把 MCP 工具执行结果包装为 MCP tools/call 的标准 result（支持多模态图片返回） */
export function toolCallResult(data: unknown, isError = false): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [];

  if (data && typeof data === 'object' && '__mcpImage' in (data as Record<string, unknown>)) {
    const imgObj = (data as Record<string, unknown>).__mcpImage as { data: string; mimeType: string };
    if (imgObj && typeof imgObj.data === 'string' && typeof imgObj.mimeType === 'string') {
      contents.push({
        type: 'image',
        data: imgObj.data,
        mimeType: imgObj.mimeType,
      });
    }

    const cleanData = { ...(data as Record<string, unknown>) };
    delete cleanData.__mcpImage;
    delete cleanData.base64;
    delete cleanData.dataUrl;

    contents.push({
      type: 'text',
      text: JSON.stringify(cleanData, null, 2),
    });

    return { content: contents, isError };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(data ?? {}, null, 2) }],
    isError,
  };
}
