/* ===== AI 合作与博弈游戏 — 前端配置（连接后端） ===== */

const API_SERVER = 'http://localhost:3100';

const PERSONA_STYLE_PRESETS = [
  {
    key: 'kind',
    label: '善良合作',
    prompt: '你是善良且重视集体利益的参与者，优先考虑长期合作与信任，除非持续被背叛。'
  },
  {
    key: 'cunning',
    label: '奸诈伪装',
    prompt: '你擅长伪装与操纵，公开场合偏向说合作，实际行动以自身短期收益最大化为优先。'
  },
  {
    key: 'smart',
    label: '精明理性',
    prompt: '你是精明理性的博弈者，按历史行为动态调整策略，追求长期总收益最大化。'
  },
  {
    key: 'vengeful',
    label: '记仇报复',
    prompt: '你高度重视公平，若被背叛会优先惩罚并降低合作意愿，宁可牺牲部分收益也要反制。'
  },
  {
    key: 'neutral',
    label: '中庸稳健',
    prompt: '你风格稳健保守，不轻信承诺，倾向中间投入并逐步根据证据修正判断。'
  }
];

// ───── 默认角色预设（前端只存人设、模型选择和温度） ─────
const DEFAULT_ROLES = [
  { id:'r1', name:'DeepSeek', color:'#3B82F6', prompt:'你是一个极度理性的分析师，擅长博弈论和数学推理。你从收益最大化角度计算最优策略，善于识别对手行为模式。你冷静、精于计算，语言简练。', providerId:'deepseek', modelId:'deepseek-chat', temperature:0.7 },
  { id:'r2', name:'豆包', color:'#EC4899', prompt:'你是一个热情感性的参与者。你天性善良，倾向合作和信任他人。但如果被欺骗或利用，你会愤怒并采取报复性策略。表达带有情感色彩。', providerId:'openai', modelId:'gpt-4o-mini', temperature:0.8 },
  { id:'r3', name:'元宝', color:'#F59E0B', prompt:'你是社交高手和策略家。擅长说好话、拉拢盟友，表面很大方。但骨子里是机会主义者——承诺阶段表现慷慨，实际决策时选择对自己最有利的。善于伪装。', providerId:'openai', modelId:'gpt-4o', temperature:0.7 },
  { id:'r4', name:'通义千问', color:'#8B5CF6', prompt:'你是稳重的中庸主义者。不走极端，总选中间路线。重视长期合作但不愿当冤大头。根据他人行为逐步调整策略，表达理性克制。', providerId:'qwen', modelId:'qwen-plus', temperature:0.7 },
  { id:'r5', name:'Kimi', color:'#10B981', prompt:'你是谨慎的观察者。话不多但有洞察力。仔细观察他人行为模式，偏好"以牙还牙"——别人对你好就回报，别人背叛就报复。', providerId:'claude', modelId:'claude-sonnet-4-20250514', temperature:0.6 },
  { id:'r6', name:'文心一言', color:'#EF4444', prompt:'你正义感很强，坚信合作共赢。对背叛者绝不手软——哪怕自己付出代价也要惩罚背叛者。说话正经、喜欢讲道理。', providerId:'deepseek', modelId:'deepseek-chat', temperature:0.7 }
];

const RULE_PRESETS = [
  { id:'basic', icon:'🟢', name:'基础版', desc:'纯公共物品博弈，无惩罚无承诺', rounds:5, contributionCap:10, multiplier:1.5, punishCost:2, punishPenalty:5, promisePenalty:3, enablePromise:false, enablePrivateChat:false, enablePublicChat:true, enablePunish:false, decisionVisible:true, punishVisible:true, manualAdjustPerRound:false, scoreboardVisibleToAI:true },
  { id:'punish', icon:'🟡', name:'惩罚版', desc:'加入私聊+惩罚机制', rounds:5, contributionCap:10, multiplier:1.5, punishCost:2, punishPenalty:5, promisePenalty:3, enablePromise:false, enablePrivateChat:true, enablePublicChat:true, enablePunish:true, decisionVisible:true, punishVisible:true, manualAdjustPerRound:false, scoreboardVisibleToAI:true },
  { id:'full', icon:'🔴', name:'完整版', desc:'承诺+私聊+惩罚，完整社会困境', rounds:5, contributionCap:10, multiplier:1.5, punishCost:2, punishPenalty:5, promisePenalty:3, enablePromise:true, enablePrivateChat:true, enablePublicChat:true, enablePunish:true, decisionVisible:true, punishVisible:true, manualAdjustPerRound:false, scoreboardVisibleToAI:true }
];

const PHASE_LABELS = { monologue:'🧠 内心独白', promise:'🤝 承诺阶段', privateChat:'🔒 私聊阶段', publicChat:'📢 公开讨论', decision:'✅ 决策阶段', punish:'⚡ 惩罚阶段', settle:'📊 结算中' };

// ───── 工具函数 ─────
let _uid = 0;
function uid() { return 'm' + Date.now().toString(36) + (++_uid); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch(_) {}
  const cb = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) try { return JSON.parse(cb[1].trim()); } catch(_) {}
  const jm = text.match(/\{[\s\S]*?\}/);
  if (jm) try { return JSON.parse(jm[0]); } catch(_) {}
  return null;
}

function loadLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch(_) { return fallback; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(_) {}
}

// ───── 后端 API 调用 ─────
async function fetchProviders() {
  const res = await fetch(`${API_SERVER}/api/providers`);
  return res.json();
}

async function fetchKeyStatus() {
  const res = await fetch(`${API_SERVER}/api/keys/status`);
  return res.json();
}

async function callLLMBackend(role, sysPrompt, userPrompt, meta) {
  console.debug('[LLM][backend][request]', { provider: role.providerId, model: role.modelId });
  const res = await fetch(`${API_SERVER}/api/llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: role.providerId,
      modelId: role.modelId,
      meta,
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      temperature: role.temperature || 0.7,
      topP: 0.9,
      maxTokens: 500
    })
  });
  const data = await res.json();
  if (!data.success) {
    console.error('[LLM][backend][error]', data.error);
    throw new Error(data.error);
  }
  console.debug('[LLM][backend][response]', { hasContent: !!data.content, usage: data.usage });
  return data.content;
}

async function testModelBackend(providerId, modelId) {
  const res = await fetch(`${API_SERVER}/api/llm/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, modelId })
  });
  return res.json();
}

// ───── Game History API ─────
async function fetchGameHistory() {
  const res = await fetch(`${API_SERVER}/api/history`);
  return res.json();
}

async function fetchGameDetail(gameId) {
  const res = await fetch(`${API_SERVER}/api/history/${gameId}`);
  return res.json();
}

async function saveGameHistory(record) {
  const res = await fetch(`${API_SERVER}/api/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record)
  });
  return res.json();
}

async function deleteGameHistory(gameId) {
  const res = await fetch(`${API_SERVER}/api/history/${gameId}`, {
    method: 'DELETE'
  });
  return res.json();
}
