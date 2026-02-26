import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Provider, ProvidersConfig, ApiKeysConfig, LLMRequest, LLMResponse, ChatMessage } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const LOG_DIR = join(__dirname, '../logs');
const LLM_AUDIT_LOG_FILE = join(LOG_DIR, 'llm_audit.jsonl');

let providersCache: ProvidersConfig | null = null;
let apiKeysCache: ApiKeysConfig | null = null;

const PROVIDER_ALIASES: Record<string, string[]> = {
  claude: ['anthropic'],
  qwen: ['qwen-api', 'qwen-code'],
  deepseek: ['qwen-api', 'xunfei']
};

function safeTruncate(s: string, maxLen: number) {
  if (!s) return s;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…(truncated, total=${s.length})`;
}

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function writeAuditLogLine(obj: any) {
  try {
    ensureLogDir();
    appendFileSync(LLM_AUDIT_LOG_FILE, JSON.stringify(obj) + '\n', 'utf-8');
  } catch (err) {
    // swallow logging errors to avoid breaking production traffic
    console.warn('[LLM][audit][write_failed]', (err as any)?.message || err);
  }
}

function genRequestId() {
  return 'llm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function loadProviders(): ProvidersConfig {
  if (providersCache) return providersCache;
  const raw = readFileSync(join(DATA_DIR, 'providers.json'), 'utf-8');
  providersCache = JSON.parse(raw);
  return providersCache!;
}

export function loadApiKeys(): ApiKeysConfig {
  if (apiKeysCache) return apiKeysCache;
  const raw = readFileSync(join(DATA_DIR, 'apikeys.json'), 'utf-8');
  apiKeysCache = JSON.parse(raw);
  return apiKeysCache!;
}

export function saveApiKeys(config: ApiKeysConfig): void {
  writeFileSync(join(DATA_DIR, 'apikeys.json'), JSON.stringify(config, null, 2));
  apiKeysCache = config;
}

export function findProvider(providerId: string): Provider | undefined {
  const cfg = loadProviders();
  const direct = cfg.providers.find(p => p.id === providerId);
  if (direct) return direct;
  const aliases = PROVIDER_ALIASES[providerId] || [];
  for (const aliasId of aliases) {
    const hit = cfg.providers.find(p => p.id === aliasId);
    if (hit) return hit;
  }
  return undefined;
}

export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  const requestId = genRequestId();
  const start = Date.now();
  const provider = findProvider(req.providerId);
  if (!provider) {
    console.warn('[LLM][invalid][provider]', { requestId, providerId: req.providerId });
    return { success: false, error: `Provider not found: ${req.providerId}` };
  }

  // Audit log: what we are about to send to the model (for isolation verification)
  // NOTE: Does not log any API keys.
  try {
    const maxPerMessage = 2000;
    const maxTotal = 20000;
    const sanitizedMsgs = (req.messages || []).map(m => ({
      role: m.role,
      content: safeTruncate(m.content || '', maxPerMessage)
    }));
    const totalLen = sanitizedMsgs.reduce((acc, m) => acc + (m.content?.length || 0), 0);
    writeAuditLogLine({
      ts: new Date().toISOString(),
      type: 'llm_request',
      requestId,
      providerId: provider.id,
      modelId: req.modelId,
      meta: req.meta,
      temperature: req.temperature ?? 0.7,
      topP: req.topP ?? 0.9,
      maxTokens: req.maxTokens ?? 500,
      messageCount: sanitizedMsgs.length,
      approxTotalChars: totalLen,
      truncated: totalLen > maxTotal,
      messages: totalLen > maxTotal ? safeTruncate(JSON.stringify(sanitizedMsgs), maxTotal) : sanitizedMsgs
    });
  } catch (err) {
    console.warn('[LLM][audit][request_log_failed]', (err as any)?.message || err);
  }

  const model = provider.models.find(m => m.id === req.modelId);
  if (!model) {
    console.warn('[LLM][invalid][model]', { requestId, providerId: req.providerId, modelId: req.modelId });
    return { success: false, error: `Model not found: ${req.modelId}` };
  }

  const keys = loadApiKeys();
  const apiKey = keys.keys[provider.id] || keys.keys[req.providerId];
  if (!apiKey || apiKey.startsWith('YOUR_')) {
    console.warn('[LLM][invalid][apikey]', { requestId, providerId: req.providerId, resolvedProviderId: provider.id });
    return { success: false, error: `API key not configured for provider: ${provider.id}` };
  }

  const isAnthropic = provider.api === 'anthropic';
  const url = provider.baseUrl.replace(/\/+$/, '') + (isAnthropic ? '/messages' : '/chat/completions');

  const body = isAnthropic ? {
    model: req.modelId,
    messages: req.messages.map(m => ({ role: m.role, content: m.content })),
    temperature: req.temperature ?? 0.7,
    top_p: req.topP ?? 0.9,
    max_tokens: req.maxTokens ?? 500,
    anthropic_version: 'vertex-2023-10-20'
  } : {
    model: req.modelId,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    top_p: req.topP ?? 0.9,
    max_tokens: req.maxTokens ?? 500
  };

  console.debug('[LLM][request]', {
    requestId,
    url,
    model: req.modelId,
    provider: provider.id,
    temperature: req.temperature ?? 0.7,
    topP: req.topP ?? 0.9,
    maxTokens: req.maxTokens ?? 500,
    messageCount: req.messages.length
  });

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    console.debug('[LLM][response][status]', { requestId, status: res.status, ms: Date.now() - start });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      console.error('[LLM][error]', { requestId, status: res.status, body: text.slice(0, 200) });
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();

    let content = '';
    let usage;
    if (isAnthropic) {
      const arr = Array.isArray(data.content) ? data.content : [];
      const textItem = arr.find((c: any) => c && typeof c.text === 'string');
      content = textItem?.text || data.output_text || '';
      usage = data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
      } : undefined;
    } else {
      const choice = data.choices?.[0];
      content = choice?.message?.content || choice?.content || '';
      usage = data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined;
    }

    const respMs = Date.now() - start;
    const logPayload: any = {
      requestId,
      model: req.modelId,
      provider: provider.id,
      hasContent: !!content,
      usage,
      ms: respMs
    };

    if (!content) {
      // 附加简短截断调试，方便定位 content 路径
      try {
        logPayload.sample = JSON.stringify(data).slice(0, 400);
      } catch (_) {
        logPayload.sample = '[unserializable]';
      }
    }

    console.debug('[LLM][response]', logPayload);
    writeAuditLogLine({
      ts: new Date().toISOString(),
      type: 'llm_response',
      requestId,
      providerId: provider.id,
      modelId: req.modelId,
      meta: req.meta,
      ok: true,
      ms: respMs,
      hasContent: !!content,
      contentChars: (content || '').length,
      usage
    });
    return { success: true, content, usage };
  } catch (err: any) {
    console.error('[LLM][exception]', { requestId, message: err.message, stack: err.stack, ms: Date.now() - start });
    writeAuditLogLine({
      ts: new Date().toISOString(),
      type: 'llm_response',
      requestId,
      providerId: provider.id,
      modelId: req.modelId,
      meta: req.meta,
      ok: false,
      ms: Date.now() - start,
      error: safeTruncate(err.message || String(err), 400)
    });
    return { success: false, error: err.message };
  }
}
