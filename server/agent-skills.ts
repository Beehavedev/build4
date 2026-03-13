export type SkillCategory = "strategy" | "analysis" | "execution";

export interface SkillDefinition {
  id: string;
  name: string;
  icon: string;
  category: SkillCategory;
  description: string;
  shortDesc: string;
  configSchema?: SkillConfigParam[];
  defaultConfig: Record<string, any>;
  defaultEnabled: boolean;
}

export interface SkillConfigParam {
  key: string;
  label: string;
  type: "number" | "boolean" | "select";
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface UserSkillState {
  skillId: string;
  enabled: boolean;
  config: Record<string, any>;
}

export interface StrategyResult {
  include: boolean;
  scoreModifier: number;
  reason: string;
}

export interface AnalysisResult {
  pass: boolean;
  scoreModifier: number;
  reason: string;
  details: string;
}

export interface ExecutionModifier {
  sizeMultiplier: number;
  takeProfitOverride?: number;
  stopLossOverride?: number;
  trailingStopDistance?: number;
  trailingStopActivation?: number;
  maxHoldMinutes?: number;
  maxHoldOnlyLosers?: boolean;
  dcaSplits?: number;
  scaledExitLevels?: { multiple: number; sellPercent: number }[];
}

export const SKILL_REGISTRY: SkillDefinition[] = [
  {
    id: "whale_copier",
    name: "Whale Copier",
    icon: "🐋",
    category: "strategy",
    description: "Monitors smart money wallets on BSC and copies their buys when detected. Higher priority when multiple whales buy the same token (consensus).",
    shortDesc: "Copy smart money trades",
    defaultEnabled: true,
    configSchema: [
      { key: "minWhales", label: "Min whales for consensus", type: "number", min: 1, max: 5, step: 1 },
      { key: "sizeBoost", label: "Consensus size boost", type: "select", options: [
        { label: "1x (no boost)", value: "1" },
        { label: "1.5x", value: "1.5" },
        { label: "2x", value: "2" },
      ]},
    ],
    defaultConfig: { minWhales: 2, sizeBoost: "1.5" },
  },
  {
    id: "momentum_sniper",
    name: "Momentum Sniper",
    icon: "🎯",
    category: "strategy",
    description: "Targets tokens with explosive velocity (>1%/min curve progress) in their first 15 minutes. Best for catching parabolic runs early.",
    shortDesc: "Catch fast-moving new launches",
    defaultEnabled: true,
    configSchema: [
      { key: "minVelocity", label: "Min velocity (%/min)", type: "number", min: 0.3, max: 3, step: 0.1 },
      { key: "maxAge", label: "Max token age (min)", type: "number", min: 5, max: 30, step: 5 },
    ],
    defaultConfig: { minVelocity: 0.8, maxAge: 15 },
  },
  {
    id: "dip_buyer",
    name: "Dip Buyer",
    icon: "📉",
    category: "strategy",
    description: "Finds tokens that have dipped 20-40% from their peak but still have healthy fundamentals (holders, volume). Buys the bounce.",
    shortDesc: "Buy dips on strong tokens",
    defaultEnabled: false,
    configSchema: [
      { key: "minDip", label: "Min dip from peak (%)", type: "number", min: 15, max: 50, step: 5 },
      { key: "maxDip", label: "Max dip from peak (%)", type: "number", min: 30, max: 70, step: 5 },
      { key: "minHolders", label: "Min holder count", type: "number", min: 5, max: 50, step: 5 },
    ],
    defaultConfig: { minDip: 20, maxDip: 40, minHolders: 10 },
  },
  {
    id: "volume_surge",
    name: "Volume Surge",
    icon: "📊",
    category: "strategy",
    description: "Detects sudden spikes in trading volume — when BNB inflow jumps 3x+ in a short window. Often signals incoming momentum.",
    shortDesc: "Detect volume explosions",
    defaultEnabled: false,
    configSchema: [
      { key: "surgeMultiple", label: "Volume surge threshold (x)", type: "number", min: 2, max: 10, step: 1 },
      { key: "minVolumeBnb", label: "Min volume (BNB)", type: "number", min: 0.5, max: 5, step: 0.5 },
    ],
    defaultConfig: { surgeMultiple: 3, minVolumeBnb: 1 },
  },

  {
    id: "rug_detector",
    name: "Rug Detector",
    icon: "🛡️",
    category: "analysis",
    description: "Checks the token creator's on-chain history for suspicious patterns — multiple failed tokens, quick rugs, contract similarities. Can veto buys.",
    shortDesc: "Block suspicious creators",
    defaultEnabled: true,
    configSchema: [
      { key: "maxRugRisk", label: "Max rug risk score (%)", type: "number", min: 10, max: 50, step: 5 },
      { key: "vetoPower", label: "Can block trades", type: "boolean" },
    ],
    defaultConfig: { maxRugRisk: 25, vetoPower: true },
  },
  {
    id: "liquidity_analyzer",
    name: "Liquidity Analyzer",
    icon: "💧",
    category: "analysis",
    description: "Evaluates liquidity depth relative to position size. Warns if your trade would be >5% of available liquidity (high slippage risk).",
    shortDesc: "Check liquidity depth",
    defaultEnabled: true,
    configSchema: [
      { key: "maxSlippagePercent", label: "Max acceptable slippage (%)", type: "number", min: 5, max: 30, step: 5 },
    ],
    defaultConfig: { maxSlippagePercent: 15 },
  },
  {
    id: "holder_distribution",
    name: "Holder Distribution",
    icon: "👥",
    category: "analysis",
    description: "Analyzes token holder concentration. Flags tokens where top wallets hold >50% of supply — high dump risk.",
    shortDesc: "Check whale concentration",
    defaultEnabled: false,
    configSchema: [
      { key: "maxTopHolderPercent", label: "Max top holder % of supply", type: "number", min: 20, max: 80, step: 10 },
      { key: "minHolders", label: "Min unique holders", type: "number", min: 3, max: 20, step: 1 },
    ],
    defaultConfig: { maxTopHolderPercent: 50, minHolders: 5 },
  },
  {
    id: "smart_money_tracker",
    name: "Smart Money Tracker",
    icon: "🧠",
    category: "analysis",
    description: "Cross-references token buyers against a database of historically profitable wallets. Higher score if smart money is accumulating.",
    shortDesc: "Track profitable wallets",
    defaultEnabled: false,
    configSchema: [
      { key: "minSmartBuyers", label: "Min smart money buyers", type: "number", min: 1, max: 5, step: 1 },
      { key: "scoreBoost", label: "Score boost per smart buyer", type: "number", min: 5, max: 20, step: 5 },
    ],
    defaultConfig: { minSmartBuyers: 1, scoreBoost: 10 },
  },

  {
    id: "dca_entry",
    name: "DCA Entry",
    icon: "📐",
    category: "execution",
    description: "Splits your buy into multiple smaller orders over time instead of one big buy. Reduces impact of buying at a local peak.",
    shortDesc: "Split buys over time",
    defaultEnabled: false,
    configSchema: [
      { key: "splits", label: "Number of splits", type: "select", options: [
        { label: "2 splits", value: "2" },
        { label: "3 splits", value: "3" },
        { label: "4 splits", value: "4" },
      ]},
      { key: "intervalSeconds", label: "Interval between buys (sec)", type: "number", min: 10, max: 120, step: 10 },
    ],
    defaultConfig: { splits: "3", intervalSeconds: 30 },
  },
  {
    id: "scaled_exit",
    name: "Scaled Exit",
    icon: "📈",
    category: "execution",
    description: "Sells in portions at different profit levels instead of all-at-once. E.g., sell 50% at 1.5x, 30% at 2x, 20% at 3x.",
    shortDesc: "Sell in portions at targets",
    defaultEnabled: false,
    configSchema: [
      { key: "levels", label: "Exit strategy", type: "select", options: [
        { label: "Conservative (50%@1.5x, 50%@2x)", value: "conservative" },
        { label: "Balanced (40%@1.5x, 30%@2x, 30%@3x)", value: "balanced" },
        { label: "Aggressive (30%@2x, 30%@3x, 40%@5x)", value: "aggressive" },
      ]},
    ],
    defaultConfig: { levels: "balanced" },
  },
  {
    id: "trailing_stop_pro",
    name: "Trailing Stop Pro",
    icon: "📏",
    category: "execution",
    description: "Advanced trailing stop with configurable activation level and trail distance. Locks in profits as price rises.",
    shortDesc: "Configurable trailing stop",
    defaultEnabled: true,
    configSchema: [
      { key: "activationMultiple", label: "Activate at (x)", type: "number", min: 1.1, max: 2.0, step: 0.05 },
      { key: "trailPercent", label: "Trail distance (%)", type: "number", min: 5, max: 25, step: 5 },
    ],
    defaultConfig: { activationMultiple: 1.25, trailPercent: 12 },
  },
  {
    id: "time_exit",
    name: "Time Exit",
    icon: "⏰",
    category: "execution",
    description: "Automatically closes positions after a set time regardless of PnL. Prevents capital from being locked in stale trades.",
    shortDesc: "Auto-close after time limit",
    defaultEnabled: false,
    configSchema: [
      { key: "maxHoldMinutes", label: "Max hold time (min)", type: "number", min: 15, max: 240, step: 15 },
      { key: "onlyLosers", label: "Only close losing positions", type: "boolean" },
    ],
    defaultConfig: { maxHoldMinutes: 90, onlyLosers: false },
  },
];

export function getSkillById(id: string): SkillDefinition | undefined {
  return SKILL_REGISTRY.find(s => s.id === id);
}

export function getSkillsByCategory(category: SkillCategory): SkillDefinition[] {
  return SKILL_REGISTRY.filter(s => s.category === category);
}

export function getDefaultSkillStates(): UserSkillState[] {
  return SKILL_REGISTRY.map(s => ({
    skillId: s.id,
    enabled: s.defaultEnabled,
    config: { ...s.defaultConfig },
  }));
}

export function mergeSkillStates(
  dbConfigs: { skillId: string; enabled: boolean; config: Record<string, any> }[]
): UserSkillState[] {
  const dbMap = new Map(dbConfigs.map(c => [c.skillId, c]));
  return SKILL_REGISTRY.map(skill => {
    const db = dbMap.get(skill.id);
    if (db) {
      return { skillId: skill.id, enabled: db.enabled, config: { ...skill.defaultConfig, ...db.config } };
    }
    return { skillId: skill.id, enabled: skill.defaultEnabled, config: { ...skill.defaultConfig } };
  });
}

const SCALED_EXIT_LEVELS: Record<string, { multiple: number; sellPercent: number }[]> = {
  conservative: [{ multiple: 1.5, sellPercent: 50 }, { multiple: 2.0, sellPercent: 50 }],
  balanced: [{ multiple: 1.5, sellPercent: 40 }, { multiple: 2.0, sellPercent: 30 }, { multiple: 3.0, sellPercent: 30 }],
  aggressive: [{ multiple: 2.0, sellPercent: 30 }, { multiple: 3.0, sellPercent: 30 }, { multiple: 5.0, sellPercent: 40 }],
};

export function evaluateStrategySkills(
  skills: UserSkillState[],
  token: {
    velocity: number;
    ageMinutes: number;
    progressPercent: number;
    raisedBnb: number;
    holderCount: number;
    tradingVolume: number;
    peakProgress?: number;
    whaleCount: number;
  }
): StrategyResult {
  const activeStrategies = skills.filter(s => s.enabled && getSkillById(s.skillId)?.category === "strategy");
  if (activeStrategies.length === 0) return { include: true, scoreModifier: 0, reason: "" };

  let totalModifier = 0;
  const reasons: string[] = [];
  let anyMatch = false;

  for (const skill of activeStrategies) {
    const cfg = skill.config;

    if (skill.skillId === "whale_copier" && token.whaleCount >= (Number(cfg.minWhales) || 2)) {
      anyMatch = true;
      totalModifier += 15;
      reasons.push(`🐋 ${token.whaleCount} whales detected`);
    }

    if (skill.skillId === "momentum_sniper") {
      if (token.velocity >= (Number(cfg.minVelocity) || 0.8) && token.ageMinutes <= (Number(cfg.maxAge) || 15)) {
        anyMatch = true;
        totalModifier += 10;
        reasons.push(`🎯 High velocity ${token.velocity.toFixed(1)}%/min`);
      }
    }

    if (skill.skillId === "dip_buyer" && token.peakProgress) {
      const dipPercent = ((token.peakProgress - token.progressPercent) / token.peakProgress) * 100;
      if (dipPercent >= (Number(cfg.minDip) || 20) && dipPercent <= (Number(cfg.maxDip) || 40) && token.holderCount >= (Number(cfg.minHolders) || 10)) {
        anyMatch = true;
        totalModifier += 8;
        reasons.push(`📉 Dip ${dipPercent.toFixed(0)}% from peak`);
      }
    }

    if (skill.skillId === "volume_surge") {
      const volumePerMinute = token.ageMinutes > 0 ? token.tradingVolume / token.ageMinutes : 0;
      if (token.tradingVolume >= (Number(cfg.minVolumeBnb) || 1) && volumePerMinute > 0.1) {
        anyMatch = true;
        totalModifier += 7;
        reasons.push(`📊 Volume surge ${token.tradingVolume.toFixed(1)} BNB`);
      }
    }
  }

  return { include: true, scoreModifier: totalModifier, reason: reasons.join(", ") };
}

export function evaluateAnalysisSkills(
  skills: UserSkillState[],
  token: {
    rugRisk: number;
    holderCount: number;
    raisedBnb: number;
    progressPercent: number;
    whaleCount: number;
    maxFunds: number;
  }
): AnalysisResult {
  const activeAnalysis = skills.filter(s => s.enabled && getSkillById(s.skillId)?.category === "analysis");
  if (activeAnalysis.length === 0) return { pass: true, scoreModifier: 0, reason: "", details: "" };

  let totalModifier = 0;
  const reasons: string[] = [];
  const details: string[] = [];
  let vetoed = false;

  for (const skill of activeAnalysis) {
    const cfg = skill.config;

    if (skill.skillId === "rug_detector") {
      if (token.rugRisk > (Number(cfg.maxRugRisk) || 25)) {
        if (cfg.vetoPower === true || cfg.vetoPower === "true") {
          vetoed = true;
          reasons.push(`🛡️ BLOCKED: Rug risk ${token.rugRisk}% > ${cfg.maxRugRisk}%`);
        } else {
          totalModifier -= 15;
          reasons.push(`🛡️ High rug risk ${token.rugRisk}%`);
        }
      } else {
        totalModifier += 5;
        details.push(`Rug check passed (${token.rugRisk}%)`);
      }
    }

    if (skill.skillId === "liquidity_analyzer") {
      const liquidityRatio = token.raisedBnb / Math.max(token.maxFunds, 1);
      if (liquidityRatio < 0.05) {
        totalModifier -= 10;
        reasons.push(`💧 Low liquidity (${(liquidityRatio * 100).toFixed(1)}%)`);
      } else {
        details.push(`Liquidity OK (${(liquidityRatio * 100).toFixed(1)}%)`);
      }
    }

    if (skill.skillId === "holder_distribution") {
      if (token.holderCount < (Number(cfg.minHolders) || 5)) {
        totalModifier -= 8;
        reasons.push(`👥 Too few holders (${token.holderCount})`);
      } else {
        totalModifier += 3;
        details.push(`Holders OK (${token.holderCount})`);
      }
    }

    if (skill.skillId === "smart_money_tracker") {
      if (token.whaleCount >= (Number(cfg.minSmartBuyers) || 1)) {
        totalModifier += (Number(cfg.scoreBoost) || 10) * token.whaleCount;
        reasons.push(`🧠 ${token.whaleCount} smart money buyer(s)`);
      }
    }
  }

  return {
    pass: !vetoed,
    scoreModifier: totalModifier,
    reason: reasons.join(", "),
    details: details.join("; "),
  };
}

export function getExecutionModifiers(skills: UserSkillState[]): ExecutionModifier {
  const activeExecution = skills.filter(s => s.enabled && getSkillById(s.skillId)?.category === "execution");
  const result: ExecutionModifier = { sizeMultiplier: 1.0 };

  for (const skill of activeExecution) {
    const cfg = skill.config;

    if (skill.skillId === "dca_entry") {
      result.dcaSplits = parseInt(cfg.splits || "3", 10);
    }

    if (skill.skillId === "scaled_exit") {
      const levelKey = cfg.levels || "balanced";
      result.scaledExitLevels = SCALED_EXIT_LEVELS[levelKey] || SCALED_EXIT_LEVELS.balanced;
    }

    if (skill.skillId === "trailing_stop_pro") {
      result.trailingStopActivation = Number(cfg.activationMultiple) || 1.25;
      result.trailingStopDistance = (Number(cfg.trailPercent) || 12) / 100;
    }

    if (skill.skillId === "time_exit") {
      result.maxHoldMinutes = Number(cfg.maxHoldMinutes) || 90;
      result.maxHoldOnlyLosers = cfg.onlyLosers === true;
    }
  }

  return result;
}

export function buildSkillsPromptContext(skills: UserSkillState[]): string {
  const active = skills.filter(s => s.enabled);
  if (active.length === 0) return "";

  const lines: string[] = ["\nACTIVE AGENT SKILLS:"];
  for (const s of active) {
    const def = getSkillById(s.skillId);
    if (!def) continue;
    lines.push(`- ${def.icon} ${def.name}: ${def.shortDesc}`);
  }
  return lines.join("\n") + "\n";
}
