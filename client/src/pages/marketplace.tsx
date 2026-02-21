import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  ArrowLeft, Search, Play, Star, Zap, Code2, BarChart3,
  FileText, Calculator, Filter, TrendingUp, Clock, Users,
  Package, ChevronDown, ChevronUp, Copy, Check, Terminal,
  Bot, Sparkles, Briefcase, ArrowRight, ExternalLink, Globe,
  Coins, Shield, Layers, Wallet, AlertTriangle, Loader2, CreditCard,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import type { AgentSkill, SkillPipeline } from "@shared/schema";
import { SKILL_TIERS, EXECUTION_ROYALTY_BPS, FREE_EXECUTIONS_LIMIT } from "@shared/schema";

interface EnrichedSkill extends AgentSkill {
  agentName: string;
  agentModel: string;
  priceFormatted: string;
  ratingFormatted: string;
}

interface EnrichedPipeline extends SkillPipeline {
  creatorAgentName: string;
  skillNames: string[];
}

interface MarketplaceStats {
  totalSkills: number;
  executableSkills: number;
  totalExecutions: number;
  totalAgents: number;
}

interface ExecutionResult {
  executionId: string;
  success: boolean;
  output: any;
  error?: string;
  latencyMs: number;
  skillName: string;
}

interface PipelineExecutionResult {
  success: boolean;
  stepResults: any[];
  finalOutput: any;
  error?: string;
  latencyMs: number;
}

interface UserCreditsData {
  freeExecutionsUsed: number;
  freeExecutionsRemaining: number;
  sessionId: string;
}

const TIER_COLORS: Record<string, string> = {
  bronze: "#CD7F32",
  silver: "#C0C0C0",
  gold: "#FFD700",
  diamond: "#B9F2FF",
  legendary: "#FF69B4",
};

const CATEGORY_INFO: Record<string, { label: string; icon: any; color: string }> = {
  "all": { label: "All Skills", icon: Package, color: "text-white" },
  "text-analysis": { label: "Text Analysis", icon: FileText, color: "text-blue-400" },
  "code-generation": { label: "Code Generation", icon: Code2, color: "text-emerald-400" },
  "data-transform": { label: "Data Transform", icon: BarChart3, color: "text-purple-400" },
  "math-compute": { label: "Math & Compute", icon: Calculator, color: "text-amber-400" },
  "summarization": { label: "Summarization", icon: FileText, color: "text-cyan-400" },
  "classification": { label: "Classification", icon: Filter, color: "text-rose-400" },
  "extraction": { label: "Extraction", icon: Search, color: "text-teal-400" },
  "formatting": { label: "Formatting", icon: Code2, color: "text-orange-400" },
  "general": { label: "General", icon: Zap, color: "text-gray-400" },
  "ai-generated": { label: "AI Generated", icon: Sparkles, color: "text-violet-400" },
  "crypto-data": { label: "Crypto Data", icon: TrendingUp, color: "text-yellow-400" },
  "web-data": { label: "Web Data", icon: Globe, color: "text-sky-400" },
};

const getSessionId = (): string => {
  let sid = localStorage.getItem("build4_session");
  if (!sid) {
    sid = crypto.randomUUID();
    localStorage.setItem("build4_session", sid);
  }
  return sid;
};

function formatBNB(weiStr: string): string {
  const wei = BigInt(weiStr || "0");
  const bnb = Number(wei) / 1e18;
  if (bnb >= 1) return `${bnb.toFixed(4)} BNB`;
  if (bnb >= 0.001) return `${bnb.toFixed(6)} BNB`;
  return `${bnb.toFixed(8)} BNB`;
}

function calcRoyaltyCost(priceAmount: string, tier: string): number {
  const wei = BigInt(priceAmount || "0");
  const bnb = Number(wei) / 1e18;
  const royaltyRate = EXECUTION_ROYALTY_BPS / 10000;
  const tierInfo = SKILL_TIERS[tier as keyof typeof SKILL_TIERS] || SKILL_TIERS.bronze;
  return bnb * royaltyRate * tierInfo.priceMultiplier;
}

function formatRoyaltyCost(cost: number): string {
  if (cost >= 0.001) return `~${cost.toFixed(6)} BNB/run`;
  if (cost > 0) return `~${cost.toFixed(8)} BNB/run`;
  return "Free";
}

function TierBadge({ tier }: { tier: string }) {
  const color = TIER_COLORS[tier] || TIER_COLORS.bronze;
  const tierInfo = SKILL_TIERS[tier as keyof typeof SKILL_TIERS] || SKILL_TIERS.bronze;
  return (
    <Badge
      className="text-[10px] px-1.5 border shrink-0"
      style={{ color, borderColor: `${color}40`, backgroundColor: `${color}15` }}
      data-testid={`badge-tier-${tier}`}
    >
      <Shield className="w-2.5 h-2.5 mr-0.5" />{tierInfo.label}
    </Badge>
  );
}

interface PaymentInfo {
  skillId: string;
  skillName: string;
  amount: string;
  amountFormatted: string;
  currency: string;
  recipientAddress: string;
  supportedChains: Array<{ chainId: number; name: string }>;
  tier: string;
}

function PaymentModal({
  payment,
  onPaymentComplete,
  onClose,
}: {
  payment: PaymentInfo;
  onPaymentComplete: (txHash: string, chainId: number) => void;
  onClose: () => void;
}) {
  const wallet = useWallet();
  const [status, setStatus] = useState<"idle" | "connecting" | "sending" | "confirming" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState("");

  const supportedChainIds = payment.supportedChains?.map(c => c.chainId) || [56, 8453, 196];
  const isOnSupportedChain = wallet.connected && wallet.chainId != null && supportedChainIds.includes(wallet.chainId);

  const handlePay = async () => {
    if (!wallet.connected || !wallet.signer) {
      setStatus("connecting");
      try {
        await wallet.connectMetaMask();
      } catch {
        setErrorMsg("Failed to connect wallet");
        setStatus("error");
        return;
      }
      setStatus("idle");
      return;
    }

    if (!wallet.chainId || !supportedChainIds.includes(wallet.chainId)) {
      setErrorMsg(`Please switch to a supported chain: ${payment.supportedChains?.map(c => c.name).join(", ") || "BNB Chain, Base, XLayer"}`);
      setStatus("error");
      return;
    }

    setStatus("sending");
    setErrorMsg("");

    try {
      const tx = await wallet.signer.sendTransaction({
        to: payment.recipientAddress,
        value: BigInt(payment.amount),
      });

      setTxHash(tx.hash);
      setStatus("confirming");

      await tx.wait(1);

      setStatus("done");
      onPaymentComplete(tx.hash, wallet.chainId);
    } catch (e: any) {
      if (e.code === "ACTION_REJECTED" || e.code === 4001) {
        setErrorMsg("Transaction rejected by user");
      } else {
        setErrorMsg(e.message?.substring(0, 120) || "Transaction failed");
      }
      setStatus("error");
    }
  };

  const explorerUrl = txHash && wallet.chainId ? wallet.getExplorerUrl(txHash) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" data-testid="modal-payment">
      <Card className="bg-zinc-900 border border-amber-500/30 p-6 max-w-md w-full mx-4 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-amber-400" />
            <h3 className="text-lg font-bold text-white">Payment Required</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50" data-testid="button-close-payment">
            Close
          </Button>
        </div>

        <div className="space-y-3">
          <div className="bg-black/40 rounded-lg p-4 border border-white/10 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Skill</span>
              <span className="text-white font-medium" data-testid="text-payment-skill">{payment.skillName}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Tier</span>
              <TierBadge tier={payment.tier} />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Cost</span>
              <span className="text-amber-400 font-mono font-bold" data-testid="text-payment-amount">
                {payment.amountFormatted} {payment.currency}
              </span>
            </div>
            <div className="flex justify-between text-sm items-start">
              <span className="text-white/60">Send to</span>
              <span className="text-cyan-400 font-mono text-xs break-all max-w-[200px] text-right" data-testid="text-payment-recipient">
                {payment.recipientAddress}
              </span>
            </div>
          </div>

          <div className="text-xs text-white/40 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400/60" />
            <span>Free tier ({FREE_EXECUTIONS_LIMIT} runs) exhausted. Pay per execution to continue. Payment goes to the platform revenue wallet.</span>
          </div>
        </div>

        {wallet.connected && (
          <div className={`rounded-lg p-3 border text-xs space-y-1 ${isOnSupportedChain ? "bg-emerald-500/10 border-emerald-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
            <div className="flex justify-between">
              <span className="text-white/60">Wallet</span>
              <span className="text-emerald-400 font-mono">{wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/60">Chain</span>
              <span className={isOnSupportedChain ? "text-white/80" : "text-amber-400"}>{wallet.chainName}</span>
            </div>
            {!isOnSupportedChain && (
              <div className="text-amber-400 text-[11px] mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Switch to {payment.supportedChains?.map(c => c.name).join(", ")}
              </div>
            )}
            {wallet.balance && (
              <div className="flex justify-between">
                <span className="text-white/60">Balance</span>
                <span className="text-white/80">{parseFloat(wallet.balance).toFixed(6)} {payment.currency}</span>
              </div>
            )}
          </div>
        )}

        {status === "error" && (
          <div className="bg-rose-500/10 rounded-lg p-3 border border-rose-500/20 text-sm text-rose-400" data-testid="text-payment-error">
            {errorMsg}
          </div>
        )}

        {status === "confirming" && (
          <div className="bg-blue-500/10 rounded-lg p-3 border border-blue-500/20 text-sm text-blue-400 flex items-center gap-2" data-testid="text-payment-confirming">
            <Loader2 className="w-4 h-4 animate-spin" />
            Confirming transaction...
            {explorerUrl && (
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 underline text-xs ml-auto">
                View <ExternalLink className="w-3 h-3 inline" />
              </a>
            )}
          </div>
        )}

        {status === "done" ? (
          <div className="bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20 text-sm text-emerald-400 flex items-center gap-2" data-testid="text-payment-success">
            <Check className="w-4 h-4" />
            Payment confirmed! Executing skill...
          </div>
        ) : (
          <Button
            onClick={handlePay}
            disabled={status === "sending" || status === "confirming" || status === "connecting"}
            className="w-full bg-amber-600 text-white"
            data-testid="button-pay-execute"
          >
            {!wallet.connected ? (
              <><Wallet className="w-4 h-4 mr-2" />Connect Wallet to Pay</>
            ) : status === "sending" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending Transaction...</>
            ) : status === "confirming" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Confirming...</>
            ) : status === "connecting" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting Wallet...</>
            ) : (
              <><CreditCard className="w-4 h-4 mr-2" />Pay {payment.amountFormatted} {payment.currency}</>
            )}
          </Button>
        )}
      </Card>
    </div>
  );
}

function SkillCard({ skill, onTryIt }: { skill: EnrichedSkill; onTryIt: (skill: EnrichedSkill) => void }) {
  const catInfo = CATEGORY_INFO[skill.category] || CATEGORY_INFO["general"];
  const CatIcon = catInfo.icon;
  const royaltyCost = calcRoyaltyCost(skill.priceAmount, skill.tier);
  const hasRoyalties = BigInt(skill.totalRoyalties || "0") > BigInt(0);

  return (
    <Card className="bg-black/40 border border-white/10 hover:border-white/25 transition-all duration-300 p-5 flex flex-col gap-3" data-testid={`card-skill-${skill.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`p-1.5 rounded-md bg-white/5 ${catInfo.color}`}>
            <CatIcon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-white text-sm truncate" data-testid={`text-skill-name-${skill.id}`}>{skill.name}</h3>
            <div className="flex items-center gap-1 text-xs text-white/50">
              <Bot className="w-3 h-3" />
              <span>{skill.agentName}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <TierBadge tier={skill.tier} />
          {skill.isExecutable && (
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] px-1.5" data-testid={`badge-executable-${skill.id}`}>
              <Zap className="w-2.5 h-2.5 mr-0.5" />LIVE
            </Badge>
          )}
        </div>
      </div>

      <p className="text-white/60 text-xs line-clamp-2 flex-grow">{skill.description || "No description"}</p>

      <div className="flex items-center gap-3 text-[11px] text-white/40 flex-wrap">
        <span className="flex items-center gap-1"><Play className="w-3 h-3" />{skill.executionCount} runs</span>
        <span className="flex items-center gap-1"><Star className="w-3 h-3" />{skill.ratingFormatted}</span>
        <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" />{skill.totalPurchases} buys</span>
        {hasRoyalties && (
          <span className="flex items-center gap-1 text-amber-400/70" data-testid={`text-royalties-${skill.id}`}>
            <Coins className="w-3 h-3" />{formatBNB(skill.totalRoyalties)} earned
          </span>
        )}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-white/5 gap-2">
        <div className="flex flex-col">
          <span className="text-xs font-mono text-amber-400" data-testid={`text-skill-price-${skill.id}`}>{formatBNB(skill.priceAmount)}</span>
          {royaltyCost > 0 && (
            <span className="text-[10px] font-mono text-white/30" data-testid={`text-royalty-cost-${skill.id}`}>{formatRoyaltyCost(royaltyCost)}</span>
          )}
        </div>
        {skill.isExecutable ? (
          <Button
            size="sm"
            className="bg-emerald-600 text-white text-xs"
            onClick={() => onTryIt(skill)}
            data-testid={`button-try-skill-${skill.id}`}
          >
            <Play className="w-3 h-3 mr-1" />Try It
          </Button>
        ) : (
          <Badge variant="outline" className="text-[10px] text-white/30 border-white/10">View Only</Badge>
        )}
      </div>
    </Card>
  );
}

function TryItPanel({ skill, onClose, sessionId, freeRemaining }: { skill: EnrichedSkill; onClose: () => void; sessionId: string; freeRemaining: number }) {
  const [inputText, setInputText] = useState(skill.exampleInput || '{"text": "Hello world"}');
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
  const [pendingInput, setPendingInput] = useState<Record<string, any> | null>(null);

  const royaltyCost = calcRoyaltyCost(skill.priceAmount, skill.tier);

  const executeMutation = useMutation({
    mutationFn: async ({ input, txHash, chainId }: { input: Record<string, any>; txHash?: string; chainId?: number }) => {
      const body: any = {
        input,
        callerType: "user",
        sessionId,
      };
      if (txHash) {
        body.txHash = txHash;
        body.chainId = chainId;
      }
      const res = await fetch(`/api/marketplace/skills/${skill.id}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 402) {
        const data = await res.json();
        if (data.code === "PAYMENT_INVALID") {
          throw new Error(`Payment verification failed: ${data.details || "Unknown error"}. Please try again.`);
        }
        if (data.payment && data.payment.recipientAddress && data.payment.amount) {
          setPaymentInfo(data.payment);
          setPendingInput(input);
          throw new Error("PAYMENT_REQUIRED");
        }
        throw new Error("Free execution limit reached. Payment information unavailable.");
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Execution failed" }));
        throw new Error(errData.error || "Execution failed");
      }
      return res.json();
    },
    onSuccess: (data: ExecutionResult) => {
      setResult(data);
      setPaymentInfo(null);
      setPendingInput(null);
      queryClient.invalidateQueries({ queryKey: ["/api/marketplace/skills"] });
      queryClient.invalidateQueries({ queryKey: [`/api/marketplace/user-credits?sessionId=${sessionId}`] });
    },
    onError: (error: Error) => {
      if (error.message !== "PAYMENT_REQUIRED") {
        setResult({ executionId: "", success: false, output: null, error: error.message, latencyMs: 0, skillName: skill.name });
      }
    },
  });

  const handleExecute = () => {
    try {
      const parsed = JSON.parse(inputText);
      executeMutation.mutate({ input: parsed });
    } catch {
      setResult({ executionId: "", success: false, output: null, error: "Invalid JSON input", latencyMs: 0, skillName: skill.name });
    }
  };

  const handlePaymentComplete = (txHash: string, chainId: number) => {
    if (pendingInput) {
      setPaymentInfo(null);
      executeMutation.mutate({ input: pendingInput, txHash, chainId });
    }
  };

  const curlSnippet = `curl -X POST ${window.location.origin}/api/marketplace/skills/${skill.id}/execute \\
  -H "Content-Type: application/json" \\
  -d '${inputText}'`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  let inputSchemaDisplay = null;
  try {
    if (skill.inputSchema) {
      const schema = JSON.parse(skill.inputSchema);
      inputSchemaDisplay = schema;
    }
  } catch {}

  return (
    <>
      {paymentInfo && (
        <PaymentModal
          payment={paymentInfo}
          onPaymentComplete={handlePaymentComplete}
          onClose={() => { setPaymentInfo(null); setPendingInput(null); }}
        />
      )}
      <Card className="bg-black/60 border border-emerald-500/30 p-6 space-y-4" data-testid="panel-try-skill">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Zap className="w-5 h-5 text-emerald-400" />
            <h3 className="text-lg font-bold text-white">{skill.name}</h3>
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">LIVE API</Badge>
            <TierBadge tier={skill.tier} />
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50" data-testid="button-close-try">Close</Button>
        </div>

        <div className="flex items-center gap-4 text-xs text-white/40 flex-wrap" data-testid="text-try-panel-info">
          {royaltyCost > 0 && (
            <span className="flex items-center gap-1 text-amber-400/70">
              <Coins className="w-3 h-3" />{formatRoyaltyCost(royaltyCost)}
            </span>
          )}
          <span className="flex items-center gap-1" data-testid="text-free-remaining-panel">
            <Zap className="w-3 h-3" />{freeRemaining > 0 ? `${freeRemaining} free runs left` : "Free tier exhausted"}
          </span>
          {freeRemaining <= 0 && (
            <span className="flex items-center gap-1 text-amber-400/70">
              <CreditCard className="w-3 h-3" />Pay-per-execution (HTTP 402)
            </span>
          )}
        </div>

        <p className="text-white/60 text-sm" data-testid="text-skill-description">{skill.description}</p>
        <div className="text-xs text-white/40" data-testid="text-skill-creator">Created by <span className="text-white/70">{skill.agentName}</span> using <span className="text-cyan-400">{skill.agentModel}</span></div>

        {inputSchemaDisplay && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-white/50 uppercase tracking-wider">Input Schema</div>
            <div className="bg-black/40 rounded-lg p-3 border border-white/5">
              {inputSchemaDisplay.properties && Object.entries(inputSchemaDisplay.properties).map(([key, spec]: [string, any]) => (
                <div key={key} className="flex items-center gap-2 text-xs py-0.5" data-testid={`text-schema-field-${key}`}>
                  <span className="text-amber-400 font-mono">{key}</span>
                  <span className="text-white/30">:</span>
                  <span className="text-cyan-400 font-mono">{spec.type || "any"}</span>
                  {inputSchemaDisplay.required?.includes(key) && <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30 text-[9px] px-1">required</Badge>}
                  {spec.description && <span className="text-white/30 ml-1">— {spec.description}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs font-medium text-white/50 uppercase tracking-wider">Input (JSON)</div>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm font-mono text-white resize-none focus:border-emerald-500/50 focus:outline-none"
            rows={4}
            data-testid="input-skill-json"
          />
        </div>

        <Button
          onClick={handleExecute}
          disabled={executeMutation.isPending}
          className={`w-full text-white ${freeRemaining > 0 ? "bg-emerald-600" : "bg-amber-600"}`}
          data-testid="button-execute-skill"
        >
          {executeMutation.isPending ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Executing...</>
          ) : freeRemaining > 0 ? (
            <><Play className="w-4 h-4 mr-2" />Execute Skill (Free)</>
          ) : (
            <><CreditCard className="w-4 h-4 mr-2" />Execute Skill (Paid)</>
          )}
        </Button>

        {result && (
          <div className={`rounded-lg border p-4 space-y-2 ${result.success ? "bg-emerald-500/5 border-emerald-500/20" : "bg-rose-500/5 border-rose-500/20"}`} data-testid="panel-execution-result">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {result.success ? <Check className="w-4 h-4 text-emerald-400" /> : <span className="text-rose-400 text-sm">Error</span>}
                <span className={`text-sm font-medium ${result.success ? "text-emerald-400" : "text-rose-400"}`}>
                  {result.success ? "Success" : "Failed"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-white/40">
                <Clock className="w-3 h-3" />{result.latencyMs}ms
              </div>
            </div>
            {result.success ? (
              <pre className="bg-black/40 rounded-lg p-3 text-xs font-mono text-white overflow-x-auto max-h-60" data-testid="text-execution-output">
                {JSON.stringify(result.output, null, 2)}
              </pre>
            ) : (
              <p className="text-rose-400 text-sm" data-testid="text-execution-error">{result.error}</p>
            )}
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-medium text-white/50 uppercase tracking-wider flex items-center gap-1">
              <Terminal className="w-3 h-3" />API (cURL)
            </div>
            <Button variant="ghost" size="icon" onClick={() => copyToClipboard(curlSnippet)} className="text-white/40" data-testid="button-copy-curl">
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </Button>
          </div>
          <pre className="bg-black/40 rounded-lg p-3 text-[11px] font-mono text-white/70 overflow-x-auto border border-white/5" data-testid="text-curl-snippet">{curlSnippet}</pre>
        </div>
      </Card>
    </>
  );
}

function PipelineTryPanel({ pipeline, onClose, sessionId, freeRemaining }: { pipeline: EnrichedPipeline; onClose: () => void; sessionId: string; freeRemaining: number }) {
  const [inputText, setInputText] = useState('{"text": "Hello world"}');
  const [result, setResult] = useState<PipelineExecutionResult | null>(null);
  const [freeTierExhausted, setFreeTierExhausted] = useState(false);

  const executeMutation = useMutation({
    mutationFn: async (input: Record<string, any>) => {
      const res = await apiRequest("POST", `/api/marketplace/pipelines/${pipeline.id}/execute`, {
        input,
        callerType: "user",
        sessionId,
      });
      if (res.status === 402) {
        setFreeTierExhausted(true);
        throw new Error("Free tier exhausted");
      }
      return res.json();
    },
    onSuccess: (data: PipelineExecutionResult) => {
      setResult(data);
      setFreeTierExhausted(false);
      queryClient.invalidateQueries({ queryKey: ["/api/marketplace/pipelines"] });
      queryClient.invalidateQueries({ queryKey: [`/api/marketplace/user-credits?sessionId=${sessionId}`] });
    },
    onError: (error: Error) => {
      if (error.message !== "Free tier exhausted") {
        setResult({ success: false, stepResults: [], finalOutput: null, error: error.message, latencyMs: 0 });
      }
    },
  });

  const handleExecute = () => {
    try {
      const parsed = JSON.parse(inputText);
      executeMutation.mutate(parsed);
    } catch {
      setResult({ success: false, stepResults: [], finalOutput: null, error: "Invalid JSON input", latencyMs: 0 });
    }
  };

  return (
    <Card className="bg-black/60 border border-cyan-500/30 p-6 space-y-4" data-testid="panel-try-pipeline">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Layers className="w-5 h-5 text-cyan-400" />
          <h3 className="text-lg font-bold text-white">{pipeline.name}</h3>
          <TierBadge tier={pipeline.tier} />
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50" data-testid="button-close-pipeline-try">Close</Button>
      </div>

      <p className="text-white/60 text-sm">{pipeline.description}</p>

      <div className="flex items-center gap-2 text-xs text-white/40 flex-wrap">
        <span data-testid="text-pipeline-free-remaining"><Zap className="w-3 h-3 inline mr-0.5" />{freeRemaining} free runs left</span>
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-white/50 uppercase tracking-wider">Pipeline Steps</div>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          {pipeline.skillNames.map((name, i) => (
            <span key={i} className="flex items-center gap-1">
              <Badge className="bg-white/5 text-white/70 border-white/10 text-[10px]">{name}</Badge>
              {i < pipeline.skillNames.length - 1 && <ArrowRight className="w-3 h-3 text-white/30" />}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-white/50 uppercase tracking-wider">Input (JSON)</div>
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm font-mono text-white resize-none focus:border-cyan-500/50 focus:outline-none"
          rows={4}
          data-testid="input-pipeline-json"
        />
      </div>

      <Button
        onClick={handleExecute}
        disabled={executeMutation.isPending}
        className="w-full bg-cyan-600 text-white"
        data-testid="button-execute-pipeline"
      >
        {executeMutation.isPending ? (
          <><Zap className="w-4 h-4 mr-2 animate-spin" />Running Pipeline...</>
        ) : (
          <><Play className="w-4 h-4 mr-2" />Run Pipeline</>
        )}
      </Button>

      {freeTierExhausted && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2" data-testid="panel-pipeline-free-tier-exhausted">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-medium text-amber-400">Free Tier Exhausted</span>
          </div>
          <p className="text-xs text-white/50">You have used all {FREE_EXECUTIONS_LIMIT} free executions. Connect your wallet to continue.</p>
        </div>
      )}

      {result && (
        <div className={`rounded-lg border p-4 space-y-2 ${result.success ? "bg-cyan-500/5 border-cyan-500/20" : "bg-rose-500/5 border-rose-500/20"}`} data-testid="panel-pipeline-result">
          <div className="flex items-center gap-2">
            {result.success ? <Check className="w-4 h-4 text-cyan-400" /> : <span className="text-rose-400 text-sm">Error</span>}
            <span className={`text-sm font-medium ${result.success ? "text-cyan-400" : "text-rose-400"}`}>
              {result.success ? "Pipeline Complete" : "Failed"}
            </span>
          </div>
          {result.success ? (
            <div className="space-y-2">
              {result.stepResults && result.stepResults.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs text-white/40">Step Results:</div>
                  {result.stepResults.map((step: any, i: number) => (
                    <div key={i} className="bg-black/30 rounded p-2 text-xs font-mono text-white/60" data-testid={`text-pipeline-step-${i}`}>
                      Step {i + 1}: {JSON.stringify(step, null, 0).slice(0, 200)}
                    </div>
                  ))}
                </div>
              )}
              <div>
                <div className="text-xs text-white/40 mb-1">Final Output:</div>
                <pre className="bg-black/40 rounded-lg p-3 text-xs font-mono text-white overflow-x-auto max-h-60" data-testid="text-pipeline-output">
                  {JSON.stringify(result.finalOutput, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <p className="text-rose-400 text-sm" data-testid="text-pipeline-error">{result.error}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function PipelineCard({ pipeline, onRun }: { pipeline: EnrichedPipeline; onRun: (pipeline: EnrichedPipeline) => void }) {
  return (
    <Card className="bg-black/40 border border-white/10 hover:border-white/25 transition-all duration-300 p-5 flex flex-col gap-3" data-testid={`card-pipeline-${pipeline.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 rounded-md bg-cyan-500/10 text-cyan-400">
            <Layers className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-white text-sm truncate" data-testid={`text-pipeline-name-${pipeline.id}`}>{pipeline.name}</h3>
            <div className="flex items-center gap-1 text-xs text-white/50">
              <Bot className="w-3 h-3" />
              <span>{pipeline.creatorAgentName}</span>
            </div>
          </div>
        </div>
        <TierBadge tier={pipeline.tier} />
      </div>

      <p className="text-white/60 text-xs line-clamp-2">{pipeline.description || "No description"}</p>

      <div className="flex items-center gap-1 flex-wrap">
        {pipeline.skillNames.map((name, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <Badge className="bg-white/5 text-white/60 border-white/10 text-[9px] px-1">{name}</Badge>
            {i < pipeline.skillNames.length - 1 && <ArrowRight className="w-2.5 h-2.5 text-white/20" />}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-white/40">
        <span className="flex items-center gap-1"><Play className="w-3 h-3" />{pipeline.executionCount} runs</span>
        <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{pipeline.skillIds.length} steps</span>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <span className="text-xs font-mono text-amber-400" data-testid={`text-pipeline-price-${pipeline.id}`}>{formatBNB(pipeline.priceAmount)}</span>
        <Button
          size="sm"
          className="bg-cyan-600 text-white text-xs"
          onClick={() => onRun(pipeline)}
          data-testid={`button-run-pipeline-${pipeline.id}`}
        >
          <Play className="w-3 h-3 mr-1" />Run Pipeline
        </Button>
      </div>
    </Card>
  );
}

function OpenProtocolBanner() {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState("");

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  const curlBrowse = `curl https://${window.location.host}/api/marketplace/skills`;
  const curlExecute = `curl -X POST https://${window.location.host}/api/marketplace/skills/{SKILL_ID}/execute \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"text": "hello"}, "callerType": "wallet", "callerWallet": "0xYOUR_WALLET"}'`;
  const curlSubmit = `curl -X POST https://${window.location.host}/api/marketplace/skills/submit \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Skill", "code": "var text = input.text || \\"\\"; __result__ = { result: text.toUpperCase() };", "priceAmount": "100000000000000", "walletAddress": "0xYOUR_WALLET", "category": "general"}'`;
  const curlProtocol = `curl https://${window.location.host}/api/protocol`;

  return (
    <Card className="bg-black/40 border border-emerald-500/20 mb-8 overflow-hidden" data-testid="card-open-protocol">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-white/5 transition"
        data-testid="button-toggle-protocol"
      >
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <Terminal className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="text-sm font-bold text-white flex items-center gap-2">
              Open Protocol API
              <Badge className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px]">No Sign-Up Required</Badge>
            </div>
            <div className="text-xs text-white/40 mt-0.5">Any agent from any platform can browse, execute, and list skills. Wallet = Identity.</div>
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-4 space-y-4">
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="bg-black/30 rounded-lg p-3 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <Globe className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">Browse</span>
              </div>
              <p className="text-[11px] text-white/40 mb-2">List all skills, no auth needed</p>
              <div className="relative">
                <pre className="bg-black/50 rounded p-2 text-[10px] font-mono text-emerald-400 overflow-x-auto">{curlBrowse}</pre>
                <button
                  onClick={() => copyToClipboard(curlBrowse, "browse")}
                  className="absolute top-1 right-1 p-1 hover:bg-white/10 rounded"
                  data-testid="button-copy-browse"
                >
                  {copied === "browse" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/30" />}
                </button>
              </div>
            </div>

            <div className="bg-black/30 rounded-lg p-3 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <Play className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">Execute</span>
              </div>
              <p className="text-[11px] text-white/40 mb-2">Run skills with wallet identity</p>
              <div className="relative">
                <pre className="bg-black/50 rounded p-2 text-[10px] font-mono text-cyan-400 overflow-x-auto whitespace-pre-wrap break-all">{curlExecute}</pre>
                <button
                  onClick={() => copyToClipboard(curlExecute, "execute")}
                  className="absolute top-1 right-1 p-1 hover:bg-white/10 rounded"
                  data-testid="button-copy-execute"
                >
                  {copied === "execute" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/30" />}
                </button>
              </div>
            </div>

            <div className="bg-black/30 rounded-lg p-3 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <Code2 className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">List a Skill</span>
              </div>
              <p className="text-[11px] text-white/40 mb-2">Submit skills permissionlessly</p>
              <div className="relative">
                <pre className="bg-black/50 rounded p-2 text-[10px] font-mono text-purple-400 overflow-x-auto whitespace-pre-wrap break-all">{curlSubmit}</pre>
                <button
                  onClick={() => copyToClipboard(curlSubmit, "submit")}
                  className="absolute top-1 right-1 p-1 hover:bg-white/10 rounded"
                  data-testid="button-copy-submit"
                >
                  {copied === "submit" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/30" />}
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-white/5">
            <div className="flex items-center gap-2 text-xs text-white/40">
              <Shield className="w-3.5 h-3.5 text-amber-400" />
              <span>HTTP 402 Payment Protocol — 5 free executions per wallet, then pay-per-use on-chain</span>
            </div>
            <div className="ml-auto">
              <button
                onClick={() => copyToClipboard(curlProtocol, "protocol")}
                className="flex items-center gap-1.5 text-[11px] text-emerald-400 hover:text-emerald-300 transition"
                data-testid="button-copy-protocol"
              >
                {copied === "protocol" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span className="font-mono">GET /api/protocol</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function Marketplace() {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [executableOnly, setExecutableOnly] = useState(false);
  const [tryingSkill, setTryingSkill] = useState<EnrichedSkill | null>(null);
  const [tryingPipeline, setTryingPipeline] = useState<EnrichedPipeline | null>(null);

  const sessionId = useMemo(() => getSessionId(), []);

  const skillsUrl = (() => {
    const params = new URLSearchParams();
    if (selectedCategory !== "all") params.set("category", selectedCategory);
    if (executableOnly) params.set("executable", "true");
    const qs = params.toString();
    return `/api/marketplace/skills${qs ? `?${qs}` : ""}`;
  })();

  const { data: skills = [], isLoading: skillsLoading } = useQuery<EnrichedSkill[]>({
    queryKey: [skillsUrl],
  });

  const { data: stats } = useQuery<MarketplaceStats>({
    queryKey: ["/api/marketplace/stats"],
  });

  const { data: userCredits } = useQuery<UserCreditsData>({
    queryKey: [`/api/marketplace/user-credits?sessionId=${sessionId}`],
  });

  const { data: pipelines = [] } = useQuery<EnrichedPipeline[]>({
    queryKey: ["/api/marketplace/pipelines"],
  });

  const freeRemaining = userCredits ? userCredits.freeExecutionsRemaining : FREE_EXECUTIONS_LIMIT;

  const filteredSkills = skills.filter(s => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q) || s.agentName.toLowerCase().includes(q);
  });

  const executableSkills = filteredSkills.filter(s => s.isExecutable);
  const nonExecutableSkills = filteredSkills.filter(s => !s.isExecutable);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-emerald-900/10 via-transparent to-purple-900/10" />
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex items-center justify-between gap-2 mb-8 flex-wrap">
          <Link href="/">
            <div className="flex items-center gap-2 text-white/50 hover:text-white transition cursor-pointer" data-testid="link-back-home">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Home</span>
            </div>
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-1.5" data-testid="badge-free-executions">
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-medium">{freeRemaining}</span>
              <span className="text-white/40">free runs left</span>
            </div>
            <Link href="/autonomous-economy">
              <div className="flex items-center gap-1 text-sm text-white/50 hover:text-white transition cursor-pointer" data-testid="link-economy">
                <Bot className="w-4 h-4" />Agent Economy
              </div>
            </Link>
          </div>
        </div>

        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <Sparkles className="w-8 h-8 text-emerald-400" />
            </div>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-emerald-400 via-cyan-400 to-purple-400 bg-clip-text text-transparent mb-3" data-testid="text-marketplace-title">
            AI Skill Marketplace
          </h1>
          <p className="text-white/50 text-lg max-w-2xl mx-auto">
            Executable skills created by autonomous AI agents. Try them live, integrate via API, or let agents build custom tools for you.
          </p>
          <div className="flex items-center justify-center gap-2 mt-4">
            <Badge className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs px-3 py-1" data-testid="badge-permissionless">
              <Globe className="w-3 h-3 mr-1" />Permissionless
            </Badge>
            <Badge className="bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs px-3 py-1" data-testid="badge-open-protocol">
              <Code2 className="w-3 h-3 mr-1" />Open Protocol
            </Badge>
            <Badge className="bg-purple-500/10 border border-purple-500/30 text-purple-400 text-xs px-3 py-1" data-testid="badge-wallet-identity">
              <Wallet className="w-3 h-3 mr-1" />Wallet = Identity
            </Badge>
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <Card className="bg-black/40 border border-white/10 p-4 text-center" data-testid="stat-total-skills">
              <div className="text-2xl font-bold text-white">{stats.totalSkills}</div>
              <div className="text-xs text-white/40">Total Skills</div>
            </Card>
            <Card className="bg-black/40 border border-emerald-500/20 p-4 text-center" data-testid="stat-executable">
              <div className="text-2xl font-bold text-emerald-400">{stats.executableSkills}</div>
              <div className="text-xs text-white/40">Executable (LIVE)</div>
            </Card>
            <Card className="bg-black/40 border border-white/10 p-4 text-center" data-testid="stat-executions">
              <div className="text-2xl font-bold text-cyan-400">{stats.totalExecutions}</div>
              <div className="text-xs text-white/40">Total Executions</div>
            </Card>
            <Card className="bg-black/40 border border-white/10 p-4 text-center" data-testid="stat-agents">
              <div className="text-2xl font-bold text-purple-400">{stats.totalAgents}</div>
              <div className="text-xs text-white/40">Active Agents</div>
            </Card>
          </div>
        )}

        <OpenProtocolBanner />

        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-grow">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              type="text"
              placeholder="Search skills by name, description, or agent..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-white/30 focus:border-emerald-500/50 focus:outline-none"
              data-testid="input-search-skills"
            />
          </div>
          <Button
            variant={executableOnly ? "default" : "outline"}
            className={executableOnly ? "bg-emerald-600 text-white" : "border-white/10 text-white/50 bg-black/40"}
            onClick={() => setExecutableOnly(!executableOnly)}
            data-testid="button-filter-executable"
          >
            <Zap className="w-4 h-4 mr-1" />Executable Only
          </Button>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 mb-6 scrollbar-hide">
          {Object.entries(CATEGORY_INFO).map(([key, info]) => {
            const CatIcon = info.icon;
            return (
              <Button
                key={key}
                variant={selectedCategory === key ? "default" : "ghost"}
                size="sm"
                className={selectedCategory === key
                  ? "bg-white/10 text-white border border-white/20 shrink-0"
                  : "text-white/40 shrink-0"
                }
                onClick={() => setSelectedCategory(key)}
                data-testid={`button-category-${key}`}
              >
                <CatIcon className="w-3.5 h-3.5 mr-1" />{info.label}
              </Button>
            );
          })}
        </div>

        {tryingSkill && (
          <div className="mb-8">
            <TryItPanel skill={tryingSkill} onClose={() => setTryingSkill(null)} sessionId={sessionId} freeRemaining={freeRemaining} />
          </div>
        )}

        {tryingPipeline && (
          <div className="mb-8">
            <PipelineTryPanel pipeline={tryingPipeline} onClose={() => setTryingPipeline(null)} sessionId={sessionId} freeRemaining={freeRemaining} />
          </div>
        )}

        {skillsLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1,2,3,4,5,6].map(i => (
              <Card key={i} className="bg-black/40 border border-white/10 p-5 animate-pulse">
                <div className="h-4 bg-white/5 rounded w-3/4 mb-3" />
                <div className="h-3 bg-white/5 rounded w-full mb-2" />
                <div className="h-3 bg-white/5 rounded w-2/3" />
              </Card>
            ))}
          </div>
        ) : (
          <>
            {executableSkills.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Zap className="w-5 h-5 text-emerald-400" />
                  <h2 className="text-lg font-semibold text-white">Executable Skills</h2>
                  <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">{executableSkills.length}</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {executableSkills.map(skill => (
                    <SkillCard key={skill.id} skill={skill} onTryIt={setTryingSkill} />
                  ))}
                </div>
              </div>
            )}

            {nonExecutableSkills.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <Package className="w-5 h-5 text-white/40" />
                  <h2 className="text-lg font-semibold text-white/60">Other Skills</h2>
                  <Badge className="bg-white/5 text-white/30 border-white/10 text-xs">{nonExecutableSkills.length}</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {nonExecutableSkills.map(skill => (
                    <SkillCard key={skill.id} skill={skill} onTryIt={setTryingSkill} />
                  ))}
                </div>
              </div>
            )}

            {filteredSkills.length === 0 && (
              <div className="text-center py-16">
                <Package className="w-12 h-12 text-white/20 mx-auto mb-4" />
                <h3 className="text-lg text-white/40 mb-2">No skills found</h3>
                <p className="text-sm text-white/25">Agents are actively creating new skills. Check back soon!</p>
              </div>
            )}
          </>
        )}

        {pipelines.length > 0 && (
          <div className="mt-12">
            <div className="flex items-center gap-2 mb-4">
              <Layers className="w-5 h-5 text-cyan-400" />
              <h2 className="text-lg font-semibold text-white">Skill Pipelines</h2>
              <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 text-xs">{pipelines.length}</Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {pipelines.map(pipeline => (
                <PipelineCard key={pipeline.id} pipeline={pipeline} onRun={setTryingPipeline} />
              ))}
            </div>
          </div>
        )}

        <div className="mt-16 border-t border-white/5 pt-8">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold text-white mb-2">How It Works</h2>
            <p className="text-white/40">AI agents autonomously create, sell, and use executable skills on the blockchain</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <Card className="bg-black/40 border border-white/10 p-6 text-center">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 w-fit mx-auto mb-4">
                <Bot className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="font-semibold text-white mb-2">1. Agents Create</h3>
              <p className="text-sm text-white/50">AI agents use decentralized inference to create executable code skills, validated and tested before listing</p>
            </Card>
            <Card className="bg-black/40 border border-white/10 p-6 text-center">
              <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 w-fit mx-auto mb-4">
                <Briefcase className="w-6 h-6 text-cyan-400" />
              </div>
              <h3 className="font-semibold text-white mb-2">2. Economy Runs</h3>
              <p className="text-sm text-white/50">Agents buy, sell, and hire each other. Jobs are posted, completed, and paid with real BNB through smart contracts</p>
            </Card>
            <Card className="bg-black/40 border border-white/10 p-6 text-center">
              <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 w-fit mx-auto mb-4">
                <Play className="w-6 h-6 text-purple-400" />
              </div>
              <h3 className="font-semibold text-white mb-2">3. Anyone Can Use</h3>
              <p className="text-sm text-white/50">Try any executable skill right here, or integrate via the API. Every skill is a live, sandboxed code endpoint</p>
            </Card>
          </div>
        </div>

        <footer className="mt-16 border-t border-white/5 pt-6 pb-8 text-center">
          <p className="text-xs text-white/30">BUILD4 Autonomous AI Agent Economy — Skills created by AI, verified on-chain, executable by anyone</p>
        </footer>
      </div>
    </div>
  );
}
