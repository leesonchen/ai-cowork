# AI Coop Game

多智能体公共物品博弈演示项目，包含前端单页应用（Vue + 原生脚本）与 Node/Express 后端（支持多家 LLM 代理，含 openai 兼容与 anthropic 格式）。

## 目录结构
- `index.html` / `app.js` / `config.js`：前端页面与逻辑（浏览器直接打开即可调试）
- `server/`：后端（TS/Express）
  - `src/`：源码（`index.ts` 路由，`llm.ts` LLM 调用，`types.ts` 类型）
  - `data/providers.json`：模型列表与 baseUrl/api 类型（openai|anthropic）
  - `data/apikeys.json`：各 provider 的 API Key（仅本地存储，不要提交）
  - `dist/`：编译产物（`npm run build` 生成）
- `server/logs/`：运行日志

## 环境要求
- Node.js 18+
- npm / pnpm 任一
- （可选）WSL 对应 curl 测试

## 后端启动
```bash
cd server
npm install
npm run dev    # ts-node 监听 3100 端口
# 或
npm run build && npm run start
```
默认端口：`3100`（可通过 `PORT` 环境变量修改）。

## 配置说明
- `server/data/providers.json`
  - `id`：provider 标识
  - `api`：`openai`（默认）或 `anthropic`，决定请求格式和 header
  - `baseUrl`：代理地址，openai 兼容走 `/chat/completions`，anthropic 走 `/messages`
  - `models`：可用模型列表
- `server/data/apikeys.json`
  - `keys` 对象里填入各 `provider.id` 对应的 Key
  - 不要提交真实 Key 到仓库

## 前端调试
- 直接双击 `index.html` 或通过静态服务器打开。
- 前端默认请求 `http://localhost:3100`，可在 `config.js` 中调整 `API_SERVER`。

## 后端接口（调试）
- `GET  /api/providers`：获取 provider & 模型列表（不含 key）
- `GET  /api/keys/status`：查看哪些 provider 已配置 key
- `POST /api/keys`：设置单个 provider 的 key（body: `{ providerId, apiKey }`）
- `POST /api/llm`：核心 LLM 调用
- `POST /api/llm/test`：连通性测试

### curl 示例
```bash
# 通用 LLM 调用（openai 兼容）
curl -v -X POST http://localhost:3100/api/llm \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "openai",
    "modelId": "gpt-5.2-codex",
    "messages": [{"role":"user","content":"你好"}],
    "temperature": 0.7,
    "maxTokens": 50
  }'

# 测试接口（后端会发送简短 TEST_OK 提示）
curl -v -X POST http://localhost:3100/api/llm/test \
  -H "Content-Type: application/json" \
  -d '{"providerId":"openai","modelId":"gpt-5.2-codex"}'

# anthopic 格式（provider 需配置 "api":"anthropic" 且 baseUrl 对应代理）
curl -v -X POST http://localhost:3100/api/llm \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "anthropic",
    "modelId": "claude-opus-4-6",
    "messages": [{"role":"user","content":"请只回复 TEST_OK"}],
    "maxTokens": 50
  }'
```

## 日志与排查
- 后端启动时会打印可用接口列表。
- `server/src/llm.ts` 已加入详细日志：
  - `[LLM][request]` 请求参数、provider、模型
  - `[LLM][response][status]` 状态码与耗时
  - `[LLM][response]` 是否有内容、usage，若内容为空会附 sample 片段
  - `[LLM][error]/[LLM][exception]` HTTP 错误与异常
- 需要更多网络级排查，可在代理侧抓包或增加超时。

## 部署建议
- 后端：
  - 生产环境建议 `npm run build` 后用 `node dist/index.js` 或 PM2/容器运行。
  - 配置 `PORT`、`providers.json` 与 `apikeys.json`（谨防泄露）。
  - 若有反代，确保转发 Web API（/api/*）且允许 CORS。
- 前端：
  - 可直接静态托管（Nginx/静态空间/对象存储），需保证能访问后端域名。
  - 如需跨域，后端已开放 `cors()`。

## 常见问题
1) **curl 404**：是否用了 `-X POST` 并带上 `-d`；确认路径 `/api/llm`。
2) **content 为空**：检查后端日志 `sample` 片段，确认返回结构是否在 `choices[0].content` 或 `choices[0].message.content`；anthropic 则在 `content[].text`。
3) **未配置 Key**：`/api/keys/status` 查看状态，或直接编辑 `data/apikeys.json`。
4) **模型/Provider 不匹配**：前端已做基本校验；后端 `providers.json` 需保证 modelId 存在。

## 许可证
当前仓库未声明许可证，默认保留所有权利。如需开源请自行添加 LICENSE。
