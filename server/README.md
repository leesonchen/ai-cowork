# AI 合作与博弈游戏 - 后端服务

## 快速开始

```bash
cd server
npm install
npm run dev
```

服务将在 `http://localhost:3100` 启动。

## 配置 API Keys

编辑 `data/apikeys.json`，填入各 Provider 的 API Key：

```json
{
  "keys": {
    "deepseek": "sk-xxxx",
    "openai": "sk-xxxx",
    "qwen": "sk-xxxx",
    "claude": "sk-xxxx"
  }
}
```

## 配置 Providers

编辑 `data/providers.json` 添加或修改 Provider 和模型列表。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 获取所有 Provider 和模型列表 |
| GET | `/api/keys/status` | 检查哪些 Provider 已配置 Key |
| POST | `/api/keys` | 设置某个 Provider 的 API Key |
| POST | `/api/llm` | 调用 LLM（核心接口） |
| POST | `/api/llm/test` | 测试模型连接 |

### POST /api/llm 请求体

```json
{
  "providerId": "deepseek",
  "modelId": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "你是一个助手" },
    { "role": "user", "content": "你好" }
  ],
  "temperature": 0.7,
  "topP": 0.9,
  "maxTokens": 500
}
```

### 响应

```json
{
  "success": true,
  "content": "AI 的回复内容...",
  "usage": {
    "promptTokens": 10,
    "completionTokens": 20,
    "totalTokens": 30
  }
}
```
