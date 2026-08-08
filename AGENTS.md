# AGENTS.md — auto-page AI 编码与对话代理说明

本文档面向 **AI 编码代理**（Claude Code、Cursor、Copilot Agents 等）以及扩展中的 **AI 对话**，说明本仓库的组织约定、可调用能力、协作准则，以及本项目自身具备的**自学习能力**。

> auto-page 是一款 Chrome MV3 扩展，形态是"网页 RPA"：把可复用的**技能（Procedure）**在**画布流程（Flow）**上编排，或直接绑定到**站点（Site）**上定时/手动执行。

---

## 1. 仓库拓扑与代理边界

```
auto-checkin/
├── wxt.config.ts                 # WXT MV3 清单、权限与 React 模块配置
├── components.json               # shadcn/ui 组件生成与路径别名配置
├── assets/globals.css            # Tailwind v4、shadcn 明暗主题与语义设计令牌
├── components/ui/                # 管理页与画布共享的 shadcn/ui 源码组件
├── lib/utils.ts                  # 前端 cn() className 合并工具
├── entrypoints/                  # WXT 自动发现的扩展入口
│   ├── background.ts             # Service Worker 宿主，加载 src/background/service-worker.ts
│   ├── options/                  # React 管理页，构建为 options.html
│   │   ├── index.html · main.tsx
│   │   ├── App.tsx               # 响应式设置页、技能/站点/市场/日志/录制
│   │   ├── components/ai-chat/   # AI 对话、会话历史、消息与 AI 工具结果组件
│   │   └── styles.css
│   └── canvas/                   # React Flow 流程画布，构建为 canvas.html
│       ├── index.html · main.tsx · App.tsx
│       ├── FlowNodeCard.tsx · PropertiesPanel.tsx · resources.tsx
│       ├── flow-model.ts · types.ts · api.ts
│       ├── execution.ts          # 流程执行引擎与节点高亮
│       ├── expression.ts         # MV3 CSP 安全的条件表达式解析器
│       └── style.css
├── public/icons/                 # WXT 原样复制的扩展图标（16/48/128）
├── src/
│   ├── background/
│   │   └── service-worker.ts     # 调度中枢：消息 / 队列 / alarms / AI / 录制
│   ├── lib/                      # 后台共享逻辑（不得引用 DOM）
│   │   ├── models.ts · types.ts · storage.ts · flows.ts
│   │   ├── run-context.ts · execution-queue.ts · scheduler.ts
│   │   ├── agent-chat.ts · agent-skills.ts · explorer.ts · recorder.ts · llm.ts
│   │   ├── cf.ts · market.ts · messaging.ts · migrate.ts · v1-convert.ts
│   │   ├── tab-session.ts · cancellation.ts · errors.ts
│   │   ├── flow-test.ts         # 通过隔离画布复用正式流程引擎执行 AI 流程诊断
│   │   └── page/                 # chrome.scripting 注入的自包含函数
│   │       ├── steps.ts · selectors.ts · collector.ts · user-script.ts
│   │       └── explorer-sample.ts · explorer-exec.ts · extract.ts
│   ├── options/                  # 迁移对照用旧管理页，不进入 WXT 页面入口
│   ├── canvas/                   # 迁移对照用旧画布，不进入 WXT 页面入口
│   ├── styles/                   # 迁移对照用旧样式
│   └── icons/                    # 迁移对照用旧图标
├── market/                       # 示例市场源（index.json + procedures/*.json）
├── fixtures/                     # 本地演示页
├── scripts/
│   ├── pack.sh                   # WXT build → .output/chrome-mv3 → releases/*.zip
│   └── build_crx.py              # CRX3 签名打包
├── .github/workflows/            # CI：tag 推送自动构建 + GitHub Release
├── .wxt/ · .output/              # WXT 类型与构建产物（生成目录，不要手改）
├── dist/                         # Release/CRX 临时产物（生成目录，不要手改）
├── package.json · tsconfig.json · README.md · AGENTS.md
└── private.pem                   # CRX 签名私钥（禁止提交/泄露）
```

**代理不得越界的目录**：`private.pem`、`.git/`、`.wxt/`、`.output/`、`dist/`（后三者均由命令生成，不要手改）。

---

## 2. 核心概念（编码时必须区分）

| 概念 | 中文名 | 存储键 | 说明 |
|---|---|---|---|
| Site | 站点 | `sites` | 一个目标 URL + 多个归属技能 + 默认自动化 / 登录 / 验证技能入口 + 定时配置；默认入口只能绑定本网站的同类技能 |
| Procedure | **技能** | `procedures` | 通过 `siteId` 归属于一个网站的可复用单页操作步骤集合。`kind ∈ {checkin, login, verification}`；`output.enabled` 开启后可向流程调用方返回命名数据 |
| Flow | **流程** | `flows` | 画布节点图，可组合网站、网站下的技能、条件/循环/并行/变量 |
| Task | 执行批次 | `tasks` | 一次执行队列的归档，用于日志分组 |
| Log | 执行日志 | `logs` | 单站点单次执行结果 |
| AI Chat Session | AI 对话会话 | `agentChatSessions` | 本地持久化的会话历史、消息与 AI 工具执行结果 |
| Flow Test Report | 流程测试报告 | `flowTestReports` | 按流程保留最近 20 次节点级诊断，供画布和 AI 查阅 |

> **命名铁律**：Procedure 中文名叫**技能**，Flow 中文名叫**流程**。一个 Site 对多个 Procedure，技能通过 `siteId` 建立归属；站点上的 `checkinProcedureId/loginProcedureId/verificationProcedureId` 仅是默认执行入口。旧代码里的 `procedure/proc` 标识符和 `procedures` 存储键不改（避免数据迁移），只改产品层文字。浏览器 click/type/goto 等底层行为称为“操作”。

---

## 3. AI 编码代理协作准则

### 3.1 修改代码前

1. **读 `README.md` + 本文件**；确认要碰的模块归属（`src/lib/*` 属领域逻辑，`entrypoints/options/*` 与 `entrypoints/canvas/*` 属 React UI）。
2. **区分层次**：Service Worker（`entrypoints/background.ts` → `src/background/service-worker.ts` + 直接引用的 `src/lib/*`）不能引用 DOM；React 页面可使用 DOM、导入 DOM-free 的 models/storage 模块，并通过 `chrome.runtime.sendMessage` 调用后台能力（消息类型集中在 `src/lib/messaging.ts` 的 `MSG`）。
3. React 页面的共享状态以 `chrome.storage.local` 为事实源，必须订阅 `chrome.storage.onChanged`，保存成功后同步本地 draft；不得依赖刷新页面使设置生效。
4. `src/lib/flows.ts` 负责流程持久化与唯一的 `createFlow()` 默认骨架工厂；**执行引擎在 `entrypoints/canvas/execution.ts`**，因为流程运行需要实时更新 React Flow 节点、变量与日志。`entrypoints/canvas/flow-model.ts` 只做存储模型与 React Flow 模型转换，不得再维护另一套新建流程骨架。条件表达式必须走 `entrypoints/canvas/expression.ts`，不得使用受 MV3 CSP 禁止的 `eval` / `Function`。
5. `src/lib/page/*` 里的函数会被 `chrome.scripting.executeScript` 序列化注入目标页面，**必须自包含**：不能引用模块作用域变量、不能 import 其他模块，所有依赖通过参数传入。`tsc` 不会检查这个约束，验证要看 `.output/chrome-mv3/background.js` 中的打包结果。

### 3.2 修改后必须做

- **类型检查**：`npm run typecheck`（先 `wxt prepare` 再 `tsc`）零错误。
- **构建**：`npm run build`（类型检查 + WXT/Vite Chrome MV3 构建）。
- **不要 `cat` 已 Edit 的文件**去"验证"——工具会失败就报错，不用回读。
- **JSON**：`market/index.json` 修改后 `python3 -m json.tool` 校验。
- **manifest 版本**由 `package.json` 提供，只能人工升；打 tag 触发 CI（见 `.github/workflows/release.yml`）。
- **注入函数自包含性**：改了 `src/lib/page/*` 后，检查 `.output/chrome-mv3/background.js` 中对应函数仍只引用函数体内变量，并做目标页注入冒烟。

### 3.3 消息类型（`src/lib/messaging.ts` 的 `MSG`）

| 消息 | 方向 | 语义 |
|---|---|---|
| `PING` / `GET_STATUS` | UI → SW | 存活检查 / 拉取运行时状态 |
| `RUN_ALL` / `RUN_SITE` | UI → SW | 入队执行 |
| `STOP` | UI → SW | 强制停止队列 |
| `RESCHEDULE` | UI → SW | 重新排 alarms |
| `PROCEDURE_LIST/SAVE/DELETE` | UI → SW | 技能 CRUD |
| **`RUN_PROCEDURE`** | UI → SW | **独立标签页执行单个技能**（画布"调用技能"节点用） |
| **`RUN_PROCEDURE_ABORT`** | 画布 → SW | 按 executionId 取消单个后台技能执行并清理其标签页 |
| `FLOW_LIST/SAVE/DELETE` | UI → SW | 流程 CRUD（执行在画布页内，不经 SW） |
| `FLOW_TEST_PROGRESS/RESULT` | 画布 → SW | AI 流程诊断的实时日志与最终报告；执行仍复用画布正式引擎 |
| `HTTP_REQUEST` | 画布 → SW | 在 Service Worker 发起用户显式配置的 HTTP 请求，返回状态、响应头与响应数据 |
| `MARKET_INDEX/INSTALL` | UI → SW | 市场目录代理；安装时必须携带目标 `siteId` |
| `EXPLORE_GENERATE/ABORT` | UI → SW | AI 探索生成归属于指定 `siteId` 的技能；进度通过 `runtime.explorationProgress.events` 结构化回流 |
| `LLM_TEST/MODELS` | UI → SW | LLM 连通性测试与模型列表；获取模型可携带设置页尚未保存的表单配置 |
| `AGENT_CHAT_SEND/ABORT/RESET/HISTORY` | UI → SW | 按会话发送、停止、清空与读取 AI 对话 |
| `AGENT_CHAT_CREATE/DELETE` | UI → SW | 新建与删除本地持久化的 AI 对话会话 |
| `INTERVENTION_RESOLVE` | UI → SW | 执行偏差自愈决策 |
| `RECORD_START/STOP/STEP_REMOVE/DISCARD` | UI → SW / Content | 人工示范录制；保存时必须携带目标 `siteId` |
| `RECORD_EVENT` | Content → SW | 采集器事件上报（字面量，不走 MSG 常量） |

新增消息 → 三处必改：`src/lib/messaging.ts`（常量）、`src/background/service-worker.ts`（handler）、`src/lib/types.ts`（`MessageRequestMap` 类型）。

---

## 4. AI 对话

AI 对话位于 React 管理页的“AI 对话”标签，用户用自然语言下达指令（"帮我建一个签到技能"、"看看这个页面有什么可点的"），SW 侧由 `src/lib/agent-chat.ts::AgentChatSession` 驱动 LLM 循环。会话列表与消息落在 `agentChatSessions`，可跨管理页刷新和 Service Worker 休眠恢复；无法跨 SW 重启恢复的在途请求必须明确标记为“已中断”，不得伪装成仍在执行。

对话框底部的快捷命令是轻量斜杠命令的前端入口，不注册新的后台消息或 AI 工具：用户可点击“检查技能 / 修复技能 / 测试技能”等命令，在输入框插入可继续编辑的短命令（如 `/测试技能 `），再补充技能名、网址或上下文；后台 system prompt 会把斜杠命令映射到标准 AI 工具流程。也可直接输入 `/` 调出命令建议，使用上下键、Enter 选择或 Escape 关闭。选择命令后仍须由用户确认发送，并统一复用 `AGENT_CHAT_SEND`。

管理页所有非“AI 对话”标签都显示全局 AI 悬浮入口；入口打开后在当前页面上方展示复用的 `AiChatPanel` 浮层，关闭或按 Escape 只收起浮层，不影响后台会话执行。浮层中的站点 / 技能 / 流程跳转会先收起浮层再打开对应页面。

AI 对话支持 `Settings.agentThinkingMode` 思考模式。开启后，`AgentChatSession` 将模型返回的简短公开决策摘要与分析 / 决策 / 自我修正 / 结果反馈事件写入 `ChatTurn.thinking`，运行中通过 `runtime.agentProgress.thinking` 实时回流；管理页以可折叠“思考过程”预览。这里展示的是结构化决策摘要，不是模型内部隐藏推理，且 UI 会再次遮盖疑似敏感值。

AI 对话还支持 `test-procedure` / `test-flow` 诊断工具。技能测试通过 `RunContext` 的诊断模式在每个步骤前后采样 `PageObservation`，流程测试打开隔离 `canvas.html` 并复用 `entrypoints/canvas/execution.ts`；页面观察和流程日志实时回流 AI。测试工具本身不会修改技能或执行日志；若技能测试确认 `need_login`，只更新绑定站点的 `lastResult` 为“需登录”以驱动站点提示。普通表单登录应依赖 Chrome 已保存凭据自动填充后点击提交，扩展不得读取或上传密码；OAuth 只是显式弹窗步骤的一种登录方式。只有用户明确要求测试并修复时，Agent 才能根据准确报告调用写入工具，修改后必须再次测试验证。

### 4.1 AI 工具（`src/lib/agent-skills.ts` 的 `SKILLS` 表）

| AI 工具 | 分组 | 用途 |
|---|---|---|
| `list-procedures` / `get-procedure` | read | 查看现有可编排技能；`get-procedure` 返回完整步骤、判定、脚本与返回契约 |
| `get-site` / `list-logs` / `list-flows` / `get-flow` | read | 查看站点、历史日志与流程完整节点配置，用于定位问题 |
| `list-sites` | read | 查看站点 |
| `create-procedure` / `add-step` / `update-step` / `remove-step` / `replace-steps` / `update-procedure` / `set-detect` | write | 创建/修复可编排技能（含验证技能）；修改前应先读取真实技能，`replace-steps` 仅在用户明确要求重写时使用 |
| `set-output` | write | 配置技能是否返回数据，以及要暴露的提取结果字段 |
| `create-site` / `update-site` | write | 创建/编辑站点 |
| `create-flow` / `update-flow-node` | write | 创建流程或定点修复流程节点配置；修改后必须重新测试 |
| `read-page` / `test-procedure` / `test-flow` / `explore-page` | browser | 读取、诊断或探索页面；测试技能实时回流页面观察并返回非敏感 `loginSignals`，发现登录失效时标记站点“需登录”；测试流程复用正式画布引擎；`explore-page` 生成技能时必须携带目标 `siteId` |
| `ask` | control | 向用户提问澄清 |
| `done` | control | 结束本轮，总结结果 |

AI 工具目录由 `renderSkillCatalog()` 从 `SKILLS` 表自动生成 prompt，不存在需要手维护的第二份副本。新增 AI 工具 → 在 `SKILLS` 表加声明 + 在 `executeSkill()` 加实现，Agent 自动学会调用。

### 4.2 Agent 循环流程

`用户输入 → 构造 prompt（含 AI 工具目录 + 上下文）→ LLM 返回 JSON {thought, skill, args} → validateSkillCall 校验 → executeSkill 执行 → 结果回灌 LLM → 循环直到 done 或达到轮次上限`。

关键设计：
- 输出必须是合法 JSON，解析失败时把错误信息回灌让模型自行修复。
- `validateSkillCall` 校验参数类型、必填项、id 真实性；失败时把"正确签名"回灌。
- 只读 AI 工具先于写入工具提供，让模型先看清现状再操作。
- `isCostlySkill` 标记需要开标签页 / 烧 token 的 AI 工具，UI 侧可据此征求确认。

### 4.3 页面执行能力（`src/lib/page/*`）

这些函数通过 `chrome.scripting.executeScript` 注入目标页面，不引用模块作用域：

| 函数 | 文件 | 用途 |
|---|---|---|
| `pageRunOneStep(step)` / `pageSubmitAutofilledLogin()` | `steps.ts` | 执行单步（click/type/goto/wait 等）；禁止技能写入密码字段，登录技能仅依据非敏感页面事实提交 Chrome 已填充的普通登录表单 |
| `pageQueryExists(selector)` | `selectors.ts` | 检测元素是否存在 |
| `pageCollector()` | `collector.ts` | 录制期挂载事件监听 |
| `pageRunUserScript(source, timeout)` | `user-script.ts` | 执行用户自定义 JS |
| `samplePageState()` | `explorer-sample.ts` | 采样页面 URL/文本/可交互元素，并生成唯一且已转义的选择器 |
| `execPageAction(step)` | `explorer-exec.ts` | 探索期执行浏览器操作，返回实际命中元素与事件派发证据；引擎再对比操作前后页面状态回灌 Agent，并检测 `_blank` 链接的子标签页 |
| `pageExtractData(options)` | `extract.ts` | 按 CSS/XPath 选择器提取文本、属性、HTML、列表或表格数据；仅由技能执行器与 AI 探索注入目标标签页 |
| `samplePageState()` | `explorer-sample.ts` | 诊断模式下在技能步骤前后采样页面事实；密码输入框在注入函数源头即转换为占位文本，避免探索器或 AI 回灌密码值 |

### 4.4 AI 探索执行时间线

`ExplorationSession` 必须把页面观察、LLM 决策、浏览器操作与浏览器响应拆成独立的 `ExploreProgressEvent`，通过 `runtime.explorationProgress.events` 回流管理页。UI 可以展示 AI 的操作意图，但不得把意图写成已完成事实；只有 `ExploreActionResponse.confirmed=true`（页面状态或执行证据已确认）时才能标记“结果已确认”，`ok=true && confirmed=false` 必须显示为“已派发、未确认”。Service Worker 对进度写入串行化，避免快速连续事件乱序覆盖。

探索过程中的所有尝试可保留在时间线和 transcript 中，但只有 `ok=true && confirmed=true` 的操作才能固化进最终技能；连续且完全相同的操作只保留一次。探索生成的技能必须清空默认脚本，只固化 `click` / `type` / `goto` / `wait` / `waitFor` / `waitForText` / `waitForUrl` / `extract` 等标准动作；无法表达的行为应由模型返回 `fail`，不能退化成脚本。若路径包含 `extract`，生成器会按命名结果自动开启技能返回契约。未确认点击不得因为事件已派发就出现在技能的执行步骤里。点击后检测到新标签页时，探索会接管该子标签页继续观察，固化的点击步骤带 `watchPopup + followPopup`，后续步骤在新标签页执行。

### 4.5 验证技能与防护恢复

`Procedure.kind='verification'` 表示用户可复用的验证技能。技能通过 `siteId` 归属于网站，站点通过 `verificationProcedureId` 选择默认验证技能；`RunContext.waitForChallengeClear` 检测到防护页后先短暂等待自动放行，仍未通过时执行该技能。验证技能可以包含等待、跳转、页面操作和 `manual` 人工确认，但不得内置验证码破解或安全策略绕过。完成状态由 `VerificationDetect.completedSelector`、`completedUrlIncludes` 或通用防护页消失信号确认。画布的 `procedure` 节点必须先选择网站，再选择该网站下的技能，UI 名称为“调用技能”。

---

## 5. 自学习能力声明（Self-Learning Capability）

> **本项目声明具备"自学习能力"（Self-Learning Capability）**。此处的"自学习"不是训练权重，而是指——**扩展在与用户和目标网站的交互过程中，持续吸收结构化经验、迭代内置知识，无需修改代码即可提升未来执行的成功率与鲁棒性**。具体体现在以下六个维度：

### 5.1 执行日志沉淀（Passive Learning）
每次站点执行经 `ExecutionQueue.runOneSite` 调用 `RunContext.run` 并落 `logs`（含 `status` / `message` / `cfWaitedMs` / 触发原因），后台通过 `notifySummary` 反馈；用户可在设置页"自动化日志"审阅任意历史批次。这是所有其他自学习环节的**共享经验池**。

### 5.2 站点画像自适应（Site Profile Adaptation）
`site.lastResult` 与 `site.updatedAt` 记录最近一次执行状态；`ExecutionQueue` 检测到卡死自动复位；`RunContext` 根据历史 CF 耗时和当前页面文本动态延长/缩短等待窗口（`waitForChallengeClear` 的 `sawChallenge / cfManualGraceMs` 二段等待）。

### 5.3 智能重登记忆（Auto Re-Login Memory）
`RunContext.ensureLoggedIn` + `looksLikeLoggedOut` 汇集了四类掉线信号（precheck / step_failed / keyword / url_redirect），任一明确命中即触发登录技能并**重试一次**；步骤失败后还会识别可见的普通密码表单，避免站点没有配置登录 URL/关键词时漏报。开始前只有明确登录页事实才会触发登录技能；即使历史技能的“已登录选择器”配置错误，只要当前页面已离开登录页也不会反复要求登录。登录技能默认不含 `manual`，执行器会在登录入口或表单出现后自动提交 Chrome 自动填充的普通表单；登录方式可以是普通账号、人工操作或 OAuth，OAuth 弹窗流程只有在步骤显式勾选“监视弹窗”且页面没有普通登录表单时才启用。

### 5.4 AI 对话 LLM 循环（Active Agentic Learning）
`AgentChatSession` 是一个**真正的自学习闭环**：LLM 观察可编排技能与站点操作的准确执行结果，选择下一步 AI 工具，再从新状态反推调整策略。输出 JSON 解析失败或参数校验失败时，错误信息回灌让模型自行修复。**增删 `SKILLS` 表中的 AI 工具**直接扩展 AI 助手的能力空间。

### 5.5 技能市场持续增量（Community-Sourced Curriculum）
`src/lib/market.ts` 定时拉 `market/index.json`，比对本地技能的 `marketId` + `version`；发现更新即提示升级。等价于让扩展"订阅"社区维护的最佳实践技能清单——**上游改进选择器或步骤，本地一键吸收**。

### 5.6 迁移与形态演进（Structural Learning）
`src/lib/migrate.ts` 用 `schemaVersion` 幂等迁移旧数据（V2 将站点内联步骤转为 Procedure；V3 为站点补齐验证技能引用；V4 为技能补齐 `siteId` 并拆分跨站共享技能；V5 为技能补齐 `output` 返回契约；V6 将未修改过的旧版 OAuth 默认登录技能改为通用人工登录步骤；V7 清理没有完成条件的泛化 manual 登录步骤，改由执行器自动提交 Chrome 自动填充表单，明确 OAuth/验证码/二次验证的人工步骤保留），未来所有结构升级都走同样通道；用户数据在版本更迭中不丢、不需要重录。

**如何为自学习能力添砖加瓦（开发者/AI 代理视角）**

1. 新增执行信号 → 补进 `RunContext` 的 `result.message` 与 `logs.status`，让画像与统计立刻感知。
2. 新增 AI 工具 → 在 `src/lib/agent-skills.ts` 的 `SKILLS` 表加声明 + `executeSkill()` 加实现，Agent 自动学会用它。
3. 想让 Agent 记忆跨技能的经验 → 用 `chrome.storage.local` 存 KV，键名建议 `agent_mem/<procedureId>/<slot>`。
4. 想接入新的 LLM Provider → 在 `src/lib/llm.ts` 的 `DEFAULT_BASE_URL` / `DEFAULT_MODEL` 加映射，`LlmClient` 已支持自定义 endpoint 与 headers。

---

## 6. 开发工作流

```bash
# 安装依赖
npm ci

# WXT 类型生成 + TypeScript 严格检查
npm run typecheck

# WXT/Vite Chrome MV3 构建（含 Tailwind v4 Vite 插件）
npm run build

# 加载扩展
# chrome://extensions → 开发者模式 → 加载已解压 → 选 .output/chrome-mv3/ 目录

# 本地打包
bash scripts/pack.sh          # releases/auto-checkin-v<version>.zip
python scripts/build_crx.py   # 需 private.pem，产出 .crx

# 发版
# 1) 改 package.json version → 2) commit → 3) git tag vX.Y.Z && git push --tags
#    .github/workflows/release.yml 会自动 npm ci && npm run build，从 .output/chrome-mv3/ 取件打包
```

**修改后自检清单**：
- [ ] `npm run typecheck` 零错误
- [ ] `npm run build` 通过
- [ ] `.output/chrome-mv3/manifest.json` 权限、options 与 background 路径正确
- [ ] `chrome://extensions` 点扩展的"重新加载"（选 `.output/chrome-mv3/`）
- [ ] 打开 Service Worker DevTools 看有无红色报错
- [ ] 相关操作跑一遍冒烟：站点执行 / 画布运行 / 市场安装 / 导入导出 / AI 对话

---

## 7. 提交与安全约束

- **提交/推送/发版**只在用户明确要求时进行；主分支直推前先建分支。
- 提交信息末尾附：`Co-Authored-By: Claude <noreply@anthropic.com>` 由用户决定，代理不擅自加。
- **禁止行为**：破解验证码、绕过网站安全策略、批量高频并发（默认串行且带 `siteGapMs` 间隔）、把用户 Cookie / API Key 上传至任何第三方。
- 涉及 host 权限 `<all_urls>`：改动执行逻辑时，务必让**目标由用户显式配置**（站点表单 / 技能节点 URL 字段），不得硬编码站点名单。

---

## 8. 关键路径速查

| 场景 | 入口 | 核心函数 |
|---|---|---|
| 站点手动执行 | 设置页按钮 → `RUN_SITE` | `enqueueSites` → `ExecutionQueue.drain` → `ExecutionQueue.runOneSite` → `RunContext.run` |
| 定时执行 | `chrome.alarms` → `handleAlarm` | 同上，`reason: 'schedule'` |
| 防护页验证技能 | 站点 `verificationProcedureId` + 技能 `siteId` | `RunContext.waitForChallengeClear` → `executeVerificationAction` → 完成信号复核 |
| 画布运行流程 | React Flow 画布 ▶ | `App.runCurrentFlow` → `validateFlow` → `executeFlow` → `walk` → 节点策略包装（超时/重试/报告）→ `executeNode`（`entrypoints/canvas/execution.ts`） |
| 画布调用技能节点 | 先选网站，再选技能（节点保存 `siteId` + `procedureId`） | `executeNode('procedure')` → `RUN_PROCEDURE(withSiteLogin)` → `runProcedureStandalone`（`run-context.ts`）；登录失效回写所属站点提示 |
| 技能原子提取与返回 | 技能编辑器添加「提取数据」操作并开启技能返回值 | `extract` 步骤 → `Procedure.output` → `RUN_PROCEDURE.outputs/returnValue` |
| 流程采集与上报 | 技能「提取数据」→ 流程「调用技能」→「发送请求」节点 | `extract` 步骤 → 技能返回值 → `HTTP_REQUEST` → 流程变量 |
| 设置页运行流程 | 流程卡片"运行"按钮 | 打开 `canvas.html?flowId=X&autorun=1`（复用 React Flow 画布） |
| AI 对话 | React 管理页“AI 对话” | `AGENT_CHAT_SEND` → `startAgentMessage` → `AgentChatSession.send` → `executeSkill` |
| AI 测试技能 | AI 对话测试/修复指令 | `test-procedure` → `runProcedureStandalone(diagnostic)` → `RunContext.observePage` → 页面观察回流 → 写入工具修复并重测 |
| AI 测试流程 | AI 对话测试/修复指令 | `test-flow` → `flow-test.ts` → 隔离 `canvas.html` → `executeFlow` → `FLOW_TEST_PROGRESS/RESULT` |
| AI 探索生成 | 技能编辑器探索按钮 | `EXPLORE_GENERATE` → `exploreAndGenerate`（`explorer.ts`）；点击产生子标签页时接管新页继续探索 |
| 人工示范录制 | 录制按钮 | `RECORD_START` → `RecordingSession` → `RECORD_EVENT` 采集 |
| 市场安装 | 设置页市场标签 | `MARKET_INSTALL` → `installFromMarket`（`market.ts`） |
| 数据迁移 | SW 启动 `bootstrap` | `runMigrations`（`migrate.ts`） |

任何 AI 编码代理在向本仓库提交改动前，请先据此文对齐上下文，再动键盘。

---

## 9. 文档自维护约束（防止 AGENTS.md 陈旧）

> 本节是**对 AI 编码代理的硬性约束**，不是建议。TS 迁移后 AGENTS.md 曾大面积陈旧（拓扑树、消息表、技能表、速查表全部指向已删除/重命名的文件），误导后续代理。以下规则防止复发。

### 9.1 改代码必须同步改文档

以下任一情况，**必须在同一次改动中更新 AGENTS.md**：

1. **新增文件**（`entrypoints/`、`src/lib/`、`src/background/`、`src/lib/page/`、`scripts/` 下的新模块）→ 在第 1 节拓扑树中登记，写明文件名与一句话职责。
2. **删除或移动文件** → 更新拓扑树，删除对应条目；同时用 `grep -rn '旧路径' AGENTS.md` 检查正文是否有引用并一并修正。
3. **重命名导出函数 / 类**（如 `runOneSite` → `xxx`）→ 更新第 8 节速查表中的函数名。
4. **新增 MSG 消息类型** → 更新第 3.3 节消息表（同时遵守 3.3 节末尾的"三处必改"规则）。
5. **新增 Agent AI 工具** → 更新第 4.1 节 AI 工具表。
6. **改变构建流程**（新增脚本、改变 `npm run build` 步骤、改变产物目录）→ 更新第 6 节开发工作流。
7. **改变目录结构**（新增/删除顶级目录）→ 更新第 1 节拓扑树。

### 9.2 会话结束前自检

每次准备向用户报告"完成"之前，跑一遍：

```bash
# 检查 AGENTS.md 引用的文件路径是否都存在（忽略生成目录和 node_modules/）
grep -oP '[\w./-]+\.(json|mjs|ts|js|py|sh|css|html)' AGENTS.md \
  | sort -u \
  | grep -vE '^(dist/|node_modules/|\.wxt/|\.output/|\./)' \
  | while read -r f; do
      # 只警告包含路径分隔符（/）的路径——裸文件名（如 editor.js）大多是内联代码
      # 引用的无前缀文件，很难写绝对路径，且不构成什么结构风险。
      case "$f" in
        */*) [ -e "$f" ] || echo "MISSING: $f" ;;
      esac
    done
```

> 裸文件名（如 `editor.js`）被过滤，不报 MISSING；**带目录前缀的路径如果 MISSING 必须修正**。

如果输出 `MISSING:` 行，说明 AGENTS.md 引用了不存在的文件，**必须在报告完成前修正**。

### 9.3 不编造不存在的文件或函数

- AGENTS.md 中出现的每个文件路径、函数名、消息常量，必须能在 `entrypoints/`、`src/` 或对应配置中检索到。
- 不确定时，先在 `entrypoints/ src/` 中检索函数名确认，再落笔。
- 如果某个模块已被拆分/删除，不要只改拓扑树——正文（第 4、5、8 节）里的旧引用也要一起清理。

### 9.4 文档与代码同审

- 提交前 `git diff AGENTS.md` 与 `git diff entrypoints/ src/` 对照看：新增的导出、新增的文件、新增的消息类型，是否都在 AGENTS.md 中有对应说明。
- 如果代码改动引入了 AGENTS.md 未覆盖的新概念（如新的交互模式、新的存储键、新的权限），补充对应章节。

### 9.5 版本号约束：文档需与代码结构对齐

> AGENTS.md 描述的是**当前代码库的实际拓扑**，而非理想拓扑。

- AGENTS.md 中的文件路径必须存在于当前分支上。这条规则由 9.2 节的脚本运行时强制执行，不可跳过。
- 如果仓库经过大的重构（如 TS 或 WXT/React 迁移），AGENTS.md 必须同步重写第 1 节拓扑树、第 3 节引用路径、第 4 节模块对应关系、第 5 节自学习能力中的文件路径、第 8 节速查表的入口与函数名——**五个章节缺一不可**。
- 任何 AI 代理**不得**仅因"想少改几行"而保留目标是已删除文件的引用，或把新模块写为旧模块的别名而不验证。
