# auto-page - 网页 RPA 工具

网页版 RPA 工具，支持**画布流程编排**、**可复用技能库**、通用浏览器自动化操作、条件分支、循环、变量等。

为各类网站配置 **DOM 模拟执行**，支持：

- **技能（Procedure）**：把自动化、登录和安全验证步骤抽成归属于网站的独立单元，在技能库中维护；需要用于其他网站时，在目标网站下创建一份独立技能
- **流程（Flow）**：在画布上用节点 + 连线编排技能、站点执行与条件 / 循环 / 并行等控制逻辑
- 在线 **技能市场**：一键下载他人分享的自动化/登录技能
- **AI 对话**：用自然语言创建和维护技能、站点与流程，支持本地持久化的多会话历史
- 执行中掉线（跳登录页、命中未登录关键词、步骤失败）自动重登并重试一次
- 可视化步骤（等待元素 / 点击 / 输入 / 等待文本等）
- 自定义 JavaScript 脚本
- Cloudflare / 常见防护页 **自动等待**，超时后前置标签并通知人工完成
- 手动一键执行 + 每日定时
- 配置导入 / 导出

> 本扩展在你的真实 Chrome 配置中打开标签页执行操作，复用已有登录态与 Cookie。
> **不会**破解验证码或绕过安全策略；遇到交互式人机验证时需要你手动点一下。

## 安装

1. 先构建产物：`npm install && npm run build`（详见下方「开发」）
2. 打开 Chrome，访问 `chrome://extensions`
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择 WXT 构建产物目录：`auto-checkin/.output/chrome-mv3`

## 快速开始

1. 点击扩展图标直接进入管理页（或扩展卡片上的「详细信息 → 扩展程序选项」）
2. 进入 **站点管理 → 新建站点**，填写名称与目标页 URL 并保存
3. 在已保存站点的「网站技能」操作区新建自动化技能（默认已包含「点击执行 → 等待成功文案」两步），再按需创建登录/验证技能
4. 在站点编辑页的默认入口下拉中选择该网站的自动化、登录或验证技能；执行中会按需调用
5. 保存后点 **立即测试**，或在左侧点 **全部自动化**
6. 也可到 **技能市场** 一键安装他人分享的技能
7. 需要条件分支 / 循环 / 多个技能编排时，进入 **流程** 标签新建流程，在画布中拖拽技能节点并连线

## 核心概念

| 概念 | 说明 |
|------|------|
| 站点（Site） | 一个目标网址 + 绑定的自动化 / 登录 / 验证技能 + 定时配置 |
| 技能（Procedure） | 归属于一个网站的可复用原子操作集合，可包含点击、输入、提取数据等步骤，并可声明返回值 |
| 流程（Flow） | 画布上的节点图，可编排技能、站点、条件、循环、并行、延时、变量等 |

一个网站可以拥有多个技能。站点编辑页会展示该网站的全部技能，并提供创建入口；站点上的自动化 / 登录 / 验证技能字段只是默认执行入口。流程画布先选择网站，再从该网站的技能列表中添加技能节点。当需要跨网站、按条件走不同分支、循环执行或并行触发多个技能时，使用流程画布。

## 定位元素：CSS 与 XPath

步骤里的「目标」支持两种写法：

| 写法 | 示例 | 说明 |
|------|------|------|
| CSS | `.checkin` `#sign` `button.sign` | 短、好读 |
| XPath | `//button[contains(.,"执行")]` | Chrome 可一键复制，可按文字找按钮 |
| 强制前缀 | `xpath://...` 或 `css:.btn` | 自动识别不准时使用 |

在 Chrome 中复制：

1. `F12` → 左上角选择元素 → 点页面按钮
2. 在 Elements 里对该 HTML **右键 → Copy（复制）**
3. 选 **Copy selector**（CSS）或 **Copy XPath** / **Copy full XPath**
4. 粘贴到扩展的目标输入框

以 `//` 或 `/html` 开头的会自动按 XPath 解析。

## 步骤类型

| 类型 | 说明 |
|------|------|
| 等待元素 | 直到 CSS/XPath 匹配的元素出现 |
| 点击 | 点击匹配的元素；可勾选「弹窗」监视 OAuth 新标签，「导航」等待整页跳转 |
| 固定等待 | 等待指定毫秒 |
| 等待文本 | 在某元素内出现指定文案 |
| 输入文本 | 向输入框填入内容 |
| 跳转 URL | 在当前标签跳转 |
| 等待 URL | 直到地址栏包含指定字符串，或匹配 `/regex/` |
| 提取数据 | 按 CSS/XPath 提取文本、属性、HTML、列表或表格，并可作为技能返回值 |
| 人工操作(OAuth) | 前置标签并通知你，等待授权完成（URL 匹配或选择器出现） |

点击操作如果打开了新的标签页，AI 探索会检测点击前后的标签变化，等待子标签页加载完成并切换后续观察与操作。生成的点击步骤会记录“监视新标签页 / 在新标签页继续”，普通技能执行时也会接管该子标签页；如果只是当前标签页内跳转，则继续使用原标签页。
AI 探索会优先把成功路径固化为上述标准动作（包括等待和提取），生成技能时不携带默认脚本；只有标准动作无法表达且用户主动选择时，才使用自定义脚本。
如果探索路径包含“提取数据”，生成的技能会自动开启返回值契约，并将命名结果提供给流程调用方。

## 登录 / OAuth 与自动重登

登录技能是独立的技能实体（kind = `login`），在网站操作区创建后，在站点编辑器的「登录技能」下拉里选择。每个技能只归属于一个网站；需要用于其他网站时，请在目标网站下重新创建或安装一份技能。

**登录检测规则**（在技能库里配置）：

- 已登录选择器 / 已登录 URL 包含：判断当前是否已登录，已登录则跳过登录步骤
- 登录页 URL 模式：执行中一旦地址栏命中此模式，立刻中断执行去执行登录
- 未登录关键词：页面出现这些文字时，视为需要登录

执行过程中，以下四种情况会自动触发登录技能，登录成功后重试执行一次：

1. 开始前检查未登录
2. 操作步骤失败且错误信息含登录相关词
3. 页面命中未登录关键词
4. 点击后跳转到登录页

配置 OAuth 登录步骤的典型示例：

| 步骤 | 配置 |
|------|------|
| 点击 | 选择器填 OAuth 按钮；勾选 **监视弹窗**；附加参数可填回调后 URL 片段 |
| 人工操作 | 提示「请完成授权」；超时建议 180000；可填完成后的 URL 匹配 |
| 等待 URL | 匹配回到业务站的地址，如 `example.com/dashboard` |

说明：

- **无法全自动完成**带验证码 / 二次验证 / 账号选择的 OAuth，扩展会前置页面并通知你点一下
- 授权成功后 Cookie 会留在浏览器里，下次若命中「已登录」判定会跳过登录步骤

## 技能库与技能市场

- **技能库**：按网站筛选并管理自动化、登录和验证技能，支持编辑；完整配置可在“导入 / 导出”页导出为 JSON。新建技能从对应网站的“网站技能”操作区进入；技能通过 `siteId` 归属网站，改一处该网站下的所有引用立即生效。
- **技能市场**：设置页填市场源 URL（默认 jsDelivr 上的官方仓库），即可浏览、搜索、一键安装他人分享的技能。安装前必须先选择目标网站，安装后技能归属于该网站并出现在对应技能库中，有新版本时会提示升级。
- **分享技能**：在“导入 / 导出”页导出完整配置，整理其中的技能 JSON 后提交到官方市场仓库或自建源即可被他人安装。
- 搭建自己的市场源：把 `market/` 目录推到任意可通过 HTTP 访问的位置（GitHub Pages、jsDelivr、对象存储等），目录下需要一个 `index.json` 和 `procedures/<marketId>.json`，把 URL 填到「技能市场」页的源地址输入框即可。

## 流程画布

进入 **流程** 标签，新建流程后在画布编辑器中：

- 从左侧拖拽**控制节点**（开始 / 结束 / 条件分支 / 循环 / 并行 / 延时 / 设置变量 / 记录日志）或**浏览器节点**（调用技能 / 执行站点 / 提取数据 / 发送请求）到画布
- 先在画布左侧选择一个网站，再从该网站的**技能库**列表直接拖拽技能到画布，自动生成同时绑定 `siteId` + `procedureId` 的「调用技能」节点
- 从节点端口拖出建立连线，拖动连线端点可重连；右键连线设置 true/false/always 分支
- 双击节点编辑属性；右键节点 / 连线弹出操作菜单；Delete 删除选中项
- 「提取数据」节点在当前技能标签页中按 CSS/XPath 选择器读取文本、属性、HTML、列表或表格，并写入流程变量；「发送请求」节点在后台发送用户配置的 HTTP 请求，可读取变量插值并把响应写回变量
- 数据提取也可以直接作为网站技能中的原子步骤使用；技能开启“返回值”后，调用技能节点会把命名提取结果合并到流程变量，或保存到节点指定的结果变量
- Ctrl+滚轮缩放，Alt+拖空白平移
- 保存后流程出现在 **流程** 列表中，可随时编辑、运行或删除

流程与技能分开存储，互不冲突：技能通过 `siteId` 归属于一个网站，流程节点同时记录网站和技能 ID，负责按顺序 / 条件 / 循环组织技能和站点。

## 自定义脚本示例

如果技能编辑页开启了“返回值”，脚本可以通过 `return` 返回字符串、数组或对象；步骤模式则使用“提取数据”操作的结果名作为返回字段。

```js
const btn = document.querySelector('button.checkin, .checkin');
if (!btn) return { ok: false, message: '未找到操作按钮' };
btn.click();
await new Promise((r) => setTimeout(r, 2000));
const ok = /执行成功|已执行/i.test(document.body.innerText);
return { ok, message: ok ? '执行完成' : '已点击，请人工确认' };
```

## Cloudflare / 防护说明

执行自动化时：

1. 打开目标 URL（默认后台标签）
2. 检测挑战页特征（标题、DOM、Turnstile、路径等）
3. 短暂等待站点自身完成自动验证，并检查 `cf_clearance` Cookie（HttpOnly，仅在本机读取）
4. 如果站点绑定了**验证技能**，执行其中配置的等待、跳转、页面操作或人工确认步骤
5. 根据“验证完成选择器”“验证完成 URL”或防护页消失信号确认已经通过
6. 仍未通过时：**前置标签 + 桌面通知**，进入人工宽限等待
7. 确认通过后从原执行位置继续

验证技能只归属于创建它的网站；每个网站可以配置自己的验证技能。需要用于其他网站时，请在目标网站下重新创建或安装一份，再作为“调用技能”节点放进流程。它用于编排合法的等待和人工接管过程，不会破解验证码、绕过网站安全策略，也不会上传 Cookie。

请先在浏览器中 **手动登录** 目标站点；扩展不会代填账号密码（除非你自己在步骤里配置）。

## 权限说明

| 权限 | 用途 |
|------|------|
| storage | 保存站点、技能、流程与日志 |
| alarms | 每日定时 |
| scripting | 向页面注入执行逻辑 |
| tabs | 打开/关闭/前置标签 |
| cookies | 读取 `cf_clearance` 判断防护是否通过 |
| notifications | 完成与异常提醒 |
| host_permissions | 访问你配置的任意目标站点 |

## 目录结构

项目由 WXT 统一构建，React 负责管理页，React Flow 负责流程画布；后台领域逻辑继续放在 `src/`。可加载产物位于 `.output/chrome-mv3/`。

```
auto-checkin/
├── wxt.config.ts                    # MV3 清单、权限与 WXT 配置
├── components.json                  # shadcn/ui 组件生成配置
├── assets/globals.css               # Tailwind v4 与统一明暗主题令牌
├── components/ui/                   # shadcn/ui 基础组件
├── lib/utils.ts                     # 前端 className 合并工具
├── package.json / tsconfig.json     # WXT + React + TypeScript 构建链
├── entrypoints/                     # WXT 自动发现的扩展入口
│   ├── background.ts                # 后台 Service Worker 宿主
│   ├── options/                     # React 管理页（options.html）
│   └── canvas/                      # React Flow 流程画布（canvas.html）
├── public/icons/                    # WXT 原样复制的扩展图标
├── scripts/
│   └── pack.sh                      # 从 .output/chrome-mv3 打 zip
├── src/
│   ├── background/service-worker.ts # 调度、队列、消息、市场代理
│   ├── lib/
│   │   ├── models.ts        # Site / Procedure / Flow / Log / Task 类型与工厂
│   │   ├── types.ts         # 跨模块共享类型（消息体、运行态等）
│   │   ├── errors.ts        # 错误类 + isFatal
│   │   ├── storage.ts       # chrome.storage 封装 + procedure/flow CRUD
│   │   ├── v1-convert.ts    # 旧版内联步骤 → Procedure 的纯转换（打断循环依赖）
│   │   ├── migrate.ts       # 迁移编排
│   │   ├── flows.ts         # 流程（Flow）持久化
│   │   ├── cancellation.ts  # CancellationToken：中止 / 超时
│   │   ├── tab-session.ts   # TabSession：标签生命周期与注入
│   │   ├── run-context.ts   # RunContext：单次执行编排、CF 等待、自动重登
│   │   ├── execution-queue.ts # ExecutionQueue：串行队列
│   │   ├── scheduler.ts     # 定时、徽标、汇总通知
│   │   ├── recorder.ts      # RecordingSession：人工示范录制
│   │   ├── explorer.ts      # ExplorationSession：LLM 自主探索归纳
│   │   ├── market.ts        # 市场目录拉取 / 安装
│   │   ├── cf.ts            # Cloudflare 检测
│   │   ├── messaging.ts
│   │   └── page/            # 注入页面的自包含函数（不可引用模块作用域，含数据提取）
│   ├── options/             # 迁移对照用旧管理页，不进入 WXT 入口
│   ├── canvas/              # 迁移对照用旧画布，不进入 WXT 入口
│   └── styles/              # 迁移对照用旧样式
├── market/         # 示例市场源（不打进扩展包）
└── README.md
```

> 旧的 `src/options/`、`src/canvas/` 与 `src/styles/` 仅作为迁移对照保留，不进入 WXT 页面入口。
> `src/lib/page/` ���交给 `chrome.scripting.executeScript` 的函数仍必须自包含，不能依赖 import、模块闭包或类实例状态。

## 注意事项

- Manifest V3 的 Service Worker 可能休眠；长时间执行状态会写入 `chrome.storage`，定时依赖 `chrome.alarms`。
- 后台标签可能被浏览器节流；防护等待由扩展后台轮询，不依赖页内定时器。
- 站点改版后选择器可能失效，请更新标准步骤；只有标准动作无法表达的场景才考虑主动配置脚本。
- 请遵守目标网站服务条款，仅用于你有权操作的账号。
- 不建议高频并发执行，扩展默认 **串行** 执行。

## 开发

WXT 负责开发服务器、MV3 清单生成和生产构建；React 页面与后台模块由 Vite 打包。Tailwind CSS v4 提供统一设计令牌，shadcn/ui 源码组件用于管理页与流程画布，TypeScript 继续使用严格模式检查。

```bash
npm install          # 安装 WXT / React / React Flow / TypeScript
npm run dev          # WXT 开发模式（自动重建扩展）
npm run typecheck    # 生成 WXT 类型并执行严格 TypeScript 检查
npm run build        # 类型检查 + WXT Chrome MV3 生产构建
npm run zip          # 生成 WXT 标准 zip
npm run pack         # 构建并打包带 README 的 zip 到 releases/
```

首次或改完代码后，在 `chrome://extensions` 加载 / 重新加载 `.output/chrome-mv3/` 目录。
`.wxt/`、`.output/`、`dist/` 与 `releases/` 均为生成目录，不纳入版本控制。

## 发布 / Release

仓库已配置 GitHub Actions：推送版本标签后自动打包 zip 并创建 Release。

### 自动发布

```bash
# 1. 修改 package.json 中的 version（如 1.0.3）
# 2. 提交并打标签推送
git add -A
git commit -m "chore: release v1.0.3"
git tag v1.0.3
git push origin main
git push origin v1.0.3
```

也可在 GitHub → Actions → **Build & Release** → **Run workflow** 手动触发。

### 本地打包

```bash
bash scripts/pack.sh
# 生成 releases/auto-checkin-v<version>.zip
```
