import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SEO } from "@/components/seo";
import {
  ArrowLeft,
  Terminal,
  Layers,
  Database,
  Server,
  Shield,
  Cpu,
  GitBranch,
  Zap,
  Wallet,
  ScrollText,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Link2,
} from "lucide-react";

import {
  WEB4_CONTRACTS,
  AgentEconomyHubABI,
  ConstitutionRegistryABI,
  SkillMarketplaceABI,
  AgentReplicationABI,
} from "@/contracts/web4";

const CONTRACT_STATIC = [
  {
    name: "AgentEconomyHub",
    icon: Wallet,
    descKey: "architecture.contracts.hub.desc",
    featuresKey: "architecture.contracts.hub.features",
    functions: ["registerAgent", "deposit", "withdraw", "transfer", "creditAgent", "debitAgent", "computeTier", "authorizeModule"],
    abiCount: AgentEconomyHubABI.length,
  },
  {
    name: "SkillMarketplace",
    icon: Zap,
    descKey: "architecture.contracts.marketplace.desc",
    featuresKey: "architecture.contracts.marketplace.features",
    functions: ["listSkill", "purchaseSkill", "deactivateSkill", "setPlatformFee", "setLineageContract", "getSkill"],
    abiCount: SkillMarketplaceABI.length,
  },
  {
    name: "AgentReplication",
    icon: GitBranch,
    descKey: "architecture.contracts.replication.desc",
    featuresKey: "architecture.contracts.replication.features",
    functions: ["replicate", "distributeRevenueShare", "getParent", "getChildren", "getLineage", "setIdentityNft"],
    abiCount: AgentReplicationABI.length,
  },
  {
    name: "ConstitutionRegistry",
    icon: ScrollText,
    descKey: "architecture.contracts.constitution.desc",
    featuresKey: "architecture.contracts.constitution.features",
    functions: ["addLaw", "sealConstitution", "verifyConstitution", "getLaw", "getLawCount", "getConstitutionHash", "isSealed"],
    abiCount: ConstitutionRegistryABI.length,
  },
];

const ARCHITECTURE_LAYERS = [
  {
    layerKey: "architecture.onChain" as const,
    subtitleKey: "architecture.onChainSub" as const,
    icon: Shield,
    color: "text-primary",
    itemsKey: "architecture.layers.onChainItems",
  },
  {
    layerKey: "architecture.offChain" as const,
    subtitleKey: "architecture.offChainSub" as const,
    icon: Database,
    color: "text-blue-400",
    itemsKey: "architecture.layers.offChainItems",
  },
];

function ContractSection({ contract, index, t }: { contract: typeof CONTRACT_STATIC[0]; index: number; t: (key: string) => string }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = contract.icon;
  const features = t(contract.featuresKey);
  const featuresList = Array.isArray(features) ? features : [];

  return (
    <Card className="overflow-visible" data-testid={`card-contract-${contract.name}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left flex items-start gap-3"
        data-testid={`button-expand-${contract.name}`}
      >
        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
          <span className="font-mono text-xs text-muted-foreground w-4">{index + 1}.</span>
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-sm">{contract.name}</span>
            <Badge variant="outline" className="text-[10px] font-mono">{contract.abiCount} {t("architecture.abiEntries")}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t(contract.descKey)}</p>
        </div>
        <div className="flex-shrink-0 mt-1">
          {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t pt-3">
          <div>
            <div className="text-[10px] font-mono font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">{t("architecture.features")}</div>
            <div className="space-y-1">
              {featuresList.map((f: string, i: number) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="text-primary/60 flex-shrink-0 mt-0.5">-</span>
                  <span className="text-muted-foreground">{f}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">{t("architecture.keyFunctions")}</div>
            <div className="flex flex-wrap gap-1.5">
              {contract.functions.map((fn) => (
                <Badge key={fn} variant="secondary" className="font-mono text-[10px]">{fn}()</Badge>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover-elevate px-1.5 py-0.5 rounded"
      data-testid="button-copy-code"
    >
      {text}
      {copied ? <Check className="w-2.5 h-2.5 text-primary" /> : <Copy className="w-2.5 h-2.5" />}
    </button>
  );
}

export default function Architecture() {
  const t = useT();
  return (
    <div className="min-h-screen bg-background">
      <SEO />
      <header className="border-b sticky top-0 z-50 bg-background/95 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back-home">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-2 min-w-0">
              <Terminal className="w-4 h-4 text-primary flex-shrink-0" />
              <span className="font-mono font-bold text-sm tracking-wider flex-shrink-0">BUILD<span className="text-primary">4</span></span>
              <span className="text-muted-foreground font-mono text-xs hidden sm:inline">{t("architecture.breadcrumb")}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <LanguageSwitcher />
            <Link href="/autonomous-economy">
              <Button variant="outline" size="sm" className="font-mono text-xs" data-testid="link-economy">
                <Cpu className="w-3 h-3" />
                <span className="hidden sm:inline">{t("nav.economy")}</span>
                <span className="sm:hidden">{t("nav.launch")}</span>
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <div>
          <div className="font-mono text-xs text-muted-foreground mb-2">
            {t("architecture.terminal")}
          </div>
          <h1 className="font-mono text-2xl font-bold tracking-tight">
            {t("architecture.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed max-w-2xl">
            {t("architecture.subtitle")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ARCHITECTURE_LAYERS.map((layer) => {
            const Icon = layer.icon;
            return (
              <Card key={t(layer.layerKey)} className="p-4" data-testid={`card-layer-${t(layer.layerKey).toLowerCase().replace(" ", "-")}`}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon className={`w-4 h-4 ${layer.color}`} />
                  <div>
                    <div className="font-mono font-bold text-sm">{t(layer.layerKey)}</div>
                    <div className="text-[10px] text-muted-foreground">{t(layer.subtitleKey)}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {(Array.isArray(t(layer.itemsKey)) ? (t(layer.itemsKey) as unknown as string[]) : []).map((item: string, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className={`flex-shrink-0 mt-0.5 ${layer.color} opacity-50`}>-</span>
                      <span className="text-muted-foreground">{item}</span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>

        <div className="relative">
          <div className="absolute left-1/2 -translate-x-1/2 -top-2 z-10">
            <Badge variant="outline" className="font-mono text-[10px] bg-background">
              <Layers className="w-3 h-3 mr-1" />
              {t("architecture.moduleAuthBridge")}
            </Badge>
          </div>
          <div className="border-t border-dashed border-primary/20 mt-4" />
          <div className="text-center mt-3">
            <p className="text-[10px] text-muted-foreground font-mono max-w-md mx-auto">
              {t("architecture.moduleAuthDesc")}
            </p>
          </div>
        </div>

        <div>
          <div className="font-mono text-xs text-muted-foreground mb-3">
            <span className="text-primary/60">$</span> ls contracts/web4/
          </div>
          <h2 className="font-mono text-lg font-bold tracking-tight mb-1">
            {t("architecture.contractsTitle")}
          </h2>
          <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{t("architecture.contractsSub")}</p>
          <div className="space-y-3">
            {CONTRACT_STATIC.map((contract, i) => (
              <ContractSection key={contract.name} contract={contract} index={i} t={t} />
            ))}
          </div>
        </div>

        <Card className="p-4" data-testid="card-module-flow">
          <div className="font-mono font-bold text-sm mb-3 flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" />
            {t("architecture.composableFlow")}
          </div>
          <div className="font-mono text-xs space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-primary/60">1.</span>
              <span>{t("architecture.flowStep1")}</span>
              <Badge variant="secondary" className="font-mono text-[10px]">SkillMarketplace.purchaseSkill()</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>{t("architecture.flowStep2Marketplace")}</span>
              <Badge variant="secondary" className="font-mono text-[10px]">Hub.debitAgent(buyer)</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>{t("architecture.flowStep2Marketplace")}</span>
              <Badge variant="secondary" className="font-mono text-[10px]">Hub.creditAgent(seller)</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>{t("architecture.flowStep3Parent")}</span>
              <Badge variant="secondary" className="font-mono text-[10px]">Hub.creditAgent(parent)</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground mt-3">
              <span className="text-primary/60">2.</span>
              <span>{t("architecture.flowStep4Verify")}</span>
              <Badge variant="outline" className="font-mono text-[10px]">authorizedModules[msg.sender]</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>{t("architecture.flowStep5Whitelist")}</span>
            </div>
          </div>
        </Card>

        <Card className="p-4" data-testid="card-deployment-info">
          <div className="font-mono font-bold text-sm mb-3 flex items-center gap-2">
            <Server className="w-4 h-4 text-primary" />
            {t("architecture.deployTitle")}
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.compiler")}:</span>
              <span>{t("architecture.compilerValue")}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.framework")}:</span>
              <span>{t("architecture.frameworkValue")}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.libraries")}:</span>
              <span>{t("architecture.librariesValue")}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.network")}:</span>
              <span>{t("architecture.networkValue")}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.deploy")}:</span>
              <CopyableCode text="npx hardhat run contracts/scripts/deploy-web4.cjs --config hardhat.config.web4.cjs --network bnbMainnet" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.compile")}:</span>
              <CopyableCode text="npx hardhat compile --config hardhat.config.web4.cjs" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">{t("architecture.exportAbi")}:</span>
              <CopyableCode text="node contracts/scripts/export-web4-abis.cjs" />
            </div>
          </div>
        </Card>

        <div className="text-center py-6 space-y-3">
          <p className="text-xs text-muted-foreground font-mono">
            Solidity {String.fromCharCode(183)} OpenZeppelin v5 {String.fromCharCode(183)} Hardhat v2 {String.fromCharCode(183)} BNB Chain {String.fromCharCode(183)} Base {String.fromCharCode(183)} XLayer
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/autonomous-economy">
              <Button size="sm" className="font-mono text-xs" data-testid="link-economy-bottom">
                <Cpu className="w-3 h-3 mr-1" />
                {t("nav.economy")}
              </Button>
            </Link>
            <Link href="/manifesto">
              <Button variant="outline" size="sm" className="font-mono text-xs" data-testid="link-manifesto-bottom">
                <ScrollText className="w-3 h-3 mr-1" />
                {t("architecture.readManifesto")}
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
