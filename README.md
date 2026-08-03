# 自动签到助手（Chrome 扩展）

为各类网站配置 **DOM 模拟签到**，支持：

- 流程（Procedure）实体：把「签到步骤」和「登录步骤」抽成可复用、可分享的独立单元
- 在线 **流程市场**：一键下载他人分享的签到/登录流程
- 签到中掉线（跳登录页、命中未登录关键词、步骤失败）自动重登并重试一次
- 可视化步骤（等待元素 / 点击 / 输入 / 等待文本等）
- 自定义 JavaScript 脚本
- Cloudflare / 常见防护页 **自动等待**，超时后前置标签并通知人工完成
- 手动一键签到 + 每日定时
- 配置导入 / 导出

> 本扩展在你的真实 Chrome 配置中打开标签页执行操作，复用已有登录态与 Cookie。  
> **不会**破解验证码或绕过安全策略；遇到交互式人机验证时需要你手动点一下。

## 安装

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本目录：`auto-checkin`

## 快速开始

1. 点击扩展图标 → **设置**（或扩展卡片上的「详细信息 → 扩展程序选项」）
2. 进入 **流程库**，新建一个签到流程（默认已包含「点击签到 → 等待成功文案」两步）
3. 回到 **站点管理 → 新建站点**，填写名称与签到页 URL，在「签到流程」下拉里选中刚才的流程
4. 若该站点需要登录，再建一个登录流程并在站点里选中；签到中掉线会自动重登
5. 保存后点 **立即测试签到**，或在弹窗中点 **全部签到**
6. 也可到 **流程市场** 一键安装他人分享的流程

## 定位元素：CSS 与 XPath

步骤里的「目标」支持两种写法：

| 写法 | 示例 | 说明 |
|------|------|------|
| CSS | `.checkin` `#sign` `button.sign` | 短、好读 |
| XPath | `//button[contains(.,"签到")]` | Chrome 可一键复制，可按文字找按钮 |
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
| 人工操作(OAuth) | 前置标签并通知你，等待授权完成（URL 匹配或选择器出现） |

## 登录 / OAuth 与自动重登

登录流程是独立的流程实体（kind = `login`），在站点编辑器的「登录流程」下拉里选择。一个登录流程可被多个站点复用。

**登录检测规则**（在流程库里配置）：

- 已登录选择器 / 已登录 URL 包含：判断当前是否已登录，已登录则跳过登录步骤
- 登录页 URL 模式：签到中一旦地址栏命中此模式，立刻中断签到去执行登录
- 未登录关键词：页面出现这些文字时，视为需要登录

签到执行过程中，以下四种情况会自动触发登录流程，登录成功后重试签到一次：

1. 开始前检查未登录
2. 签到步骤失败且错误信息含登录相关词
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

## 流程库与流程市场

- **流程库**：管理所有签到/登录流程实体，支持新建、复制、编辑、导出为 JSON。站点只引用流程 ID，改一处所有站点生效。
- **流程市场**：设置页填市场源 URL（默认 jsDelivr 上的官方仓库），即可浏览、搜索、一键安装他人分享的流程。安装后流程出现在流程库中，可直接被站点引用，有新版本时会提示升级。
- **分享流程**：流程库编辑器点「导出 JSON」得到标准格式文件；提交到官方市场仓库或自建源即可被他人安装。
- 搭建自己的市场源：把 `market/` 目录推到任意可通过 HTTP 访问的位置（GitHub Pages、jsDelivr、对象存储等），目录下需要一个 `index.json` 和 `procedures/<marketId>.json`，把 URL 填到「流程市场」页的源地址输入框即可。

## 自定义脚本示例

```js
const btn = document.querySelector('button.checkin, .checkin');
if (!btn) return { ok: false, message: '未找到签到按钮' };
btn.click();
await new Promise((r) => setTimeout(r, 2000));
const ok = /签到成功|已签到/i.test(document.body.innerText);
return { ok, message: ok ? '签到完成' : '已点击，请人工确认' };
```

## Cloudflare / 防护说明

执行流程：

1. 打开目标 URL（默认后台标签）
2. 检测挑战页特征（标题、DOM、Turnstile、路径等）
3. 轮询等待挑战消失，并检查 `cf_clearance` Cookie（HttpOnly，由后台读取）
4. 超时后：**前置标签 + 桌面通知**，再进入宽限等待，便于你手动完成验证
5. 通过后继续执行步骤/脚本

请先在浏览器中 **手动登录** 目标站点；扩展不会代填账号密码（除非你自己在步骤里配置）。

## 权限说明

| 权限 | 用途 |
|------|------|
| storage | 保存站点与日志 |
| alarms | 每日定时 |
| scripting | 向页面注入执行逻辑 |
| tabs | 打开/关闭/前置标签 |
| cookies | 读取 `cf_clearance` 判断防护是否通过 |
| notifications | 完成与异常提醒 |
| host_permissions | 访问你配置的任意签到站点 |

## 目录结构

```
auto-checkin/
├── manifest.json
├── background/service-worker.js   # 调度、队列、消息、市场代理
├── lib/
│   ├── models.js     # Site / Procedure / Log / Task 工厂
│   ├── storage.js    # chrome.storage 封装 + procedure CRUD
│   ├── runner.js     # 签到编排、CF 等待、自动重登
│   ├── migrate.js    # 旧版内联步骤 → Procedure 迁移
│   ├── market.js     # 市场目录拉取 / 安装
│   ├── cf.js         # Cloudflare 检测
│   └── messaging.js
├── options/
│   ├── options.html / options.css / options.js
│   └── step-editor.js   # 步骤行编辑器（站点/流程复用）
├── popup/          # 弹窗
├── icons/
├── market/         # 示例市场源（不打进扩展包）
└── README.md
```

## 注意事项

- Manifest V3 的 Service Worker 可能休眠；长任务状态会写入 `chrome.storage`，定时依赖 `chrome.alarms`。
- 后台标签可能被浏览器节流；防护等待由扩展后台轮询，不依赖页内定时器。
- 站点改版后选择器可能失效，请更新步骤或改用脚本。
- 请遵守目标网站服务条款，仅用于你有权操作的账号。
- 不建议高频并发签到，扩展默认 **串行** 执行。

## 开发

纯原生 HTML / CSS / JS（ES Module），无构建步骤。修改代码后在 `chrome://extensions` 点击扩展的 **重新加载** 即可。

## 发布 / Release

仓库已配置 GitHub Actions：推送版本标签后自动打包 zip 并创建 Release。

### 自动发布

```bash
# 1. 修改 manifest.json 中的 version（如 1.0.3）
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
# 生成 dist/auto-checkin-v<version>.zip
```
