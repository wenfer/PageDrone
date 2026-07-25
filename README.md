# 自动签到助手（Chrome 扩展）

为各类网站配置 **DOM 模拟签到**，支持：

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
2. **新建站点**，填写名称与签到页面 URL
3. 选择执行模式：
   - **可视化步骤**：例如  
     1. 等待元素 `button.checkin`  
     2. 点击 `button.checkin`  
     3. 等待文本「签到成功」
   - **自定义脚本**：编写返回 `{ ok, message }` 的脚本
4. 可选：填写成功/失败关键词、开启每日定时
5. 保存后点 **立即测试签到**，或在弹窗中点 **全部签到**

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

## 登录 / OAuth 配置

部分站点签到前要先走 OAuth（Google / GitHub / 企业账号等）。可在站点设置里启用 **登录 / OAuth**：

1. 勾选 **启用登录流程**
2. 填写 **已登录选择器** 或 **已登录 URL 包含**（用于判断是否可跳过登录）
3. 配置 **登录步骤**，典型示例如下：

| 步骤 | 配置 |
|------|------|
| 点击 | 选择器填 OAuth 按钮；勾选 **弹窗**；附加参数可填回调后 URL 片段 |
| 人工操作 | 提示「请完成授权」；超时建议 180000；可填完成后的 URL 匹配 |
| 等待 URL | 匹配回到业务站的地址，如 `example.com/dashboard` |

说明：

- **无法全自动完成**带验证码 / 二次验证 / 账号选择的 OAuth，扩展会前置页面并通知你点一下
- 授权成功后 Cookie 会留在浏览器里，下次若命中「已登录」判定会跳过登录步骤
- 定时任务若遇需要人工的 OAuth，可能失败并记为「需登录」，需你在线时跑一次

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
├── background/service-worker.js
├── lib/           # storage / runner / cf 等
├── popup/         # 弹窗
├── options/       # 设置页
├── content/       # 预留
├── icons/
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
