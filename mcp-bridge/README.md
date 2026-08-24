# pagedrone-mcp —— PageDrone 本地 MCP 桥接进程

把 PageDrone（Chrome MV3 扩展）暴露为标准 **stdio MCP server**，供 Claude Desktop、Cursor 等任意 MCP 客户端接入。

```
MCP 客户端(stdio) ⇄ pagedrone-mcp（本进程） ⇄ WebSocket ws://127.0.0.1:<port>/<token> ⇄ 扩展 Service Worker
```

## 使用步骤

1. 在扩展设置页「MCP 服务」打开总开关，复制**配对令牌**（默认桥接地址 `ws://127.0.0.1:9377`）。
2. 启动本进程（令牌可用参数固定，也可不传——启动时会随机生成并打印）：

   ```bash
   npx pagedrone-mcp --port 9377 --token <配对令牌>
   # 或环境变量：PAGEDRONE_BRIDGE_PORT / PAGEDRONE_TOKEN
   ```

3. 配置 MCP 客户端，例如 Claude Desktop 的 `claude_desktop_config.json`：

   ```json
   {
     "mcpServers": {
       "pagedrone": {
         "command": "npx",
         "args": ["-y", "pagedrone-mcp", "--port", "9377", "--token", "<配对令牌>"]
       }
     }
   }
   ```

## 行为说明

- 对 MCP 客户端实现 `initialize` / `tools/list` / `tools/call` / `ping`；工具清单与执行全部来自扩展。
- 扩展断连期间 `tools/call` 排队等待（TTL 60s），重连后重放；超时返回明确的 `isError` 结果。
- 扩展推送的 `notifications/progress` 透传给 stdio 客户端（run-* 异步作业的进度）。
- 心跳：扩展每 20s 发送控制帧 ping；本进程超过 90s 未收到任何消息会主动断开，由扩展的指数退避重连接管。

## 开发

```bash
cd mcp-bridge
npm install
node index.js --port 9377 --token <令牌>
```

> 本目录是独立的 npm 包，不参与扩展构建；`npm run build` / `typecheck` 不检查这里的代码。
