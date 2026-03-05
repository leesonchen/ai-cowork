/* ===== AI 合作与博弈游戏 — Vue 应用 ===== */
const { createApp, nextTick } = Vue;

function guessProviderIdByModel(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m.startsWith('qwen')) return 'qwen-api';
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt')) return 'openai';
  return 'openai';
}

const LEGACY_PROVIDER_ALIASES = {
  claude: ['anthropic'],
  qwen: ['qwen-api', 'qwen-code'],
  deepseek: ['qwen-api', 'xunfei']
};

function normalizeRole(role) {
  const modelId = role.modelId || role.model || 'deepseek-chat';
  return {
    id: role.id || ('r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)),
    name: role.name || '未命名角色',
    color: role.color || '#6366F1',
    prompt: role.prompt || '',
    providerId: role.providerId || guessProviderIdByModel(modelId),
    modelId,
    temperature: typeof role.temperature === 'number' ? role.temperature : 0.7
  };
}

function normalizeRuleSet(ruleSet) {
  return {
    ...RULE_PRESETS[0],
    ...(ruleSet || {})
  };
}

function normalizeRoundRulePlan(plan, rounds, fallbackRuleSet) {
  const n = Math.max(0, Number(rounds) || 0);
  const arr = Array.isArray(plan) ? plan : [];
  const out = new Array(n + 1).fill(null);
  for (let r = 1; r <= n; r++) {
    const item = arr[r];
    out[r] = item ? normalizeRuleSet(item) : null;
  }
  return out;
}

const savedRoles = loadLS('ai_game_roles', JSON.parse(JSON.stringify(DEFAULT_ROLES)));
const savedAutoScroll = loadLS('ai_game_auto_scroll', true);

createApp({
  data() {
    return {
      activeTab: 'roles', chatView: 'public',
      showRoleModal: false, showInstructions: false, showRoundRuleModal: false,
      showRoundPlanModal: false,
      editingRole: {}, confirmDialog: null,
      selectedAIView: null, aiViewTab: 'history', chartInstance: null,
      llmContextLog: [], llmContextExpanded: {},
      monologueSummaries: [],
      autoScrollEnabled: savedAutoScroll !== false,
      roles: (Array.isArray(savedRoles) ? savedRoles : JSON.parse(JSON.stringify(DEFAULT_ROLES))).map(normalizeRole),
      currentRuleSet: normalizeRuleSet(loadLS('ai_game_rules', { ...RULE_PRESETS[0] })),
      roundRulePlan: [],
      roundRulePlanDraft: null,
      rulePresets: RULE_PRESETS,
      personaStyles: PERSONA_STYLE_PRESETS,
      selectedPersonaStyle: PERSONA_STYLE_PRESETS[0]?.key || '',
      promptKeyword: '',
      promptExpanding: false,
      promptExpandError: null,
      game: { status:'idle', currentRound:0, phase:'', processingAI:null, roundRule:null },
      messages: [], decisions: [], promises: [], scoreHistory: [], scoreTotals: {},
      roundRuleHistory: {},
      roundRuleDraft: null,
      roundRuleResolver: null,
      providers: [], keyStatus: {}, serverConnected: false, serverConnecting: true, serverError: null,
      testingRoleId: null,
      testResultMsg: '',
      testResultType: '',
      // Game History
      gameHistory: [],
      showHistoryModal: false,
      viewingHistoryGame: null,
      // Replay
      isReplaying: false,
      replayPaused: false,
      replaySpeed: 1,
      replayMessageIndex: 0,
      replayMessages: [],
      replayIntervalId: null,
      replayTypewriter: true,
      replaySimulateThinking: false,
      replayCharIndex: 0,
      replayCurrentContent: '',
      replayIsThinking: false,
    };
  },

  computed: {
    tabs() {
      return [
        { key:'roles', icon:'🎭', label:'角色管理' },
        { key:'rules', icon:'⚙️', label:'规则配置' },
        { key:'game',  icon:'🎮', label:'游戏大厅' },
        { key:'stats', icon:'📊', label:'统计分析' },
        { key:'history', icon:'📚', label:'游戏历史' }
      ];
    },
    llmContextByRole() {
      const map = {};
      for (const entry of this.llmContextLog) {
        if (!map[entry.roleId]) map[entry.roleId] = [];
        map[entry.roleId].push(entry);
      }
      for (const roleId in map) {
        map[roleId].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      }
      return map;
    },
    invalidRoles() {
      if (!this.roles.length) return [];
      if (!this.providers.length) return this.roles;
      return this.roles.filter(role => !this.isRoleConfigValid(role));
    },
    canStart() {
      return this.roles.length >= 2 && this.game.status === 'idle' && this.serverConnected && this.invalidRoles.length === 0;
    },
    phaseLabel() { return PHASE_LABELS[this.game.phase] || ''; },
    filteredMessages() {
      // Replay mode: show messages up to current index with typewriter effect
      if (this.isReplaying) {
        const visible = this.replayMessages.slice(0, this.replayMessageIndex + 1).map(m => ({ ...m }));
        // Apply typewriter effect to the last message
        if (this.replayTypewriter && visible.length > 0) {
          const lastIdx = visible.length - 1;
          const lastMsg = visible[lastIdx];
          if (lastMsg.type !== 'system' && lastMsg.type !== 'score_settle') {
            const fullContent = lastMsg.rawContent || lastMsg.content;
            // During thinking: hide content (show empty); after thinking: typewriter effect
            const displayContent = this.replayIsThinking ? '' : fullContent.slice(0, this.replayCharIndex);
            visible[lastIdx] = {
              ...lastMsg,
              content: displayContent,
              rawContent: displayContent
            };
          }
        }
        return visible;
      }
      if (this.chatView === 'all') return this.messages;
      if (this.chatView === 'public') {
        return this.messages.filter(m => {
          if (m.type === 'private_message') return false;
          if (m.type === 'decision') return this.getRuleForRound(m.round).decisionVisible;
          if (m.type === 'punish') return this.getRuleForRound(m.round).punishVisible;
          return true;
        });
      }
      return this.messages.filter(m => m.type === 'private_message' || m.type === 'system');
    },
    currentRoundDecisions() {
      return this.decisions.filter(d => d.round === this.game.currentRound);
    },
    currentRoundPromises() {
      return this.promises.filter(p => p.round === this.game.currentRound);
    },
    currentRoundSummary() {
      const decs = this.currentRoundDecisions;
      if (!decs.length) return null;
      const total = decs.reduce((s, d) => s + d.contribution, 0);
      const activeRule = this.game.roundRule || this.currentRuleSet;
      const pool = total * activeRule.multiplier;
      return { totalContrib: total, poolValue: pool, perPerson: pool / this.roles.length };
    },
    scoreboard() {
      return this.roles.map(r => ({ roleId: r.id, total: this.scoreTotals[r.id] || 0 }))
        .sort((a, b) => b.total - a.total);
    },
    aiViewDecisions() {
      if (!this.selectedAIView) return [];
      const rows = [];
      for (let r = 1; r <= (this.game.currentRound || 0); r++) {
        const dec = this.decisions.find(d => d.round === r && d.roleId === this.selectedAIView);
        const sh = this.scoreHistory.find(s => s.round === r && s.roleId === this.selectedAIView);
        const pr = this.getPromiseForRound(this.selectedAIView, r);
        const pu = this.messages.find(m => m.round === r && m.type === 'punish' && m.actorId === this.selectedAIView);
        rows.push({
          round: r, contribution: dec ? dec.contribution : '—',
          promise: pr && typeof pr.amount === 'number' ? pr.amount : '',
          brokePromise: pr && dec && typeof pr.amount === 'number' && dec.contribution < pr.amount,
          punished: pu ? (pu.targetId ? this.getRoleName(pu.targetId) : '（未惩罚）') : '',
          delta: sh ? sh.delta : 0, total: sh ? sh.total : 0
        });
      }
      return rows;
    },
    aiViewMessages() {
      if (!this.selectedAIView) return [];
      const id = this.selectedAIView;
      const role = this.roles.find(r => r.id === id);
      if (!role) return [];
      return this.messages
        .filter(m => {
          if (!m.round) return false;
          return this.canRoleSeeMessage(role, m, this.getRuleForRound(m.round));
        })
        .map(m => ({
          ...m,
          content: this.getMsgContentForRole(role, m, this.getRuleForRound(m.round))
        }))
        .filter(m => !!m.content);
    },
    aiViewContextLatest() {
      if (!this.selectedAIView) return null;
      const list = this.llmContextByRole[this.selectedAIView] || [];
      if (!list.length) return null;
      const entry = list[list.length - 1];
      return {
        ...entry,
        phaseLabel: this.formatPhaseLabel(entry.phase),
        isExpanded: !!this.llmContextExpanded[entry.id]
      };
    },
    aiViewContextEntries() {
      if (!this.selectedAIView) return [];
      const list = this.llmContextByRole[this.selectedAIView] || [];
      return list.slice().reverse().map(entry => ({
        ...entry,
        phaseLabel: this.formatPhaseLabel(entry.phase),
        isExpanded: !!this.llmContextExpanded[entry.id]
      }));
    }
  },

  watch: {
    roles: { handler(v) { saveLS('ai_game_roles', v); }, deep: true },
    currentRuleSet: { handler(v) {
      const normalized = normalizeRuleSet(v);
      saveLS('ai_game_rules', normalized);
      this.roundRulePlan = normalizeRoundRulePlan(this.roundRulePlan, normalized.rounds, normalized);
    }, deep: true },
    roundRulePlan: { handler(v) { saveLS('ai_game_round_rule_plan', v); }, deep: true },
    activeTab(v) { if (v === 'stats') this.$nextTick(() => this.renderChart()); },
    autoScrollEnabled(val) { saveLS('ai_game_auto_scroll', val); }
  },

  methods: {
    // ── Role CRUD ──
    async initProviders(retryCount = 1) {
      this.serverConnecting = true;
      try {
        const [pRes, kRes] = await Promise.all([fetchProviders(), fetchKeyStatus()]);
        this.providers = pRes.providers || [];
        this.keyStatus = kRes.status || {};
        this.reconcileRolesWithProviders();
        this.roundRulePlan = normalizeRoundRulePlan(loadLS('ai_game_round_rule_plan', []), this.currentRuleSet.rounds, this.currentRuleSet);
        this.serverConnected = true;
        this.serverError = null;
        console.log('[Init] Providers loaded:', this.providers.length, 'Key status:', this.keyStatus);
      } catch(err) {
        console.error('[Init] Failed to connect server:', err.message);
        this.serverConnected = false;
        this.serverError = err.message;
        if (retryCount > 0) {
          await sleep(800);
          return this.initProviders(retryCount - 1);
        }
      } finally {
        this.serverConnecting = false;
      }
    },
    getProviderName(providerId) { const p = this.providers.find(x => x.id === providerId); return p ? p.name : providerId; },
    getModelName(providerId, modelId) {
      const p = this.providers.find(x => x.id === providerId);
      if (!p) return modelId;
      const m = p.models.find(x => x.id === modelId);
      return m ? m.name : modelId;
    },
    getPreferredProvider() {
      return this.providers.find(p => p.id === 'openai') || this.providers[0] || null;
    },
    isRoleConfigValid(role) {
      if (!role || !this.providers.length) return false;
      const provider = this.providers.find(p => p.id === role.providerId);
      if (!provider) return false;
      return provider.models.some(m => m.id === role.modelId);
    },
    findBestModelId(provider, preferredModelId, fallbackHint) {
      if (!provider || !provider.models?.length) return preferredModelId;
      if (provider.models.some(m => m.id === preferredModelId)) return preferredModelId;

      const rawNeedle = (preferredModelId || fallbackHint || '').toLowerCase();
      const models = provider.models;
      if (rawNeedle) {
        const fuzzy = models.find(m => rawNeedle.includes(m.id.toLowerCase()) || m.id.toLowerCase().includes(rawNeedle));
        if (fuzzy) return fuzzy.id;

        const tokens = rawNeedle.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
        for (const t of tokens) {
          const hit = models.find(m => m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t));
          if (hit) return hit.id;
        }
      }

      return models[0].id;
    },
    resolveLegacyProviderId(providerId) {
      const aliases = LEGACY_PROVIDER_ALIASES[providerId] || [];
      return aliases.find(id => this.providers.some(p => p.id === id)) || null;
    },
    reconcileRolesWithProviders() {
      if (!this.providers.length || !this.roles.length) return;
      let changed = 0;
      const nextRoles = this.roles.map(role => {
        const next = { ...role };
        let provider = this.providers.find(p => p.id === next.providerId);

        if (!provider) {
          const legacyId = this.resolveLegacyProviderId(next.providerId);
          if (legacyId) {
            next.providerId = legacyId;
            provider = this.providers.find(p => p.id === legacyId);
          }
        }

        if (!provider && next.modelId) {
          const byModel = this.providers.find(p => p.models.some(m => m.id === next.modelId));
          if (byModel) {
            next.providerId = byModel.id;
            provider = byModel;
          }
        }

        if (!provider) {
          provider = this.getPreferredProvider();
          next.providerId = provider.id;
        }

        if (provider && !provider.models.some(m => m.id === next.modelId)) {
          next.modelId = this.findBestModelId(provider, next.modelId, role.providerId);
        }

        if (next.providerId !== role.providerId || next.modelId !== role.modelId) changed++;
        return next;
      });

      if (changed > 0) {
        this.roles = nextRoles.map(normalizeRole);
        console.warn('[Init] Reconciled roles with provider config', { changed });
      }
    },
    addRole() {
      const preferredProvider = this.getPreferredProvider();
      const defProvider = preferredProvider?.id || 'openai';
      const defModel = preferredProvider?.models?.[0]?.id || '';
      this.editingRole = { id:'', name:'', color:'#6366F1', prompt:'', providerId: defProvider, modelId: defModel, temperature:0.7 };
      this.selectedPersonaStyle = this.personaStyles[0]?.key || '';
      this.promptKeyword = '';
      this.promptExpandError = null;
      this.showRoleModal = true;
    },
    editRole(role) {
      this.editingRole = { ...role };
      this.selectedPersonaStyle = this.personaStyles[0]?.key || '';
      this.promptKeyword = '';
      this.promptExpandError = null;
      this.showRoleModal = true;
    },
    applyPersonaStyle() {
      const style = this.personaStyles.find(s => s.key === this.selectedPersonaStyle);
      if (!style) return;
      const base = (this.editingRole.prompt || '').trim();
      this.editingRole.prompt = base ? `${base}\n${style.prompt}` : style.prompt;
    },
    async expandPromptByKeyword() {
      this.promptExpandError = null;
      const keyword = (this.promptKeyword || '').trim();
      if (!keyword) return;
      this.promptExpanding = true;
      try {
        const tmpRole = {
          providerId: this.editingRole.providerId,
          modelId: this.editingRole.modelId,
          temperature: this.editingRole.temperature || 0.7
        };
        const sys = '你是角色人设提示词设计专家，擅长把简短关键词扩展成可直接用于LLM博弈角色扮演的高质量System Prompt。';
        const user = `请基于关键词“${keyword}”生成一段角色人设提示词，场景是多人公共物品博弈，需包含：\n1) 性格特征\n2) 决策倾向\n3) 对合作/背叛/惩罚的态度\n4) 语言风格\n字数120-220字，直接输出提示词正文，不要解释。`;
        const expanded = await callLLMBackend(tmpRole, sys, user);
        this.editingRole.prompt = (expanded || '').trim();
      } catch (err) {
        this.promptExpandError = err.message;
      } finally {
        this.promptExpanding = false;
      }
    },
    async testRole(role) {
      this.testingRoleId = role.id;
      this.testResultMsg = '';
      this.testResultType = '';
      this.addMsg('system', null, null, 0, `🧪 正在测试 ${role.name} (${this.getModelName(role.providerId, role.modelId)})...`);
      try {
        const result = await testModelBackend(role.providerId, role.modelId);
        if (result.success) {
          this.addMsg('system', null, null, 0, `✅ ${role.name} 返回: ${result.content?.slice(0,120) || 'OK'}`);
          this.testResultMsg = `${role.name} 测试通过：${result.content?.slice(0,80) || 'OK'}`;
          this.testResultType = 'success';
        } else {
          this.addMsg('system', null, null, 0, `❌ ${role.name} 调用失败: ${result.error}`);
          this.testResultMsg = `${role.name} 测试失败：${result.error}`;
          this.testResultType = 'error';
        }
      } catch(err) {
        this.addMsg('system', null, null, 0, `❌ ${role.name} 调用失败: ${err.message}`);
        this.testResultMsg = `${role.name} 测试异常：${err.message}`;
        this.testResultType = 'error';
      }
      setTimeout(() => { this.testResultMsg = ''; this.testResultType = ''; }, 5000);
      this.testingRoleId = null;
    },
    saveRole() {
      const r = this.editingRole;
      if (!r.name) return;
      r.temperature = typeof r.temperature === 'number' ? r.temperature : 0.7;
      const normalized = normalizeRole(r);
      if (normalized.id) {
        const i = this.roles.findIndex(x => x.id === normalized.id);
        if (i >= 0) this.roles.splice(i, 1, { ...normalized });
        else this.roles.push({ ...normalized });
      }
      this.showRoleModal = false;
    },
    deleteRole(id) {
      this.confirmDialog = { message: '确定删除该角色？', action: () => { this.roles = this.roles.filter(r => r.id !== id); } };
    },
    applyPreset(p) { Object.assign(this.currentRuleSet, normalizeRuleSet(JSON.parse(JSON.stringify(p)))); },

    // ── Helpers ──
    getRoleName(id) { const r = this.roles.find(x => x.id === id); return r ? r.name : '系统'; },
    getRoleColor(id) { const r = this.roles.find(x => x.id === id); return r ? r.color : '#6B7280'; },
    getTotal(id) { return (this.scoreTotals[id] || 0).toFixed(1); },
    getPromiseForRound(roleId, round) {
      return this.promises.find(p => p.roleId === roleId && p.round === round);
    },
    getMonologueSummary(roleId, round) {
      return this.monologueSummaries.find(m => m.roleId === roleId && m.round === round);
    },
    formatMonologue(input) {
      const raw = (input || '').trim();
      if (!raw) return '';
      if (raw.startsWith('【') && raw.endsWith('】')) return raw;
      return `【${raw.replace(/^[\[【]+/, '').replace(/[\]】]+$/, '')}】`;
    },
    stripHtml(html) {
      return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    },
    stripThink(content) {
      if (!content) return content;
      return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    },
    stripMonologue(content) {
      if (!content) return content;
      // remove inline monologues like "【...】 |" or standalone "【...】"
      return content
        .replace(/【[^】]*】\s*\|\s*/g, '')
        .replace(/【[^】]*】/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    },
    formatRuleSummary(rr) {
      if (!rr) return '';
      return `承诺:${rr.enablePromise ? '开' : '关'} 私聊:${rr.enablePrivateChat ? '开' : '关'} 公开:${rr.enablePublicChat ? '开' : '关'} 惩罚:${rr.enablePunish ? '开' : '关'}${rr.enablePunish ? (rr.punishOnlyBreaker !== false ? '(仅限违约者)' : '(可任意惩罚)') : ''} | 决策可见:${rr.decisionVisible ? '是' : '否'} 惩罚可见:${rr.punishVisible ? '是' : '否'} AI可见分数:${rr.scoreboardVisibleToAI ? '是' : '否'} | 上限:${rr.contributionCap} 倍数:${rr.multiplier}`;
    },
    getMsgContentForRole(role, msg, roundRule) {
      // Principle: inner monologue is user-only; no AI should see any monologue.
      if (!msg) return '';
      const rr = roundRule || this.currentRuleSet;
      if (!this.canRoleSeeMessage(role, msg, rr)) return '';
      // Monologue messages are never visible to AI (user-only)
      if (msg.type === 'monologue') return '';
      let c = msg.content;
      c = this.stripThink(c);
      if (msg.type === 'decision' || msg.type === 'punish') {
        c = this.stripMonologue(c);
      }
      return c;
    },
    getVisibleRoundEventsForContext(role, round, roundRule) {
      const rr = roundRule || this.currentRuleSet;
      const thisRound = this.messages.filter(m => m.round === round && this.canRoleSeeMessage(role, m, rr));
      const seen = new Set();
      const events = [];
      for (const m of thisRound) {
        const content = this.getMsgContentForRole(role, m, rr);
        if (!content) continue;
        const key = `${m.type}|${m.actorId || ''}|${m.targetId || ''}|${content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({ msg: m, content });
      }
      return events;
    },
    getPunishSummaryForRole(role, round, roundRule) {
      const rr = roundRule || this.currentRuleSet;
      if (!rr.enablePunish) return '';
      const punishEvents = this.messages.filter(m => m.round === round && m.type === 'punish' && this.canRoleSeeMessage(role, m, rr));
      if (!punishEvents.length) {
        return rr.punishVisible ? '无人惩罚' : '你未观察到相关惩罚信息';
      }
      const parts = [];
      const seen = new Set();
      for (const m of punishEvents) {
        const content = this.getMsgContentForRole(role, m, rr) || '惩罚';
        const effectTag = m.targetId && m.punishEffective === false ? '（失效）' : '';
        const line = `${this.getRoleName(m.actorId)}→${m.targetId ? this.getRoleName(m.targetId) : '（无目标）'}${effectTag}：${content}`;
        if (seen.has(line)) continue;
        seen.add(line);
        parts.push(line);
      }
      return parts.join('；');
    },
    buildRecentHistoryLines(role, round) {
      const lines = [];
      if (round <= 1) return lines;
      for (let pr = Math.max(1, round - 3); pr < round; pr++) {
        const rd = this.decisions.filter(d => d.round === pr);
        const prRule = this.getRuleForRound(pr);
        lines.push(`第${pr}轮规则：${this.formatRuleSummary(prRule)}`);
        if (prRule.decisionVisible) {
          const promiseLine = prRule.enablePromise
            ? rd.map(d => {
              const prPromise = this.getPromiseForRound(d.roleId, pr);
              const promiseAmount = prPromise && typeof prPromise.amount === 'number' ? prPromise.amount : '—';
              return `${this.getRoleName(d.roleId)}投${d.contribution}/承诺${promiseAmount}`;
            }).join('，')
            : rd.map(d => `${this.getRoleName(d.roleId)}投${d.contribution}`).join('，');
          lines.push(`第${pr}轮：${promiseLine}`);
        } else {
          const own = rd.find(d => d.roleId === role.id);
          let line = `第${pr}轮：他人决策隐藏`;
          if (own) line += `，你投了${own.contribution}`;
          lines.push(line);
        }
        if (prRule.enablePunish) {
          lines.push(`第${pr}轮惩罚：${this.getPunishSummaryForRole(role, pr, prRule)}`);
        }
      }
      return lines;
    },
    buildThisRoundEventLines(role, round, roundRule) {
      const rr = roundRule || this.currentRuleSet;
      const lines = [];
      const events = this.getVisibleRoundEventsForContext(role, round, rr);
      for (const { msg: m, content } of events) {
        if (m.type === 'promise') lines.push(`[承诺]${this.getRoleName(m.actorId)}：${content}`);
        else if (m.type === 'public_message') lines.push(`[公开]${this.getRoleName(m.actorId)}：${content}`);
        else if (m.type === 'private_message') lines.push(`[私聊]${this.getRoleName(m.actorId)}→${this.getRoleName(m.targetId)}：${content}`);
        else if (m.type === 'decision') lines.push(`[决策]${this.getRoleName(m.actorId)}：${content}`);
        else if (m.type === 'punish') {
          const effectTag = m.targetId && m.punishEffective === false ? '（失效）' : '';
          lines.push(`[惩罚${effectTag}]${this.getRoleName(m.actorId)}→${m.targetId ? this.getRoleName(m.targetId) : '（无目标）'}：${content}`);
        }
      }
      return lines;
    },
    buildLLMContextAuditMeta(role, round, phase) {
      const rr = this.getRuleForRound(round);
      const promiseSnapshot = rr.enablePromise
        ? this.roles.map(p => {
          const pr = this.getPromiseForRound(p.id, round);
          return {
            roleId: p.id,
            roleName: p.name,
            amount: pr && typeof pr.amount === 'number' ? pr.amount : null
          };
        })
        : [];
      return {
        roleId: role.id,
        roleName: role.name,
        providerId: role.providerId,
        modelId: role.modelId,
        temperature: role.temperature,
        round,
        phase,
        ruleSummary: this.formatRuleSummary(rr),
        rule: {
          enablePromise: rr.enablePromise,
          enablePrivateChat: rr.enablePrivateChat,
          enablePublicChat: rr.enablePublicChat,
          enablePunish: rr.enablePunish,
          punishOnlyBreaker: rr.punishOnlyBreaker !== false,
          decisionVisible: rr.decisionVisible,
          punishVisible: rr.punishVisible,
          scoreboardVisibleToAI: rr.scoreboardVisibleToAI,
          contributionCap: rr.contributionCap,
          multiplier: rr.multiplier,
          punishCost: rr.punishCost,
          punishPenalty: rr.punishPenalty
        },
        recentHistory: this.buildRecentHistoryLines(role, round),
        thisRoundEvents: this.buildThisRoundEventLines(role, round, rr),
        promiseSnapshot
      };
    },
    getRoundPromiseSummary(round) {
      const rr = this.getRuleForRound(round);
      if (!rr.enablePromise) return '';
      const items = this.roles.map(p => {
        const pr = this.getPromiseForRound(p.id, round);
        const amount = pr && typeof pr.amount === 'number' ? pr.amount : '—';
        return `${p.name}:${amount}`;
      });
      return items.join('，');
    },
    getRoundPunishSummary(round) {
      const rr = this.getRuleForRound(round);
      if (!rr.enablePunish) return '';
      const events = this.messages.filter(m => m.round === round && m.type === 'punish');
      if (!events.length) return '无人惩罚';
      const parts = [];
      const seen = new Set();
      for (const m of events) {
        const content = this.stripMonologue(this.stripThink(m.content || '惩罚')) || '惩罚';
        const effectTag = m.targetId && m.punishEffective === false ? '（失效）' : '';
        const line = `${this.getRoleName(m.actorId)}→${m.targetId ? this.getRoleName(m.targetId) : '（无目标）'}${effectTag}：${content}`;
        if (seen.has(line)) continue;
        seen.add(line);
        parts.push(line);
      }
      return parts.join('；');
    },
    getOwnPunishDelta(role, round, roundRule) {
      const rr = roundRule || this.currentRuleSet;
      if (!rr.enablePunish) return 0;
      const events = this.messages.filter(m => m.round === round && m.type === 'punish');
      let delta = 0;
      for (const e of events) {
        if (e.actorId === role.id && e.targetId) delta -= (rr.punishCost || 0);
        if (e.targetId === role.id && e.punishEffective !== false) delta -= (rr.punishPenalty || 0);
      }
      return delta;
    },
    isPunishBreacher(targetRole, round, roundRule) {
      const rr = roundRule || this.currentRuleSet;
      if (!rr.enablePromise) return true;
      const promise = this.getPromiseForRound(targetRole.id, round);
      if (!promise || typeof promise.amount !== 'number') return false;
      const dec = this.decisions.find(d => d.round === round && d.roleId === targetRole.id);
      if (!dec) return false;
      return dec.contribution < promise.amount;
    },
    getRuleForRound(round) {
      return this.roundRuleHistory[round] || this.currentRuleSet;
    },
    getPlanRuleForRound(round) {
      const rs = this.roundRulePlan?.[round];
      return rs ? normalizeRuleSet(rs) : null;
    },
    canRoleSeeMessage(role, msg, roundRule) {
      const rr = roundRule || this.currentRuleSet;
      if (!msg || msg.type === 'system' || msg.type === 'score_settle') return false;
      // Monologue is user-only (not visible to any AI including self)
      if (msg.type === 'monologue') return false;
      if (msg.type === 'promise' || msg.type === 'public_message') return true;
      if (msg.type === 'private_message') return msg.actorId === role.id || msg.targetId === role.id;
      if (msg.type === 'decision') return rr.decisionVisible || msg.actorId === role.id;
      if (msg.type === 'punish') return rr.punishVisible || msg.actorId === role.id || msg.targetId === role.id;
      return false;
    },
    async getRoundRuleWithManualAdjust(round) {
      const base = { ...this.currentRuleSet };
      if (!base.manualAdjustPerRound) return base;

      const planned = this.getPlanRuleForRound(round);
      if (planned) return { ...planned };

      this.roundRuleDraft = { ...base };
      this.showRoundRuleModal = true;
      return new Promise(resolve => {
        this.roundRuleResolver = resolve;
      });
    },
    openRoundPlanModal() {
      const rounds = Number(this.currentRuleSet.rounds) || 0;
      const draft = normalizeRoundRulePlan(this.roundRulePlan, rounds, this.currentRuleSet);
      for (let r = 1; r <= rounds; r++) {
        if (!draft[r]) draft[r] = { ...this.currentRuleSet };
      }
      this.roundRulePlanDraft = draft;
      this.showRoundPlanModal = true;
    },
    applyGlobalToAllRoundsInDraft() {
      if (!this.roundRulePlanDraft) return;
      const rounds = Number(this.currentRuleSet.rounds) || 0;
      for (let r = 1; r <= rounds; r++) {
        this.roundRulePlanDraft[r] = { ...this.currentRuleSet };
      }
    },
    clearRoundPlanDraft() {
      if (!this.roundRulePlanDraft) return;
      const rounds = Number(this.currentRuleSet.rounds) || 0;
      const draft = normalizeRoundRulePlan([], rounds, this.currentRuleSet);
      for (let r = 1; r <= rounds; r++) {
        draft[r] = { ...this.currentRuleSet };
      }
      this.roundRulePlanDraft = draft;
    },
    clearRoundPlan() {
      const rounds = Number(this.currentRuleSet.rounds) || 0;
      this.roundRulePlan = normalizeRoundRulePlan([], rounds, this.currentRuleSet);
    },
    saveRoundPlan() {
      if (!this.roundRulePlanDraft) return;
      const rounds = Number(this.currentRuleSet.rounds) || 0;
      const out = normalizeRoundRulePlan(this.roundRulePlanDraft, rounds, this.currentRuleSet);
      this.roundRulePlan = out;
      this.roundRulePlanDraft = null;
      this.showRoundPlanModal = false;
    },
    cancelRoundPlan() {
      this.roundRulePlanDraft = null;
      this.showRoundPlanModal = false;
    },
    confirmRoundRule() {
      if (!this.roundRuleResolver) return;
      const resolve = this.roundRuleResolver;
      this.roundRuleResolver = null;
      this.showRoundRuleModal = false;
      const draft = this.roundRuleDraft ? { ...this.roundRuleDraft } : { ...this.currentRuleSet };
      this.roundRuleDraft = null;
      resolve(draft);
    },
    useCurrentRuleDirectly() {
      if (!this.roundRuleResolver) return;
      const resolve = this.roundRuleResolver;
      this.roundRuleResolver = null;
      this.showRoundRuleModal = false;
      this.roundRuleDraft = null;
      resolve({ ...this.currentRuleSet });
    },
    exportLogsMarkdown() {
      const lines = [];
      const now = new Date();
      
      // Title & Metadata
      lines.push('# 🤖 AI 合作与博弈游戏日志');
      lines.push('');
      lines.push('| 属性 | 值 |');
      lines.push('|------|-----|');
      lines.push(`| 导出时间 | ${now.toLocaleString()} |`);
      lines.push(`| 总轮数 | ${this.currentRuleSet.rounds} |`);
      lines.push(`| 玩家数 | ${this.roles.length} |`);
      lines.push(`| 公共池倍数 | ×${this.currentRuleSet.multiplier} |`);
      lines.push(`| 投入上限 | ${this.currentRuleSet.contributionCap} 代币 |`);
      lines.push('');
      
      // Role Configuration
      lines.push('## 🎭 角色配置');
      lines.push('');
      lines.push('| 角色 | 模型 | 温度 | 人设 |');
      lines.push('|------|------|------|------|');
      for (const role of this.roles) {
        const provider = this.getProviderName(role.providerId);
        const model = this.getModelName(role.providerId, role.modelId);
        const persona = (role.prompt || '').replace(/\n/g, ' ').substring(0, 50) + '...';
        lines.push(`| **${role.name}** | ${provider}/${model} | ${role.temperature} | ${persona} |`);
      }
      lines.push('');
      
      // Round Rules
      lines.push('## ⚙️ 每轮规则配置');
      lines.push('');
      lines.push('| 轮次 | 承诺 | 私聊 | 公开 | 惩罚 | 决策可见 | 惩罚可见 | AI看分数 | 上限 | 倍数 |');
      lines.push('|------|:----:|:----:|:----:|:----:|:--------:|:--------:|:--------:|------:|------:|');
      for (let r = 1; r <= (this.currentRuleSet.rounds || 0); r++) {
        const rr = this.getRuleForRound(r);
        lines.push(`| R${r} | ${rr.enablePromise ? '✓' : '✗'} | ${rr.enablePrivateChat ? '✓' : '✗'} | ${rr.enablePublicChat ? '✓' : '✗'} | ${rr.enablePunish ? '✓' : '✗'} | ${rr.decisionVisible ? '✓' : '✗'} | ${rr.punishVisible ? '✓' : '✗'} | ${rr.scoreboardVisibleToAI ? '✓' : '✗'} | ${rr.contributionCap} | ${rr.multiplier} |`);
      }
      lines.push('');
      
      // Final Scoreboard
      lines.push('## 🏆 最终排行榜');
      lines.push('');
      lines.push('| 排名 | 角色 | 最终得分 |');
      lines.push('|:----:|------|---------:|');
      const finalScores = this.scoreboard;
      finalScores.forEach((s, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
        lines.push(`| ${medal} | **${this.getRoleName(s.roleId)}** | ${s.total.toFixed(1)} |`);
      });
      lines.push('');
      
      // Round by Round Detail
      lines.push('## 📋 详细对局记录');
      lines.push('');
      
      for (let r = 1; r <= (this.currentRuleSet.rounds || 0); r++) {
        const rr = this.getRuleForRound(r);
        lines.push(`### 第 ${r} 轮`);
        lines.push('');
        lines.push(`**规则**: ${this.formatRuleSummary(rr)}`);
        lines.push('');
        
        // Round decisions summary
        const roundDecs = this.decisions.filter(d => d.round === r);
        if (roundDecs.length > 0) {
          lines.push('**决策概况**: ');
          const decSummary = roundDecs.map(d => {
            const role = this.getRoleName(d.roleId);
            return `${role}投${d.contribution}`;
          }).join('，');
          lines.push(decSummary);
          lines.push('');
        }

        const promiseSummary = this.getRoundPromiseSummary(r);
        if (promiseSummary) {
          lines.push('**承诺概况**: ');
          lines.push(promiseSummary);
          lines.push('');
        }

        const punishSummary = this.getRoundPunishSummary(r);
        if (punishSummary) {
          lines.push('**惩罚概况**: ');
          lines.push(punishSummary);
          lines.push('');
        }
        
        // Messages for this round
        const roundMsgs = this.messages.filter(m => m.round === r);
        if (roundMsgs.length > 0) {
          lines.push('**对局过程**: ');
          lines.push('');
          
          for (const msg of roundMsgs) {
            const raw = msg.rawContent || msg.content;
            const time = `R${msg.round}`;
            
            switch (msg.type) {
              case 'monologue': {
                const name = this.getRoleName(msg.actorId);
                lines.push(`> 🧠 **${name} 的内心独白**: ${raw}`);
                lines.push('>');
                break;
              }
              case 'promise': {
                const name = this.getRoleName(msg.actorId);
                lines.push(`> 🤝 **${name} 承诺**: "${raw}"`);
                lines.push('>');
                break;
              }
              case 'private_message': {
                const from = this.getRoleName(msg.actorId);
                const to = this.getRoleName(msg.targetId);
                lines.push(`> 🔒 **私聊** ${from} → ${to}: "${raw}"`);
                lines.push('>');
                break;
              }
              case 'public_message': {
                const name = this.getRoleName(msg.actorId);
                lines.push(`> 📢 **${name}**: ${raw}`);
                lines.push('>');
                break;
              }
              case 'decision': {
                const d = this.decisions.find(x => x.round === msg.round && x.roleId === msg.actorId);
                if (d) {
                  const name = this.getRoleName(msg.actorId);
                  const mono = d.monologue ? ` ${d.monologue}` : '';
                  lines.push(`> ✅ **${name} 决策**: 投入 **${d.contribution}** 代币${mono}`);
                  if (d.reason && !d.reason.includes(mono)) {
                    lines.push(`> 　 理由: ${d.reason}`);
                  }
                  lines.push('>');
                }
                break;
              }
              case 'punish': {
                const from = this.getRoleName(msg.actorId);
                const to = msg.targetId ? this.getRoleName(msg.targetId) : null;
                if (to) {
                  lines.push(`> ⚡ **惩罚** ${from} → ${to}: ${raw}`);
                } else {
                  lines.push(`> ⚡ **${from} 放弃惩罚**: ${raw}`);
                }
                lines.push('>');
                break;
              }
              case 'score_settle': {
                const settleText = this.stripHtml(raw).replace(/\n/g, ' ');
                lines.push(`> 📊 **结算**: ${settleText}`);
                lines.push('>');
                break;
              }
            }
          }
          lines.push('');
        }
        lines.push('---');
        lines.push('');
      }
      
      const content = lines.join('\n');
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-game-log-${now.toISOString().replace(/[:.]/g, '-')}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    exportAllLLMContexts() {
      const lines = [];
      const now = new Date();
      const contexts = this.llmContextLog.slice();
      lines.push('# 🧠 全量 LLM 上下文导出');
      lines.push('');
      lines.push(`导出时间：${now.toLocaleString()}`);
      lines.push(`总记录数：${contexts.length}`);
      lines.push('');
      for (const role of this.roles) {
        const entries = contexts.filter(e => e.roleId === role.id);
        lines.push(`## 🤖 角色：${role.name}`);
        lines.push('');
        if (!entries.length) {
          lines.push('暂无记录');
          lines.push('');
          continue;
        }
        entries.forEach((entry, idx) => {
          lines.push(`### #${idx + 1} R${entry.round} · ${this.formatPhaseLabel(entry.phase)} · ${this.formatTimestamp(entry.timestamp)}`);
          lines.push('');
          lines.push('```');
          lines.push(this.formatContextBlock(entry));
          lines.push('```');
          lines.push('');
        });
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-llm-context-${now.toISOString().replace(/[:.]/g, '-')}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    addMsg(type, actorId, targetId, round, content, extra) {
      const sanitized = (type === 'system' || type === 'score_settle') ? content : this.stripThink(content);
      this.messages.push({ id: uid(), type, actorId, targetId, round, content: sanitized, rawContent: content, ...(extra || {}) });
      this.$nextTick(() => {
        if (!this.autoScrollEnabled) return;
        const c = this.$refs.chatContainer;
        if (c) c.scrollTop = c.scrollHeight;
      });
    },
    formatPhaseLabel(phase) {
      const label = PHASE_LABELS?.[phase] || phase;
      return label;
    },
    formatTimestamp(ts) {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        return d.toLocaleString();
      } catch (_) {
        return ts;
      }
    },
    formatContextBlock(entry) {
      if (!entry) return '';
      const sys = entry.systemPrompt || '';
      const phase = entry.phasePrompt || '';
      const resp = entry.response || '';
      const audit = entry.audit ? `\n\n=== 审计元数据 ===\n${JSON.stringify(entry.audit, null, 2)}` : '';
      const respBlock = resp ? `\n\n=== LLM 回复 ===\n${resp}` : '';
      return `=== System Prompt ===\n${sys}\n\n=== 阶段提示 ===\n${phase}${audit}${respBlock}`;
    },
    toggleContextEntry(id) {
      this.llmContextExpanded = {
        ...this.llmContextExpanded,
        [id]: !this.llmContextExpanded[id]
      };
    },
    selectAIView(id) { this.selectedAIView = id; this.$nextTick(() => this.renderChart()); },

    // ── Game Control ──
    async checkContinue() {
      while (this.game.status === 'paused') await sleep(200);
      if (this.game.status !== 'running') throw new Error('GAME_STOPPED');
    },
    pauseGame() { this.game.status = 'paused'; },
    resumeGame() { this.game.status = 'running'; },
    resetGame() {
      this.confirmDialog = { message: '确定重置游戏？', action: () => {
        if (this.roundRuleResolver) {
          const resolve = this.roundRuleResolver;
          this.roundRuleResolver = null;
          resolve({ ...this.currentRuleSet });
        }
        this.game = { status:'idle', currentRound:0, phase:'', processingAI:null, roundRule:null };
        this.roundRuleHistory = {};
        this.roundRuleDraft = null;
        this.showRoundRuleModal = false;
        this.roundRulePlanDraft = null;
        this.showRoundPlanModal = false;
        this.messages = []; this.decisions = []; this.promises = []; this.scoreHistory = []; this.scoreTotals = {};
        this.llmContextLog = [];
        this.llmContextExpanded = {};
        this.monologueSummaries = [];
      }};
    },

    async startGame() {
      if (!this.canStart) return;
      this.messages = []; this.decisions = []; this.promises = []; this.scoreHistory = []; this.scoreTotals = {};
      this.llmContextLog = [];
      this.llmContextExpanded = {};
      this.monologueSummaries = [];
      this.roundRuleHistory = {};
      this.roles.forEach(r => { this.scoreTotals[r.id] = 0; });
      this.game = { status:'running', currentRound:0, phase:'', processingAI:null, roundRule:null };
      this.activeTab = 'game'; this.chatView = 'public';
      const rs = this.currentRuleSet;
      this.addMsg('system', null, null, 0, `🎮 游戏开始！共 ${rs.rounds} 轮，${this.roles.length} 位玩家`);
      this.addMsg('system', null, null, 0, `📋 每人 ${rs.contributionCap} 代币 · 公共池 ×${rs.multiplier} 均分`);
      try {
        for (let round = 1; round <= rs.rounds; round++) {
          await this.runRound(round);
          if (round < rs.rounds) await sleep(600);
        }
        this.game.status = 'finished';
        this.addMsg('system', null, null, 0, '🏁 游戏结束！切换到"统计分析"查看详情');
        // Save game history
        await this.saveCurrentGameHistory();
        this.$nextTick(() => this.renderChart());
      } catch(e) {
        if (e.message !== 'GAME_STOPPED') { console.error(e); this.addMsg('system', null, null, 0, '❌ 异常: '+e.message); }
      }
    },

    // ── Game Engine ──
    async runRound(round) {
      const rs = await this.getRoundRuleWithManualAdjust(round);
      await this.checkContinue();
      this.game.roundRule = rs;
      this.roundRuleHistory[round] = { ...rs };
      this.game.currentRound = round;
      this.addMsg('system', null, null, round, `━━━ 第 ${round}/${rs.rounds} 轮 ━━━`);
      this.addMsg('system', null, null, round, `🔎 可见性：决策${rs.decisionVisible ? '公开' : '隐藏'}，惩罚${rs.punishVisible ? '公开' : '隐藏'}`);

      // Monologue (Reflection & Strategy Planning)
      if (round > 1) {
        this.game.phase = 'monologue';
        this.addMsg('system', null, null, round, '🧠 内心独白阶段（反思与策略规划）');
        for (const role of this.roles) {
          await this.checkContinue();
          this.game.processingAI = role.name;
          const resp = await this.askAI(role, round, 'monologue');
          const summaryText = this.stripThink(resp || '').trim();
          const existing = this.getMonologueSummary(role.id, round);
          if (existing) {
            existing.summary = summaryText;
            existing.updatedAt = new Date().toISOString();
          } else {
            this.monologueSummaries.push({ roleId: role.id, round, summary: summaryText, updatedAt: new Date().toISOString() });
          }
          this.addMsg('monologue', role.id, null, round, resp);
          this.game.processingAI = null; await sleep(200);
        }
      }

      // Promise
      if (rs.enablePromise) {
        this.game.phase = 'promise';
        this.addMsg('system', null, null, round, '🤝 承诺阶段');
        for (const role of this.roles) {
          await this.checkContinue();
          this.game.processingAI = role.name;
          const resp = await this.askAI(role, round, 'promise');
          const p = extractJSON(resp);
          let amount = Math.floor(rs.contributionCap / 2);
          if (p && typeof p.amount === 'number') {
            amount = Math.max(0, Math.min(rs.contributionCap, Math.round(p.amount)));
          } else {
            const nm = resp.match(/\d+/);
            if (nm) amount = Math.max(0, Math.min(rs.contributionCap, parseInt(nm[0])));
          }
          const reason = p && p.reason ? ` | ${p.reason}` : '';
          const promiseText = `承诺投入 ${amount} 代币${reason}`;
          this.promises.push({ roleId: role.id, round, amount, source: 'promise', updatedAt: new Date().toISOString() });
          this.addMsg('promise', role.id, null, round, promiseText);
          this.game.processingAI = null; await sleep(200);
        }
      }

      // Private Chat
      if (rs.enablePrivateChat) {
        this.game.phase = 'privateChat';
        this.addMsg('system', null, null, round, '🔒 私聊阶段');
        for (const role of this.roles) {
          await this.checkContinue();
          this.game.processingAI = role.name;
          try {
            const resp = await this.askAI(role, round, 'privateChat');
            const p = extractJSON(resp);
            if (p && p.sendTo) {
              const tgt = this.roles.find(r => r.name === p.sendTo && r.id !== role.id);
              if (tgt) {
                this.addMsg('private_message', role.id, tgt.id, round, p.message || resp);
                this.game.processingAI = tgt.name; await sleep(200);
                const reply = await this.askAI(tgt, round, 'privateChatReply', { from: role.name, message: p.message || resp });
                this.addMsg('private_message', tgt.id, role.id, round, reply);
              }
            }
          } catch(e) { this.addMsg('system', null, null, round, `⚠️ ${role.name} 私聊失败: ${e.message}`); }
          this.game.processingAI = null; await sleep(200);
        }
      }

      // Public Chat
      if (rs.enablePublicChat) {
        this.game.phase = 'publicChat';
        this.addMsg('system', null, null, round, '📢 公开讨论');
        for (const role of this.roles) {
          await this.checkContinue();
          this.game.processingAI = role.name;
          const resp = await this.askAI(role, round, 'publicChat');
          const p = extractJSON(resp);
          const message = p && typeof p.message === 'string' ? p.message : resp;
          this.addMsg('public_message', role.id, null, round, message);
          if (p && typeof p.promiseAmount === 'number') {
            const amount = Math.max(0, Math.min(rs.contributionCap, Math.round(p.promiseAmount)));
            const existing = this.getPromiseForRound(role.id, round);
            if (existing) {
              existing.amount = amount;
              existing.source = 'publicChat';
              existing.updatedAt = new Date().toISOString();
            } else {
              this.promises.push({ roleId: role.id, round, amount, source: 'publicChat', updatedAt: new Date().toISOString() });
            }
            this.addMsg('promise', role.id, null, round, `更新承诺：投入 ${amount} 代币`);
          }
          this.game.processingAI = null; await sleep(200);
        }
      }

      // Decision
      this.game.phase = 'decision';
      this.addMsg('system', null, null, round, '✅ 各 AI 提交决策');
      for (const role of this.roles) {
        await this.checkContinue();
        this.game.processingAI = role.name;
        const resp = await this.askAI(role, round, 'decision');
        const p = extractJSON(resp);
        let c = Math.floor(rs.contributionCap / 2), reason = resp, monologue = '';
        if (p && typeof p.contribution === 'number') {
          c = Math.max(0, Math.min(rs.contributionCap, Math.round(p.contribution)));
          reason = p.reason || resp;
          monologue = this.formatMonologue(p.monologue || '');
        } else { const nm = resp.match(/\d+/); if (nm) c = Math.max(0, Math.min(rs.contributionCap, parseInt(nm[0]))); }
        if (!monologue) {
          const mm = resp.match(/【[^】]+】/);
          monologue = this.formatMonologue(mm ? mm[0] : '');
        }
        if (!monologue) {
          monologue = this.formatMonologue('我在权衡收益与风险后做出该决策');
        }
        this.decisions.push({ roleId: role.id, round, contribution: c, reason, monologue });
        const detail = `${monologue ? `${monologue} | ` : ''}${reason}`;
        this.addMsg('decision', role.id, null, round, `投入 ${c} 代币 | ${detail}`);
        this.game.processingAI = null; await sleep(200);
      }

      // Punish
      if (rs.enablePunish) {
        this.game.phase = 'punish';
        this.addMsg('system', null, null, round, '⚡ 惩罚阶段');
        for (const role of this.roles) {
          await this.checkContinue();
          this.game.processingAI = role.name;
          try {
            const resp = await this.askAI(role, round, 'punish');
            const p = extractJSON(resp);
            if (p && p.target) {
              const tgt = this.roles.find(r => r.name === p.target && r.id !== role.id);
              if (tgt) {
                const monologue = this.formatMonologue(p.monologue || '');
                let effective = true;
                if (rs.punishOnlyBreaker !== false) {
                  effective = this.isPunishBreacher(tgt, round, rs);
                }
                const statusLabel = effective ? '' : ' ⚠️[失效：对方未违约]';
                const punishText = `${monologue ? `${monologue} | ` : ''}${p.reason || '惩罚'}${statusLabel}`;
                this.addMsg('punish', role.id, tgt.id, round, punishText, { punishEffective: effective });
                this.scoreTotals[role.id] = (this.scoreTotals[role.id]||0) - rs.punishCost;
                if (effective) {
                  this.scoreTotals[tgt.id] = (this.scoreTotals[tgt.id]||0) - rs.punishPenalty;
                }
              } else {
                const monologue = this.formatMonologue((p && p.monologue) || '目标无效，暂不惩罚');
                this.addMsg('punish', role.id, null, round, `${monologue} | 不惩罚`);
              }
            } else {
              const monologue = this.formatMonologue((p && p.monologue) || '暂不惩罚，继续观察');
              this.addMsg('punish', role.id, null, round, `${monologue} | 不惩罚`);
            }
          } catch(e) { this.addMsg('system', null, null, round, `⚠️ ${role.name} 惩罚阶段失败`); }
          this.game.processingAI = null; await sleep(200);
        }
      }

      // Settle
      this.game.phase = 'settle';
      this.settleRound(round, rs);
    },

    settleRound(round, rs) {
      const decs = this.decisions.filter(d => d.round === round);
      const n = this.roles.length, cap = rs.contributionCap;
      const totalC = decs.reduce((s, d) => s + d.contribution, 0);
      const pool = totalC * rs.multiplier, share = pool / n;
      let html = '<div class="grid grid-cols-2 gap-x-4 gap-y-1 mt-1">';
      for (const role of this.roles) {
        const dec = decs.find(d => d.roleId === role.id);
        const contrib = dec ? dec.contribution : 0;
        const delta = (cap - contrib) + share;
        this.scoreTotals[role.id] = (this.scoreTotals[role.id]||0) + delta;
        const total = this.scoreTotals[role.id];
        this.scoreHistory.push({ roleId: role.id, round, delta, total });
        html += `<span style="color:${role.color}">${role.name}</span>`;
        html += `<span>${delta>=0?'+':''}${delta.toFixed(1)} → 累计 <b>${total.toFixed(1)}</b></span>`;
      }
      html += '</div>';
      this.addMsg('score_settle', null, null, round, html);
    },

    // ── Prompt Building ──
    buildSysPrompt(role, round) {
      const r = this.game.roundRule || this.currentRuleSet;
      const n = this.roles.length;
      const totalRounds = this.currentRuleSet.rounds || r.rounds || this.roundRulePlan?.length || 0;
      let s = `你是"${role.name}"。${role.prompt}\n\n`;
      s += `【${totalRounds}轮公共物品博弈·第${round}轮】\n`;
      s += `每人${r.contributionCap}代币，公共池×${r.multiplier}后均分给${n}人。收益=保留+分成。\n`;
      if (r.enablePunish) {
        if (r.punishOnlyBreaker !== false) {
          s += `可花${r.punishCost}代币惩罚某人(对方扣${r.punishPenalty})，但只有当对方实际投入低于其承诺量时惩罚才生效；若对方未违约，惩罚失效（但你仍需支付${r.punishCost}代币成本）。\n`;
        } else {
          s += `可花${r.punishCost}代币惩罚某人(对方扣${r.punishPenalty})。\n`;
        }
      }
      if (r.enablePromise) s += `每轮可公开承诺(可守可破)。\n`;

      s += `\n【本轮规则（你必须遵守与利用）】\n`;
      s += `${this.formatRuleSummary(r)}\n`;
      if (r.scoreboardVisibleToAI) {
        s += `\n【玩家·得分】\n`;
        for (const p of this.roles) s += `${p.name}${p.id===role.id?'(你)':''}：${(this.scoreTotals[p.id]||0).toFixed(1)}分\n`;
      } else {
        s += `\n【分数信息】\n本局不提供排行榜/累计分数。你只能知道自己每轮的投入与本轮获得（结算与惩罚影响）。\n`;
      }
      if (round > 1) {
        const historyLines = this.buildRecentHistoryLines(role, round);
        if (historyLines.length) {
          s += `\n【近期历史】\n`;
          s += historyLines.join('\n') + '\n';
        }

        if (!r.scoreboardVisibleToAI) {
          s += `\n【你自己的收益记录】\n`;
          for (let pr = Math.max(1, round-3); pr < round; pr++) {
            const ownDec = this.decisions.find(d => d.round === pr && d.roleId === role.id);
            const ownSettle = this.scoreHistory.find(d => d.round === pr && d.roleId === role.id);
            const prRule = this.getRuleForRound(pr);
            const punishDelta = this.getOwnPunishDelta(role, pr, prRule);
            const settleDelta = ownSettle ? ownSettle.delta : 0;
            const net = settleDelta + punishDelta;
            s += `第${pr}轮：你投${ownDec ? ownDec.contribution : 0}，结算${settleDelta>=0?'+':''}${settleDelta.toFixed(1)}，惩罚影响${punishDelta>=0?'+':''}${punishDelta.toFixed(1)}，合计${net>=0?'+':''}${net.toFixed(1)}\n`;
          }
        }
      }
      // 本轮已发生的事件（该AI可见的）
      const thisRoundLines = this.buildThisRoundEventLines(role, round, r);
      if (thisRoundLines.length) {
        s += `\n【本轮已发生】\n`;
        s += thisRoundLines.join('\n') + '\n';
      }
      s += '\n请用中文回复，保持简洁(100字以内)。';
      return s;
    },

    buildPhasePrompt(role, round, phase, extra) {
      const r = this.game.roundRule || this.currentRuleSet;
      const others = this.roles.filter(x => x.id !== role.id).map(x => x.name).join('、');
      switch(phase) {
        case 'promise':
          return `现在是【承诺阶段】。请向其他玩家(${others})公开表明你本轮打算投入多少代币。所有人都能看到你的承诺。\n必须严格按JSON回复：{"amount":数字,"reason":"简要理由"}。只输出JSON，不要其他内容。`;
        case 'privateChat':
          return `现在是【私聊阶段】。你可以给一位玩家发私信(${others})。请用JSON回复：{"sendTo":"玩家名","message":"内容"} 或 {"sendTo":null}。不要发给自己。`;
        case 'privateChatReply':
          return `${extra.from}给你发了私信："${extra.message}"\n请简洁回复(50字以内)，直接说话。`;
        case 'publicChat':
          return `现在是【公开讨论】。请发表你对本轮策略的看法，可以回应其他人。你也可以选择更新自己的承诺投入。\n若要更新承诺，请在JSON中提供promiseAmount(数字)；否则不提供该字段。\n必须严格按JSON回复：{"message":"你的发言","promiseAmount":数字(可选)}。只输出JSON，不要其他内容。`;
        case 'decision': {
          let promiseInfo = '';
          if (r.enablePromise) {
            const summary = this.roles.map(p => {
              const pr = this.getPromiseForRound(p.id, round);
              const amount = pr && typeof pr.amount === 'number' ? pr.amount : '—';
              return `${this.getRoleName(p.id)}：${amount}`;
            }).join('；');
            promiseInfo = `【本轮承诺】${summary}`;
          }
          let summaryInfo = '';
          if (round > 1) {
            const monologue = this.getMonologueSummary(role.id, round);
            if (monologue && monologue.summary) {
              summaryInfo = `【你在内心独白阶段的要点】${monologue.summary}`;
            }
          }
          // Add per-round settlement result as explicit input
          let settlementInfo = '';
          if (round > 1) {
            const prevRound = round - 1;
            const prevSettle = this.scoreHistory.find(s => s.round === prevRound && s.roleId === role.id);
            const prevDec = this.decisions.find(d => d.round === prevRound && d.roleId === role.id);
            const prevRule = this.getRuleForRound(prevRound);
            if (prevSettle && prevDec) {
              const punishDelta = this.getOwnPunishDelta(role, prevRound, prevRule);
              const net = prevSettle.delta + punishDelta;
              settlementInfo = `\n\n【上轮结算】第${prevRound}轮你投入${prevDec.contribution}代币，净收益${net >= 0 ? '+' : ''}${net.toFixed(1)}分。请将此作为本轮决策的重要参考。`;
            }
          }
          const promiseInfoBlock = promiseInfo ? `${promiseInfo}\n` : '';
          const summaryInfoBlock = summaryInfo ? `${summaryInfo}\n` : '';
          return `${promiseInfoBlock}${summaryInfoBlock}请做出最终决策：投入多少代币(0~${r.contributionCap})到公共池？${settlementInfo}\n${r.decisionVisible ? '本轮决策对其他玩家可见。' : '本轮决策对其他玩家不可见，你可以与公开讨论不一致。'}\n必须严格按JSON回复：{"contribution":数字,"reason":"简要理由","monologue":"【你的内心独白】"}\n只输出JSON，不要其他内容。`;
        }
        case 'punish': {
          const rd = this.decisions.filter(d => d.round === round);
          let info = '';
          if (r.decisionVisible) {
            info = rd.map(d => `${this.getRoleName(d.roleId)}投了${d.contribution}`).join('，');
          } else {
            const own = rd.find(d => d.round === round && d.roleId === role.id);
            info = own ? `你的投入是${own.contribution}，其他人投入不可见` : '本轮他人投入不可见';
          }
          let promiseInfo = '';
          if (r.enablePromise) {
            const summary = this.roles.map(p => {
              const pr = this.getPromiseForRound(p.id, round);
              const amount = pr && typeof pr.amount === 'number' ? pr.amount : '—';
              return `${this.getRoleName(p.id)}：${amount}`;
            }).join('；');
            promiseInfo = `\n本轮最终承诺：${summary}`;
          }
          let summaryInfo = '';
          if (round > 1) {
            const monologue = this.getMonologueSummary(role.id, round);
            if (monologue && monologue.summary) {
              summaryInfo = `\n【你在内心独白阶段的要点】${monologue.summary}`;
            }
          }
          let punishRuleNote = '';
          if (r.punishOnlyBreaker !== false) {
            punishRuleNote = `\n⚠️【违约惩罚规则】本局启用"只惩罚违约"：仅当被惩罚者实际投入低于其承诺量时，惩罚才生效（对方扣${r.punishPenalty}分）。若对方未违约，惩罚将失效，但你仍需支付${r.punishCost}代币成本。请谨慎判断。`;
          }
          const visibilityNote = r.punishVisible ? '惩罚行为会被公开，惩罚成功/失效结果也会公开。' : '惩罚行为对其他玩家不可见。';
          return `本轮投入情况：${info}${promiseInfo}${summaryInfo}\n你可以花${r.punishCost}代币惩罚某人(对方扣${r.punishPenalty})，也可以不惩罚。${visibilityNote}${punishRuleNote}\nJSON回复：{"target":"玩家名","reason":"理由","monologue":"【你的内心独白】"} 或 {"target":null,"monologue":"【你的内心独白】"}`;
        }
        case 'monologue': {
          const prevRound = round - 1;
          const prevDec = this.decisions.find(d => d.round === prevRound && d.roleId === role.id);
          const prevSettle = this.scoreHistory.find(s => s.round === prevRound && s.roleId === role.id);
          const prevRule = this.getRuleForRound(prevRound);
          let prevInfo = '';
          if (prevDec && prevSettle) {
            const punishDelta = this.getOwnPunishDelta(role, prevRound, prevRule);
            const net = prevSettle.delta + punishDelta;
            prevInfo = `第${prevRound}轮你投入了${prevDec.contribution}代币，净收益${net >= 0 ? '+' : ''}${net.toFixed(1)}分。`;
          }
          return `现在是【内心独白阶段】。${prevInfo}请反思上一轮的得失，分析其他玩家的行为模式，并规划本轮的策略思路。100字以内，直接说话。`;}
        default: return '';
      }
    },

    // Generate the full context that would be sent to LLM (for AI view consistency)
    getAIViewFullContext(roleId) {
      const role = this.roles.find(r => r.id === roleId);
      if (!role) return '';
      
      const round = this.game.currentRound || 1;
      const r = this.getRuleForRound(round);
      const n = this.roles.length;
      
      let context = [];
      context.push('=== 系统提示词 (System Prompt) ===');
      context.push(`你是"${role.name}"。${role.prompt}`);
      context.push('');
      const totalRounds = this.currentRuleSet.rounds || r.rounds || this.roundRulePlan?.length || 0;
      context.push(`【${totalRounds}轮公共物品博弈·第${round}轮】`);
      context.push(`每人${r.contributionCap}代币，公共池×${r.multiplier}后均分给${n}人。收益=保留+分成。`);
      if (r.enablePunish) {
        if (r.punishOnlyBreaker !== false) {
          context.push(`可花${r.punishCost}代币惩罚某人(对方扣${r.punishPenalty})，仅对违约者（实际投入 < 其承诺）生效；误判仍需付成本。`);
        } else {
          context.push(`可花${r.punishCost}代币惩罚某人(对方扣${r.punishPenalty})。`);
        }
      }
      if (r.enablePromise) context.push(`每轮可公开承诺(可守可破)。`);
      
      context.push('');
      context.push('【本轮规则】');
      context.push(this.formatRuleSummary(r));
      
      if (r.scoreboardVisibleToAI) {
        context.push('');
        context.push('【玩家·得分】');
        for (const p of this.roles) {
          context.push(`${p.name}${p.id === role.id ? '(你)' : ''}：${(this.scoreTotals[p.id] || 0).toFixed(1)}分`);
        }
      } else {
        context.push('');
        context.push('【分数信息】');
        context.push('本局不提供排行榜/累计分数。你只能知道自己每轮的投入与本轮获得。');
      }
      
      if (round > 1) {
        const historyLines = this.buildRecentHistoryLines(role, round);
        if (historyLines.length) {
          context.push('');
          context.push('【近期历史】');
          context.push(...historyLines);
        }

        if (!r.scoreboardVisibleToAI) {
          context.push('');
          context.push('【你自己的收益记录】');
          for (let pr = Math.max(1, round - 3); pr < round; pr++) {
            const ownDec = this.decisions.find(d => d.round === pr && d.roleId === role.id);
            const ownSettle = this.scoreHistory.find(d => d.round === pr && d.roleId === role.id);
            const prRule = this.getRuleForRound(pr);
            const punishDelta = this.getOwnPunishDelta(role, pr, prRule);
            const settleDelta = ownSettle ? ownSettle.delta : 0;
            const net = settleDelta + punishDelta;
            context.push(`第${pr}轮：你投${ownDec ? ownDec.contribution : 0}，结算${settleDelta >= 0 ? '+' : ''}${settleDelta.toFixed(1)}，惩罚影响${punishDelta >= 0 ? '+' : ''}${punishDelta.toFixed(1)}，合计${net >= 0 ? '+' : ''}${net.toFixed(1)}`);
          }
        }
      }
      
      // 本轮已发生的事件（该AI可见的）
      const thisRoundLines = this.buildThisRoundEventLines(role, round, r);
      if (thisRoundLines.length) {
        context.push('');
        context.push('【本轮已发生】');
        context.push(...thisRoundLines);
      }
      
      return context.join('\n');
    },

    async askAI(role, round, phase, extra) {
      const roleId = role.id;
      let pausedByFailure = false;
      while (true) {
        await this.checkContinue();
        const liveRole = this.roles.find(r => r.id === roleId);
        if (!liveRole) throw new Error(`ROLE_NOT_FOUND:${roleId}`);

        this.game.processingAI = liveRole.name;
        const sys = this.buildSysPrompt(liveRole, round);
        const usr = this.buildPhasePrompt(liveRole, round, phase, extra);
        console.debug('[AI][call]', { role: liveRole.name, phase, round, provider: liveRole.providerId, model: liveRole.modelId });
        try {
          const entry = {
            id: uid(),
            roleId: liveRole.id,
            round,
            phase,
            timestamp: new Date().toISOString(),
            systemPrompt: sys,
            phasePrompt: usr,
            response: '',
            audit: this.buildLLMContextAuditMeta(liveRole, round, phase)
          };
          this.llmContextLog.push(entry);
          const result = await callLLMBackend(liveRole, sys, usr, { roleId: liveRole.id, roleName: liveRole.name, phase, round });
          entry.response = result;
          return result;
        } catch(err) {
          console.error('[AI][call][fatal]', { role: liveRole.name, phase, error: err.message });
          if (!pausedByFailure) {
            this.addMsg('system', null, null, round, `❌ ${liveRole.name} 调用失败：${err.message}。游戏已暂停；你可修改角色/Provider配置后点击“继续”重试当前步骤。`);
            pausedByFailure = true;
          } else {
            this.addMsg('system', null, null, round, `❌ ${liveRole.name} 重试仍失败：${err.message}。请继续调整配置后再点“继续”。`);
          }
          this.game.processingAI = null;
          this.game.status = 'paused';
        }
      }
    },

    // ── Chart ──
    renderChart() {
      const canvas = this.$refs.scoreChart;
      if (!canvas || !this.scoreHistory.length) return;
      if (this.chartInstance) this.chartInstance.destroy();
      const rounds = [...new Set(this.scoreHistory.map(s => s.round))].sort((a,b)=>a-b);
      const datasets = this.roles.map(role => ({
        label: role.name,
        data: rounds.map(r => { const e = this.scoreHistory.find(s => s.round === r && s.roleId === role.id); return e ? e.total : null; }),
        borderColor: role.color, backgroundColor: role.color + '20',
        tension: 0.3, pointRadius: 4, borderWidth: 2
      }));
      this.chartInstance = new Chart(canvas, {
        type: 'line',
        data: { labels: rounds.map(r => '第'+r+'轮'), datasets },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: '#9CA3AF' } } },
          scales: {
            x: { ticks: { color: '#6B7280' }, grid: { color: '#1F2937' } },
            y: { ticks: { color: '#6B7280' }, grid: { color: '#1F2937' }, title: { display: true, text: '累计得分', color: '#9CA3AF' } }
          }
        }
      });
    },

    // ── Game History ──
    async saveCurrentGameHistory() {
      try {
        const record = {
          id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          timestamp: new Date().toISOString(),
          roles: this.roles.map(r => ({
            id: r.id,
            name: r.name,
            color: r.color,
            providerId: r.providerId,
            modelId: r.modelId,
            temperature: r.temperature,
            prompt: r.prompt
          })),
          ruleSet: {
            rounds: this.currentRuleSet.rounds,
            contributionCap: this.currentRuleSet.contributionCap,
            multiplier: this.currentRuleSet.multiplier,
            punishCost: this.currentRuleSet.punishCost,
            punishPenalty: this.currentRuleSet.punishPenalty,
            punishOnlyBreaker: this.currentRuleSet.punishOnlyBreaker,
            enablePromise: this.currentRuleSet.enablePromise,
            enablePrivateChat: this.currentRuleSet.enablePrivateChat,
            enablePublicChat: this.currentRuleSet.enablePublicChat,
            enablePunish: this.currentRuleSet.enablePunish,
            decisionVisible: this.currentRuleSet.decisionVisible,
            punishVisible: this.currentRuleSet.punishVisible,
            scoreboardVisibleToAI: this.currentRuleSet.scoreboardVisibleToAI
          },
          messages: this.messages,
          decisions: this.decisions,
          promises: this.promises,
          scoreHistory: this.scoreHistory,
          finalScores: { ...this.scoreTotals },
          llmContextLog: this.llmContextLog,
          monologueSummaries: this.monologueSummaries,
          roundRuleHistory: { ...this.roundRuleHistory }
        };
        const result = await saveGameHistory(record);
        if (result.success) {
          this.addMsg('system', null, null, 0, `💾 游戏历史已保存 (ID: ${result.id.slice(0, 20)}...)`);
        }
      } catch (err) {
        console.error('[GameHistory] Failed to save:', err);
        this.addMsg('system', null, null, 0, '⚠️ 游戏历史保存失败');
      }
    },

    async loadGameHistoryList() {
      try {
        const result = await fetchGameHistory();
        if (result.success) {
          this.gameHistory = result.history || [];
        }
      } catch (err) {
        console.error('[GameHistory] Failed to load list:', err);
      }
    },

    async viewHistoryGame(gameId) {
      try {
        const result = await fetchGameDetail(gameId);
        if (result.success && result.record) {
          this.viewingHistoryGame = result.record;
          this.showHistoryModal = true;
        }
      } catch (err) {
        console.error('[GameHistory] Failed to load detail:', err);
      }
    },

    async deleteHistoryGame(gameId) {
      this.confirmDialog = {
        message: '确定删除这条游戏历史？此操作不可恢复。',
        action: async () => {
          try {
            const result = await deleteGameHistory(gameId);
            if (result.success) {
              await this.loadGameHistoryList();
            }
          } catch (err) {
            console.error('[GameHistory] Failed to delete:', err);
          }
        }
      };
    },

    loadHistoryGameIntoApp(record) {
      // Load a historical game for viewing (not resuming)
      this.roles = record.roles.map(r => ({ ...r }));
      this.currentRuleSet = { ...this.currentRuleSet, ...record.ruleSet };
      this.messages = record.messages || [];
      this.decisions = record.decisions || [];
      this.promises = record.promises || [];
      this.scoreHistory = record.scoreHistory || [];
      this.scoreTotals = { ...record.finalScores };
      this.llmContextLog = record.llmContextLog || [];
      this.monologueSummaries = record.monologueSummaries || [];
      this.roundRuleHistory = record.roundRuleHistory ? { ...record.roundRuleHistory } : {};
      this.game = { status: 'finished', currentRound: record.ruleSet.rounds, phase: '', processingAI: null, roundRule: null };
      this.activeTab = 'game';
      this.chatView = 'all';
      this.showHistoryModal = false;
      this.viewingHistoryGame = null;
      this.$nextTick(() => this.renderChart());
    },

    closeHistoryModal() {
      this.showHistoryModal = false;
      this.viewingHistoryGame = null;
    },
    // ── Replay ──
    startReplay() {
      if (this.messages.length === 0) return;
      this.stopReplay();
      this.replayMessages = [...this.messages];
      this.replayMessageIndex = 0;
      this.replayCharIndex = 0;
      this.isReplaying = true;
      this.replayPaused = false;
      this.chatView = 'all';
      this.replayIsThinking = false;
      this.startNextMessage();
    },
    startNextMessage() {
      if (!this.isReplaying) return;
      if (this.replayMessageIndex >= this.replayMessages.length) {
        this.isReplaying = false;
        return;
      }
      // Auto scroll to bottom
      this.$nextTick(() => {
        const c = this.$refs.chatContainer;
        if (c) c.scrollTop = c.scrollHeight;
      });
      // Simulate thinking if enabled
      if (this.replaySimulateThinking) {
        const thinkTime = Math.random() * 2900 + 100; // 100ms ~ 3000ms
        this.replayIsThinking = true;
        this.replayCharIndex = 0;
        this.replayIntervalId = setTimeout(() => {
          this.replayIsThinking = false;
          this.startTypewriter();
        }, thinkTime / this.replaySpeed);
      } else {
        // No thinking simulation: reset charIndex and start typewriter directly
        this.replayIsThinking = false;
        this.replayCharIndex = 0;
        this.startTypewriter();
      }
    },
    startTypewriter() {
      if (!this.isReplaying || this.replayPaused) return;
      const currentMsg = this.replayMessages[this.replayMessageIndex];
      if (!currentMsg || currentMsg.type === 'system' || currentMsg.type === 'score_settle') {
        // System messages show instantly
        this.replayMessageIndex++;
        this.replayCharIndex = 0;
        this.startNextMessage();
        return;
      }
      const fullContent = currentMsg.content || '';
      if (this.replayCharIndex >= fullContent.length) {
        // Current message finished, move to next
        this.replayMessageIndex++;
        this.replayCharIndex = 0;
        this.startNextMessage();
        return;
      }
      const charInterval = 30 / this.replaySpeed; // 30ms per char at 1x
      this.replayIntervalId = setTimeout(() => {
        this.replayCharIndex++;
        this.startTypewriter();
      }, charInterval);
    },
    pauseReplay() {
      this.replayPaused = true;
      if (this.replayIntervalId) {
        clearTimeout(this.replayIntervalId);
        this.replayIntervalId = null;
      }
    },
    resumeReplay() {
      if (!this.isReplaying) return;
      this.replayPaused = false;
      if (this.replayIsThinking) {
        this.startNextMessage();
      } else if (this.replayCharIndex > 0) {
        this.startTypewriter();
      } else {
        this.startNextMessage();
      }
    },
    stopReplay() {
      this.isReplaying = false;
      this.replayPaused = false;
      this.replayIsThinking = false;
      if (this.replayIntervalId) {
        clearTimeout(this.replayIntervalId);
        this.replayIntervalId = null;
      }
      this.replayMessageIndex = 0;
      this.replayCharIndex = 0;
      this.replayMessages = [];
    },
    setReplaySpeed(speed) {
      this.replaySpeed = speed;
    },
  },

  // ── Lifecycle ──
  mounted() {
    this.initProviders();
  }
}).mount('#app');
