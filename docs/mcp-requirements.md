# 《MCP 服务功能需求文档》

> 状态：需求设计稿（本文档只描述需求与方案，不含实现）
> 适用产品：PageDrone —— Chrome MV3 浏览器自动化扩展
> 文档版本：v0.1（2026-08-24）
> 命名约定：遵循 AGENTS.md 铁律 —— Procedure=**技能**、Flow=**流程**、Site=**站点**；底层浏览器行为称"操作"。

---

## 1. 产品定位与用户场景

### 1.1 定位一句话

为 PageDrone 增加 **MCP（Model Context Protocol）服务能力**，让任意外部 AI Agent（Claude Desktop、Cursor、自研 agent 等）通过标准 MCP 协议连接本扩展，获得"**浏览网页、读取分析页面内容、在真实浏览器中执行操作、复用既有技能/流程资产**"的能力。

核心价值主张：

1. **真实浏览器环境**：外部 agent 操控的是用户自己的 Chrome 配置（已有登录态、Cookie、扩展），而不是无头的隔离实例。这是相对 Playwright/Puppeteer MCP 的差异化。
2. **资产复用**：用户已在扩展内沉淀的技能（Procedure）、流程（Flow）、站点（Site）、登录态检测与自动重登能力，直接成为外部 agent 可调用的稳定原语，agent 无需从零探索页面。
3. **双向增益**：外部 agent 也能反过来创建/修复技能（复用现有 AI 工具语义），让"一次探索、永久沉淀"的闭环从扩展内置 AI 对话扩展到任意 MCP 客户端。

### 1.2 典型用户场景

| # | 场景 | 外部 agent 的做法 |
|---|------|------------------|
| S1 | 用户对 Claude Desktop 说："帮我看看 GitHub 通知页有什么未读，总结一下" | agent 调用 `navigate` 打开页面 → `read-page` 提取内容 → 总结 |
| S2 | "每天帮我跑一遍所有站点的自动化" | agent 调用 `run-all` 或逐个 `run-site`，用 `get-execution` 轮询进度 |
| S3 | "我配置的那个签到技能最近老失败，你看看" | agent 调 `list-logs` 查日志 → `get-procedure` 读技能 → `test-procedure` 诊断 → `update-step` 修复 → 复测 |
| S4 | Cursor 里开发爬虫脚本："从这个商品列表页提取名称和价格" | agent 用 `read-page` / `extract` 在真实登录态下取数 |
| S5 | 多 agent 协作：编排系统把 PageDrone 当作"浏览器执行器"节点 | 通过 MCP 工具下发操作序列并订阅进度通知 |

### 1.3 目标用户与前提

- 已安装 PageDrone 扩展并在本机运行一个 MCP 客户端（或愿意运行一个本地桥接进程，见 §3）。
- 明确知晓并主动开启"MCP 服务"开关（默认关闭），见 §5 安全边界。

---

## 2. 现有功能清单（结构化盘点）

以下是本次设计所依赖的现状盘点，来源：README.md、AGENTS.md 与源码（`src/lib/*`、`entrypoints/*`）。

### 2.1 领域模型（`src/lib/models.ts`，存储于 `chrome.storage.local`）

| 模型 | 存储键 | 关键字段 | 说明 |
|---|---|---|---|
| Site 站点 | `sites` | url、name、checkin/login/verificationProcedureId、schedule、lastResult、enabled | 目标网址 + 默认技能入口 + 定时配置 |
| Procedure 技能 | `procedures` | siteId、kind(checkin/login/verification)、steps[]、detect(登录判定)、output(返回契约) | 归属单网站的可复用步骤集合 |
| Flow 流程 | `flows` | nodes[]、edges[]（条件 true/false/always 分支） | 画布节点图，支持条件/循环/并行/变量/延时/HTTP 请求 |
| Task 执行批次 | `tasks` | trigger(manual/schedule/single)、state | 日志分组单位 |
| Log 执行日志 | `logs` | siteId、status、message、cfWaitedMs、耗时 | 单站点单次执行结果 |

### 2.2 步骤类型（Procedure 的原子操作，`models.ts` + `src/lib/page/steps.ts`）

等待元素(wait) / 点击(click，可监视弹窗+followPopup) / 固定等待(delay) / 等待文本(waitForText) / 输入文本(type) / 跳转 URL(goto) / 等待 URL(waitForUrl) / 提取数据(extract：text/attribute/html/value/list/table) / 暂停·人工操作(manual) / 自定义脚本(script)。选择器统一支持 CSS 与 XPath（`xpath://` 前缀强制）。

### 2.3 执行引擎

| 模块 | 能力 |
|---|---|
| `ExecutionQueue`（execution-queue.ts） | 全局**串行**队列、站点间隔 `siteGapMs`、卡死复位、强制停止 |
| `RunContext`（run-context.ts） | 单次执行编排：TabSession 标签生命周期、Cloudflare/防护页二段等待、四类掉线信号自动重登并重试一次、诊断模式 PageObservation 采样、干预(INTERVENTION)机制、独立标签页技能执行 `runProcedureStandalone` + `abortStandaloneRun(executionId)` |
| 画布引擎（entrypoints/canvas/execution.ts） | 流程节点图执行、超时/重试/失败继续包装、实时高亮；流程测试经隔离 canvas.html 复用同一引擎（flow-test.ts） |
| `scheduler` + `chrome.alarms` | 每日定时触发 |

### 2.4 AI / 页面感知能力（可直接映射为 MCP 工具的现成实现）

| 现有能力 | 所在模块 | MCP 可复用点 |
|---|---|---|
| AI 工具表 SKILLS（22 个：read/write/browser/control 四组） | `src/lib/agent-skills.ts` | **工具语义与参数校验逻辑可整体平移**为 MCP 工具（见 §4 映射表） |
| 页面采样（URL/标题/正文/可交互元素+唯一转义选择器） | `src/lib/page/explorer-sample.ts::samplePageState` | `read-page` 的实现基础；密码框源头即转占位符 |
| 数据提取 | `src/lib/page/extract.ts::pageExtractData` | `extract` 工具 |
| 单步操作执行 | `src/lib/page/steps.ts::pageRunOneStep` | `click/type/goto/wait/...` 原语工具 |
| 操作证据回灌（命中元素+事件派发确认、_blank 子标签检测） | `src/lib/page/explorer-exec.ts` | 操作类工具的"已派发 vs 已确认"两级返回 |
| LLM 探索生成技能 | `explorer.ts::ExplorationSession` | 高阶工具 `explore-and-create-procedure` |
| 人工示范录制 | `recorder.ts::RecordingSession` | 暂不暴露给 MCP（人工动作无法由远端 agent 代劳） |
| 技能市场安装 | `market.ts` | 可选工具 `market-install`（需显式目标 siteId） |

### 2.5 消息体系（`src/lib/messaging.ts` MSG 常量）

UI ↔ Service Worker 全部走 `chrome.runtime.sendMessage(MSG.*)`；关键可复用消息：`RUN_ALL/RUN_SITE/RUN_PROCEDURE(+ABORT)/STOP/GET_STATUS/PROCEDURE_*/FLOW_*/MARKET_*/HTTP_REQUEST/EXPLORE_GENERATE` 等。新增消息需三处同步（messaging.ts / service-worker.ts / types.ts）。

### 2.6 关键平台约束（现状即约束）

- Manifest V3：权限含 `storage/alarms/scripting/tabs/cookies/notifications/unlimitedStorage` + `host_permissions: <all_urls>`；SW 会休眠；MV3 CSP 禁止 `eval/Function`（表达式解析走自研 `expression.ts`）。
- `src/lib/page/*` 注入函数必须自包含（不可引用模块作用域），tsc 不检查此约束。
- 项目红线（AGENTS.md §7）：不破解验证码、不绕过安全策略、默认串行不高频并发、不上传 Cookie/API Key、目标站点必须由用户显式配置。

---

## 3. MCP Server 承载形态（架构分析与建议）

### 3.1 MV3 平台限制分析

| 限制 | 对 MCP 的影响 |
|---|---|
| SW 无法监听 TCP 端口 | 不能做成标准 MCP 的 HTTP/SSE/Streamable-Http 服务端被直连 |
| SW 空闲约 30s 即休眠 | 长连接需要持续心跳维持，且必须容忍断线后重连恢复 |
| SW 事件驱动唤醒 | 消息/alarms 可唤醒，但内存态（如进行中的 MCP 会话）会丢失 |
| Offscreen Document 同样不能开监听端口 | 无法作为替代承载 |
| Native Messaging 需要在各 OS 注册原生宿主 | 分发成本高，但连接本身可靠 |

结论：**扩展侧只能做 MCP 的"客户端方向的出站连接"，或在本地桥接进程侧做协议端点**。可行的三种形态：

### 3.2 方案对比

#### 方案 A（推荐）：出站 WebSocket + 本地桥接进程（Bridge）

```
MCP 客户端(stdio) ⇄ pagedrone-mcp 桥接进程(npx 启动, 本机)
                        ⇅ WebSocket (ws://127.0.0.1:<port>/token)
                   扩展 Service Worker（MCP 会话端点）
                        ⇄ chrome.runtime.sendMessage / executeScript
```

- 桥接进程以 npm 包分发（如 `npx pagedrone-mcp`），对 MCP 客户端表现为标准 **stdio MCP server**，零额外注册；对扩展持有 WS 服务端。
- 扩展设置页提供"桥接地址 + 配对令牌"，SW 主动**出站连接**（符合 MV3 出站网络允许项；WebSocket 属于 SW 允许的 API）。
- 保活：Chrome ≥116 活跃 WebSocket 连接可重置 SW 空闲计时器，配合 <25s 心跳即可长期存活（详见 §6.1）。
- 优点：分发最简单（一条 npx 命令）、跨平台、无需 Native Host 注册表写入、天然支持多客户端场景受限但可控（每令牌一会话）。
- 缺点：要求用户本机有 Node 运行时；桥接进程不在则功能不可用。

#### 方案 B：Native Messaging 原生宿主

扩展经 `chrome.runtime.connectNative` 连接本地二进制，二进制对外呈现 stdio MCP。

- 优点：无需 Node；连接生命周期受浏览器托管。
- 缺点：需按 OS 写注册表/manifest（分发重）；每次浏览器启动才拉起宿主；仍需处理 SW 休眠（端口消息可重置空闲计时器，但静默期过长仍会断）。

#### 方案 C（否决）：纯 SW 内实现完整 MCP server

无法监听端口、无法被任何客户端直连，仅靠 alarms 轮询外部的方案延迟与复杂度都不可接受。否决。

### 3.3 架构建议（采纳方案 A，预留 B 为可选演进）

1. **新增模块划分**（实现期落点，本文仅定义职责）：
   - `src/lib/mcp/protocol.ts` —— MCP JSON-RPC 消息编解码、工具清单声明、结果/错误封装；
   - `src/lib/mcp/session.ts` —— WS 连接管理、鉴权握手、心跳、断线状态持久化；
   - `src/background/service-worker.ts` —— 仅挂接消息入口，复用既有 handler 层。
2. **分层复用**：MCP 工具处理器不得旁路业务逻辑直写 storage，一律复用 `MSG` 同款后台函数层（storage CRUD、enqueueSites、runProcedureStandalone 等）。建议实现期把 service-worker 中各 `MSG.*` 的 handler 提取为可导入的纯函数层，MSG 与 MCP 两个入口共享（见 §5 复用关系）。
3. **会话与执行解耦**：长时执行（run-site/run-procedure/run-flow）立即返回 `executionId`，进度经 WS 推送 notification 或轮询 `get-execution` 获取；SW 若休眠重启，凭 storage 中持久化的任务态恢复应答。
4. **兼容性**：桥接进程与扩展版本各自独立发版；WS 握手携带双方 `protocolVersion` 与能力协商，向后兼容旧扩展。

---

## 4. 对外暴露的工具清单（MCP Tools 设计）

### 4.1 设计原则

- **分组沿用现有 SKILLS 表语义**：`read`（默认可用）/ `write`（改配置资产）/ `browser`（开标签页操作）/ `exec`（触发执行，新增组）/ `control`。
- 只读优先：客户端可在配置中声明 `readOnlyHint`，安全模式（§5.3）下非 read 组全部拒绝。
- 所有 id 类参数必须引用 `list-*` 工具返回的真实 id，服务端校验存在性（复用 `validateSkillCall` 思路）。
- 输入 schema 使用 JSON Schema Draft 2020-12（MCP 标准）；以下给出关键字段草案，省略号表示实现期补齐 description。

### 4.2 工具一览与现有能力映射

| MCP 工具 | 组 | 复用的现有实现 | 说明 |
|---|---|---|---|
| `list-sites` | read | PROCEDURE_LIST 同层 storage 读 | 站点清单（含 enabled、lastResult 摘要） |
| `get-site` | read | storage 读 + detect 展开 | 站点详情与三个默认入口 |
| `list-procedures` / `get-procedure` | read | storage 读 | 技能清单 / 完整步骤、判定、返回契约 |
| `list-flows` / `get-flow` | read | FLOW_LIST 同层 | 流程清单 / 节点图全量 |
| `list-logs` | read | logs 存储 | 按 siteId/status 过滤的历史日志 |
| `get-status` | read | GET_STATUS handler | 队列状态、当前运行态 RunState |
| `create-site` / `update-site` | write | create-site/update-site（agent-skills 实现） | 站点 CRUD |
| `create-procedure` / `add-step` / `update-step` / `remove-step` / `replace-steps` / `update-procedure` / `set-detect` / `set-output` | write | 同名 AI 工具实现 | 技能 CRUD；`replace-steps` 要求显式确认标志 |
| `create-flow` / `update-flow-node` | write | createFlow + 画布模型转换 | 流程创建与定点修节点 |
| `run-all` | exec | RUN_ALL → enqueueSites | 全部启用站点入队 |
| `run-site` | exec | RUN_SITE handler | 单站点入队，返回 taskId |
| `run-procedure` | exec | RUN_PROCEDURE → runProcedureStandalone | 独立标签页执行单个技能，返回 executionId |
| `run-flow` | exec | flow-test.ts 隔离画布通道 | 后台打开隔离画布执行流程，返回 executionId |
| `get-execution` / `abort-execution` | exec | GET_STATUS / STOP / abortStandaloneRun / EXPLORE_ABORT 同层 | 进度查询与取消（§6.3） |
| `navigate` | browser | TabSession + goto step | 打开、复用或接管受管标签页跳转（支持 managed-new/managed-reuse/current-active） |
| `read-page` | browser | samplePageState（密码框源头脱敏） | 读取状态：URL/标题/正文/可交互元素（含坐标、视口可见性、角色，支持 compact 极简文本树） |
| `screenshot` | browser | captureVisibleTab | 捕获视口 Base64 截图并按 MCP image 原生返回，支持指定选择器元素坐标 |
| `get-page-outline` | browser | samplePageOutline | 获取标题层级（H1-H6）、表单、主要导航链接与 Meta 元信息 |
| `click` / `hover` / `type` / `clear-input` / `press-key` / `scroll-page` / `select-option` / `click-coordinate` | browser | execPageAction 注入 | 丰富的原子操作手势，返回 ok/confirmed 两级证据 |
| `batch-actions` | browser | withBrowserLock 批量串行 | 批量流水线执行多个动作，大幅降低 MCP 往返耗时 |
| `extract` | browser | pageExtractData | text/attribute/html/value/list/table 提取 |
| `list-tabs` / `switch-tab` / `new-tab` / `go-back` / `go-forward` / `reload-page` / `close-tab` | browser | chrome.tabs 原生 API | 完整的标签页调度与导航历史控制 |
| `explore-and-create-procedure` | browser | EXPLORE_GENERATE → explorer.ts | LLM 探索归纳生成归属指定 siteId 的技能 |
| `http-request` | exec | HTTP_REQUEST handler | 用户在请求体中显式给出的 HTTP 调用 |

> 刻意**不暴露**：录制（RECORD_*，人工动作不可代劳）、市场升级提示 UI、INTERVENTION_RESOLVE（改为 MCP 端以 `ask-user` 语义透出，见下）、任何 Cookie/密码读取。

### 4.3 代表性 schema 草案

```jsonc
// run-procedure
{
  "name": "run-procedure",
  "annotations": { "readOnlyHint": false },
  "inputSchema": {
    "type": "object",
    "required": ["procedureId", "siteId"],
    "properties": {
      "procedureId": { "type": "string" },
      "siteId":      { "type": "string", "description": "技能归属站点" },
      "timeoutMs":   { "type": "integer", "minimum": 1000, "maximum": 600000 }
    }
  },
  "outputSchema": {                       // MCP output-schema 能力，可选
    "type": "object",
    "properties": {
      "executionId": { "type": "string" },
      "accepted":    { "type": "boolean" }
    }
  }
}

// get-execution
{
  "name": "get-execution",
  "inputSchema": {
    "type": "object", "required": ["executionId"],
    "properties": {
      "executionId": { "type": "string" },
      "waitMs":      { "type": "integer", "description": ">0 时阻塞至完成或超时" }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "state":   { "enum": ["queued","running","waiting_cf","need_manual","done","aborted"] },
      "progress":{ "type": "array", "items": { "type": "object" } }, // 步骤级事件
      "result":  { "type": "object", "description": "终态：status/message/outputs(cf 技能返回契约)" }
    }
  }
}

// navigate
{
  "name": "navigate",
  "inputSchema": {
    "type": "object", "required": ["url"],
    "properties": {
      "url":     { "type": "string", "format": "uri" },
      "tabMode": { "enum": ["managed-new", "managed-reuse", "current-active"], "default": "managed-new" },
      "waitFor": { "type": "string", "description": "可选 load/domsleep 选择器" }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": { "tabId": { "type": "integer" }, "finalUrl": { "type": "string" } }
  }
}

// read-page
{
  "name": "read-page",
  "annotations": { "readOnlyHint": true },
  "inputSchema": {
    "type": "object",
    "properties": {
      "includeElements": { "type": "boolean", "default": true },
      "textMaxLength":   { "type": "integer", "default": 8000 },
      "selectorScope":   { "type": "string", "description": "CSS/XPath，限定采样范围" }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string" }, "title": { "type": "string" },
      "textExcerpt": { "type": "string" },
      "elements": { "type": "array", "items": {
        "type": "object",
        "properties": {
          "tag": {"type":"string"}, "role":{"type":"string"},
          "label":{"type":"string"}, "selector":{"type":"string"}
        }
      }}
    }
  }
}

// click —— 两级确认语义
{
  "name": "click",
  "inputSchema": {
    "type": "object", "required": ["selector"],
    "properties": {
      "selector":    { "type": "string", "description": "来自 read-page 的已转义选择器" },
      "watchPopup":  { "type": "boolean", "default": true },
      "timeoutMs":   { "type": "integer", "default": 15000 }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "ok":        { "type": "boolean" },
      "confirmed": { "type": "boolean", "description": "false=事件已派发但页面变化未证实" },
      "evidence":  { "type": "object" },
      "newTabId":  { "type": ["integer", "null"] }
    }
  }
}
```

其余工具 schema 按同风格在实现期补齐，参数命名与现有 `Step` 类型、`SKILLS` 表参数保持一致，避免两套词汇。

---

## 5. 安全与权限边界

### 5.1 总红线（继承 AGENTS.md §7，MCP 场景重申）

1. 不破解验证码、不绕过网站安全策略；防护页只做等待/验证技能/人工接管。
2. 不读取、不保存、不经 MCP 回传任何密码字段值与 Cookie（`samplePageState` 已在注入源头把密码框转占位符，此行为必须在 MCP 路径同样生效）。
3. 不上传用户数据到第三方；MCP 通信仅限本机回环（127.0.0.1）或用户显式配置的自有桥接地址。
4. 默认串行执行、保留 `siteGapMs` 间隔；MCP 触发的执行进入同一 `ExecutionQueue`，不允许并发旁路。
5. 浏览器操作目标 URL 必须来自调用方显式传参或用户已配置的站点，服务端不得内置站点名单。

### 5.2 接入控制

| 机制 | 需求 |
|---|---|
| 显式开关 | 设置页"MCP 服务"总开关，默认**关闭**；关闭即断开 WS 并拒绝一切 MCP 请求 |
| 配对令牌 | 开启时生成随机 Token，桥接握手必须携带；Token 仅存本地 `chrome.storage.local`，UI 支持一键轮换 |
| 回环限定 | 内置桥接地址白名单默认仅 `ws://127.0.0.1:*` / `ws://localhost:*`；其他主机名需用户逐条添加 |
| 会话可见性 | 设置页展示当前连接的客户端标识与最近请求计数，支持一键断开 |

### 5.3 权限分级与授权模式

- **只读模式**（默认）：仅放行 `read` 组工具。
- **标准模式**：放行 `read + exec + browser`；`write` 组每次调用需用户在扩展 UI 上弹窗确认（可勾选"本会话内记住"）。
- **完全模式**：`write` 免确认，仅供用户显式开启并在设置页显著警示。
- `browser` 组首次对某新域名操作时，若该域名不属于任何已配置站点，需用户确认"允许 MCP 操作 example.com"并可加入白名单/黑名单。
- 危险动作硬拒绝清单：访问 `chrome://`、`chrome-extension://`、Web Store 等浏览器内部页面的 navigate/click 一律拒绝。

### 5.4 审计

- 所有 MCP 调用写入环形缓冲审计日志（时间、工具、参数摘要、来源会话、结果状态），设置页可导出，保留上限复用 unlimitedStorage 但设条目上限（如 2000 条）。

---

## 6. 非功能性需求

### 6.1 SW 唤醒与保活

- 心跳间隔 ≤25s（低于 30s 空闲阈值），利用活跃 WebSocket 重置空闲计时器（Chrome ≥116）。
- 兜底：`chrome.alarms` 最小周期闹钟（≥30s，Chrome 120 起）周期性自检连接状态并重连；重连采用指数退避（1s→2s→…→上限 60s）避免风暴。
- **状态外置**：MCP 会话状态（开关、令牌、在途 execution 注册表）全部持久化 `chrome.storage.local`，SW 冷启动后在毫秒级重建应答能力；任何"内存里才有"的设计都不允许。
- 断连期间到达的 MCP 请求由桥接进程排队（带 TTL，默认 60s），重连后重放；超时的向客户端返回明确错误。

### 6.2 性能与资源

- 单桥接会话并发在途工具调用上限（建议 4）；`browser` 组操作全局串行复用队列锁。
- `read-page` 默认截断正文与元素数量（元素 ≤200 个），防止大页面撑爆 token 与 WS 帧（单帧上限 1MB，超出分片）。

### 6.3 长时执行的进度回报与取消

- **异步作业模型**：`run-*` 系列立即返回 `executionId`；进度经两种途径：
  - MCP `notifications/progress`（sessionId 绑定推送，桥接转发）；
  - 客户端主动 `get-execution`（waitMs 长轮询）。
- 取消链路复用现有能力：`abort-execution` → `abortStandaloneRun(executionId)` / `stopQueue()` / EXPLORE_ABORT 同层取消令牌（CancellationToken），并清理对应标签页。
- `need_manual`（人工介入/验证页）终态前先挂起：MCP 侧返回 `state=need_manual` + 桌面通知已发出的标记，由用户在浏览器完成后再取终态；不向 agent 伪装成失败。

### 6.4 错误码规范

统一封装为 `{ code, message, retryable }`，映射到 MCP 工具结果的 `isError` 结构：

| code | 含义 | 来源映射 | retryable |
|---|---|---|---|
| `-32700/-32600/-32601/-32602/-32603` | JSON-RPC 标准错误 | 协议层 | 视情况 |
| `AUTH_FAILED` | 令牌错误/未开启开关 | 握手 | 否（需用户处理） |
| `TOOL_DISABLED_BY_MODE` | 当前权限模式禁止该工具 | §5.3 | 否 |
| `DOMAIN_NOT_ALLOWED` | 目标域名不在白名单 | §5.3 | 否 |
| `NOT_FOUND` | procedureId/siteId/flowId/executionId 不存在 | validate 层 | 否 |
| `VALIDATION_FAILED` | 参数校验失败（附正确签名提示） | validateSkillCall 思路 | 可修正后重试 |
| `EXECUTION_TIMEOUT` | DeadlineError | errors.ts | 是 |
| `TAB_GONE` | TabGoneError | errors.ts | 否（需重新 navigate） |
| `LOGIN_REQUIRED` | LoginRedirectError / looksLikeLoggedOut | RunContext | 是（用户登录后） |
| `CF_CHALLENGE` | 防护页等待超时 | waitForChallengeClear | 是 |
| `NEED_MANUAL` | 人工介入挂起 | INTERVENTION | 特殊终态 |
| `ABORTED` | AbortedError（用户/客户端取消） | cancellation.ts | 否 |
| `BRIDGE_DISCONNECTED` | WS 未连接 | session 层 | 是（自动重连中） |
| `INTERNAL` | 未分类异常 | 兜底 | 否 |

### 6.5 可观测性与验收要点

- 扩展 DevTools 与桥接进程双侧输出结构化日志（traceId 贯穿一次 MCP 调用）。
- 验收冒烟清单：stdio 客户端完成 tools/list → read-page → extract → run-procedure 全链路；断网/杀桥接/SW 手动停止三类故障后 60s 内自愈；安全模式下越权工具全部被拒并有审计记录。

---

## 7. 与现有消息体系（MSG）的复用关系

1. **单一业务内核，双协议入口**：`service-worker.ts` 中各 `MSG.*` handler 提炼为独立函数层（如 `src/lib/handlers.ts`，实现期定夺）；MCP 工具处理器与 MSG handler 都调它。禁止 MCP 路径复制一份业务逻辑。
2. **不需要为 MCP 新增大量 MSG**：MCP 请求不走 `chrome.runtime.sendMessage`（它来自 SW 内部 WS 会话）。仅在必要时新增少量内部消息，例如画布页向 SW 补报流程执行事件时复用既有 `FLOW_TEST_PROGRESS/RESULT`。
3. **三处必改规则依旧生效**：若确要新增 MSG，严格遵循 AGENTS.md §3.3（messaging.ts 常量 / service-worker handler / types.ts MessageRequestMap）。
4. **AI 工具表（SKILLS）是 MCP write/browser 工具的第一参照**：参数校验、id 真实性检查、"修改后必须重新测试"等约定直接平移，保证内置 AI 对话与外部 MCP agent 行为一致。

---

## 8. 里程碑建议（供排期参考，非承诺）

| 阶段 | 内容 |
|---|---|
| M1 | 桥接进程骨架 + WS 握手/心跳/重连 + `read` 组工具（只读模式） |
| M2 | `exec` 组（run-site/run-procedure/run-flow + 进度/取消） |
| M3 | `browser` 组原语（navigate/read-page/click/type/extract）+ 两级确认语义 |
| M4 | `write` 组 + 授权弹窗 + 白名单 + 审计日志 |
| M5 | explore-and-create-procedure 高阶工具 + Native Messaging 形态评估（方案 B） |

---

*附：本文档为需求设计稿。任何实现落地时，须同步更新 AGENTS.md 第 1 节拓扑树与第 3.3 节消息表（如涉及）。*
