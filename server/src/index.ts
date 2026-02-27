import express from 'express';
import cors from 'cors';
import { loadProviders, loadApiKeys, saveApiKeys, callLLM } from './llm.js';
import type { LLMRequest, GameRecord } from './types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3100;

app.use(cors());
// Allow larger JSON payloads (game history snapshots can be several MB)
app.use(express.json({ limit: '100mb' }));

// ───── Game History Persistence ─────
const GAME_HISTORY_DIR = path.join(__dirname, '..', 'data', 'history');
if (!fs.existsSync(GAME_HISTORY_DIR)) {
  fs.mkdirSync(GAME_HISTORY_DIR, { recursive: true });
}

function getHistoryFilePath(gameId: string): string {
  return path.join(GAME_HISTORY_DIR, `${gameId}.json`);
}

function listGameHistory(): { id: string; timestamp: string; roleCount: number; rounds: number }[] {
  if (!fs.existsSync(GAME_HISTORY_DIR)) return [];
  const files = fs.readdirSync(GAME_HISTORY_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const id = f.replace('.json', '');
    const filePath = path.join(GAME_HISTORY_DIR, f);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      id,
      timestamp: content.timestamp || new Date().toISOString(),
      roleCount: content.roles?.length || 0,
      rounds: content.ruleSet?.rounds || 0
    };
  }).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function loadGameHistory(gameId: string): GameRecord | null {
  const filePath = getHistoryFilePath(gameId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveGameHistory(record: GameRecord): void {
  const filePath = getHistoryFilePath(record.id);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

function deleteGameHistory(gameId: string): boolean {
  const filePath = getHistoryFilePath(gameId);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ───── API Routes ─────

// GET /api/providers - 获取所有 provider 和模型列表
app.get('/api/providers', (req, res) => {
  try {
    const cfg = loadProviders();
    // 不返回敏感信息
    res.json({
      providers: cfg.providers.map(p => ({
        id: p.id,
        name: p.name,
        models: p.models.map(m => ({ id: m.id, name: m.name, maxTokens: m.maxTokens }))
      })),
      defaultProvider: cfg.defaultProvider,
      defaultModel: cfg.defaultModel
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/keys/status - 检查哪些 provider 已配置 key
app.get('/api/keys/status', (req, res) => {
  try {
    const keys = loadApiKeys();
    const status: Record<string, boolean> = {};
    for (const [provider, key] of Object.entries(keys.keys)) {
      status[provider] = !!(key && !key.startsWith('YOUR_'));
    }
    res.json({ status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keys - 设置某个 provider 的 API key（可选，也可直接改 json 文件）
app.post('/api/keys', (req, res) => {
  try {
    const { providerId, apiKey } = req.body;
    if (!providerId || !apiKey) {
      res.status(400).json({ error: 'Missing providerId or apiKey' });
      return;
    }
    const cfg = loadApiKeys();
    cfg.keys[providerId] = apiKey;
    saveApiKeys(cfg);
    res.json({ success: true, message: `API key saved for ${providerId}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/llm - 调用 LLM（核心接口）
app.post('/api/llm', async (req, res) => {
  try {
    const body: LLMRequest = req.body;
    if (!body.providerId || !body.modelId || !body.messages?.length) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }
    const result = await callLLM(body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/llm/test - 测试某个模型是否可用
app.post('/api/llm/test', async (req, res) => {
  try {
    const { providerId, modelId } = req.body;
    if (!providerId || !modelId) {
      res.status(400).json({ success: false, error: 'Missing providerId or modelId' });
      return;
    }
    const result = await callLLM({
      providerId,
      modelId,
      messages: [
        { role: 'system', content: '你是一个调试助手，请用10个字以内回复"TEST_OK"。' },
        { role: 'user', content: '请回复TEST_OK，最多10个字。' }
      ],
      maxTokens: 50
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───── Game History API Routes ─────

// GET /api/history - 获取所有游戏历史列表
app.get('/api/history', (req, res) => {
  try {
    const history = listGameHistory();
    res.json({ success: true, history });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/history/:id - 获取单个游戏历史详情
app.get('/api/history/:id', (req, res) => {
  try {
    const record = loadGameHistory(req.params.id);
    if (!record) {
      res.status(404).json({ success: false, error: 'Game history not found' });
      return;
    }
    res.json({ success: true, record });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/history - 保存游戏历史
app.post('/api/history', (req, res) => {
  try {
    const record: GameRecord = req.body;
    if (!record.id) {
      record.id = `game_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    if (!record.timestamp) {
      record.timestamp = new Date().toISOString();
    }
    saveGameHistory(record);
    res.json({ success: true, id: record.id, message: 'Game history saved' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/history/:id - 删除游戏历史
app.delete('/api/history/:id', (req, res) => {
  try {
    const success = deleteGameHistory(req.params.id);
    if (!success) {
      res.status(404).json({ success: false, error: 'Game history not found' });
      return;
    }
    res.json({ success: true, message: 'Game history deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───── Start Server ─────
app.listen(PORT, () => {
  console.log(`🚀 AI Coop Game Server running at http://localhost:${PORT}`);
  console.log(`📋 API endpoints:`);
  console.log(`   GET  /api/providers       - 获取 provider 列表`);
  console.log(`   GET  /api/keys/status     - 检查 key 配置状态`);
  console.log(`   POST /api/keys            - 设置 API key`);
  console.log(`   POST /api/llm             - 调用 LLM`);
  console.log(`   POST /api/llm/test        - 测试模型连接`);
  console.log(`   GET  /api/history         - 获取游戏历史列表`);
  console.log(`   GET  /api/history/:id     - 获取单个游戏详情`);
  console.log(`   POST /api/history         - 保存游戏历史`);
  console.log(`   DELETE /api/history/:id   - 删除游戏历史`);
});
