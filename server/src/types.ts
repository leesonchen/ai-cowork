// ───── Types ─────
export interface Model {
  id: string;
  name: string;
  maxTokens: number;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  api?: 'openai' | 'anthropic';
  models: Model[];
}

export interface ProvidersConfig {
  providers: Provider[];
  defaultProvider: string;
  defaultModel: string;
}

export interface ApiKeysConfig {
  keys: Record<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  providerId: string;
  modelId: string;
  meta?: {
    roleId?: string;
    roleName?: string;
    phase?: string;
    round?: number;
  };
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  success: boolean;
  content?: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ───── Game History Types ─────
export interface GameRole {
  id: string;
  name: string;
  color: string;
  providerId: string;
  modelId: string;
  temperature: number;
  prompt: string;
}

export interface GameRuleSet {
  rounds: number;
  contributionCap: number;
  multiplier: number;
  punishCost: number;
  punishPenalty: number;
  enablePromise: boolean;
  enablePrivateChat: boolean;
  enablePublicChat: boolean;
  enablePunish: boolean;
  decisionVisible: boolean;
  punishVisible: boolean;
  scoreboardVisibleToAI: boolean;
}

export interface GameMessage {
  id: string;
  type: string;
  actorId?: string;
  targetId?: string;
  round: number;
  content: string;
  rawContent?: string;
}

export interface GameDecision {
  roleId: string;
  round: number;
  contribution: number;
  reason?: string;
  monologue?: string;
}

export interface GameScoreHistory {
  roleId: string;
  round: number;
  delta: number;
  total: number;
}

export interface GameRecord {
  id: string;
  timestamp: string;
  roles: GameRole[];
  ruleSet: GameRuleSet;
  messages: GameMessage[];
  decisions: GameDecision[];
  scoreHistory: GameScoreHistory[];
  finalScores: Record<string, number>;
}
