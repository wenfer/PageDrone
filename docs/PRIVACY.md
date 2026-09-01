# PageDrone Privacy Policy / 隐私权政策

**Effective Date:** September 1, 2026  
**Last Updated:** September 1, 2026  
**Online URL:** [https://raw.githack.com/anomalyco/auto-checkin/main/docs/privacy.html](https://raw.githack.com/anomalyco/auto-checkin/main/docs/privacy.html) (or GitHub Pages)  
**Developer Contact:** `wenfer@foxmail.com`

---

## 1. Overview / 概述

PageDrone operates **100% locally on your machine**. We do not operate any centralized servers or databases to collect, store, or sell user data, passwords, browsing history, or cookies. All automation configurations, execution logs, and API credentials remain solely on your local computer.

PageDrone 完全在本地设备上运行。我们不设立任何收集、存储或出售用户数据的后端服务器。所有的自动化配置、执行日志及 API 密钥均仅保存在用户本地浏览器中。

---

## 2. Data Collection and Processing Table / 数据收集与处理一览表

| Data Category / 数据类别 | What It Includes / 具体包含内容 | How It Is Used / 使用目的 | Storage Location & Retention / 存储位置与保留周期 |
|---|---|---|---|
| **User Configurations / 用户配置数据** | Target site URLs, custom procedure steps (clicks, inputs, delays), canvas flow nodes, execution schedules. | Used strictly to execute user-defined automation tasks. / 仅用于执行用户显式配置的自动化与流程任务。 | Stored locally in `chrome.storage.local` until modified or deleted by user. / 本地存储，直到用户主动修改或删除。 |
| **User-Provided API Keys / 用户提供的 API 密钥** | Optional AI model API keys (e.g., OpenAI, Anthropic, or custom endpoints) provided voluntarily by the user in Settings. | Used exclusively to authenticate client-side requests directly from browser to user-specified AI provider. / 仅用于从浏览器直连用户指定的大模型。 | Stored securely in local storage; never transmitted to PageDrone or unauthorized parties. / 仅本地存储，绝不外泄。 |
| **Execution & Audit Logs / 执行与审计日志** | Task status, completion timestamps, non-sensitive step diagnosis, and MCP tool call history. | Displayed to user within extension dashboard for review. / 供用户在扩展管理面板中查阅。 | Stored in local storage with automatic circular buffer (up to 2,000 entries) or cleared upon user request. / 本地存储，设 2000 条上限，可一键清空。 |
| **Web Page Content / 网页交互数据** | DOM elements, selectors, structured text extracted during user-configured steps, and temporary viewport screenshots. | Used locally in real-time to locate UI elements, diagnose failures, or extract requested data. / 仅在执行期间于内存中临时处理。 | Processed in memory during execution; never saved permanently to external servers. / 仅执行期间内存驻留，不上传外部服务器。 |

---

## 3. Data We Explicitly DO NOT Collect / 我们明确不收集的数据

1. **No Passwords or Sensitive Input (绝不收集密码):** Password fields are strictly sanitized with placeholders at the script injection level. We never read, extract, or transmit user passwords.
2. **No Browsing Tracking (绝不追踪日常浏览):** We do not track, profile, monitor, or record your web browsing activities.
3. **No Personal Identifiers (无个人身份信息):** No names, email addresses, phone numbers, IP addresses, or device fingerprints are collected.
4. **No Third-Party Analytics / Trackers (无第三方追踪器):** Zero analytics SDKs or advertising trackers.

---

## 4. Third-Party Sharing and Data Transfers / 数据共享与第三方披露

**We do not sell, rent, monetize, or trade your data to any third party under any circumstances.**

Data transmission occurs solely in two optional, user-directed scenarios:
- **User-Configured AI Services:** Direct browser-to-provider communication using the user's own API key.
- **User-Configured HTTP Requests:** Direct request to the user-specified endpoint.

---

## 5. Permissions Justifications / 权限合理必要性

- `storage` / `unlimitedStorage`: Save configurations and logs locally.
- `alarms`: Schedule periodic user-configured automation tasks.
- `scripting`: Inject local automation functions into configured tabs.
- `tabs`: Open, switch, and close automation tabs.
- `cookies`: Read local challenge clearance status (e.g. Cloudflare cookies) locally.
- `notifications`: Show task completion alerts.
- `host_permissions (<all_urls>)`: Allow user-configured automation on any arbitrary website.

---

## 6. User Rights (Export & Deletion) / 用户数据权利

- **Export:** Export all sites, procedures, and flows as JSON at any time.
- **Delete:** Selectively delete individual items, clear logs, or uninstall extension to permanently wipe all stored data.

---

## 7. Chrome Web Store Limited Use Compliance / 有限使用声明

PageDrone strictly complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data/), adhering to all Limited Use requirements.

---

## 8. Contact Information / 联系方式

- **Developer Email:** `wenfer@foxmail.com`
- **GitHub Repository:** [https://github.com/anomalyco/auto-checkin](https://github.com/anomalyco/auto-checkin)
