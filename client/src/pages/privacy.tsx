import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  ArrowLeft, Shield, Eye, EyeOff, Lock, Unlock, Copy, Check,
  ExternalLink, AlertTriangle, Loader2, ChevronDown, Info,
  Wallet, ArrowRight, RefreshCw, Clock, Zap, Hash, FileCheck,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import type { PrivacyTransfer } from "@shared/schema";
import { ZERC20_CONTRACTS, SUPPORTED_PRIVACY_CHAINS } from "@shared/schema";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  deposited: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  proving: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  withdrawn: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
};

type TokenKey = keyof typeof ZERC20_CONTRACTS;

interface TransferResponse extends PrivacyTransfer {
  secret?: string;
  commitment?: string;
  nullifier?: string;
  verifierAddress?: string;
  hubAddress?: string;
}

function storeTransferSecret(transferId: string, secret: string) {
  try {
    const existing = JSON.parse(localStorage.getItem("zerc20_secrets") || "{}");
    existing[transferId] = secret;
    localStorage.setItem("zerc20_secrets", JSON.stringify(existing));
  } catch {}
}

function getTransferSecret(transferId: string): string | null {
  try {
    const existing = JSON.parse(localStorage.getItem("zerc20_secrets") || "{}");
    return existing[transferId] || null;
  } catch {
    return null;
  }
}

export default function Privacy() {
  const wallet = useWallet();
  const [selectedToken, setSelectedToken] = useState<TokenKey>("zBNB");
  const [selectedChain, setSelectedChain] = useState<number>(56);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [lastTransferResult, setLastTransferResult] = useState<TransferResponse | null>(null);

  const agentsQuery = useQuery<any[]>({
    queryKey: ["/api/agents"],
  });

  const userAgent = agentsQuery.data?.find(
    (a: any) => a.creatorWallet?.toLowerCase() === wallet.address?.toLowerCase()
  );

  const transfersQuery = useQuery<PrivacyTransfer[]>({
    queryKey: ["/api/privacy/transfers", userAgent?.id],
    enabled: !!userAgent?.id,
  });

  const createTransferMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/privacy/transfers", data);
      return res.json();
    },
    onSuccess: (data: TransferResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/transfers", userAgent?.id] });
      if (data.secret && data.id) {
        storeTransferSecret(data.id, data.secret);
      }
      setLastTransferResult(data);
      setAmount("");
      setRecipient("");
    },
  });

  const generateProofMutation = useMutation({
    mutationFn: async (transferId: string) => {
      const secret = getTransferSecret(transferId);
      if (!secret) {
        throw new Error("Secret not found locally. You need the secret from when this transfer was created.");
      }
      const res = await apiRequest("POST", `/api/privacy/transfer/${transferId}/prove`, { secret });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/transfers", userAgent?.id] });
    },
  });

  const selectedContract = ZERC20_CONTRACTS[selectedToken];
  const availableChains = Object.keys(selectedContract.chains || {}).map(Number);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleInitiateTransfer = () => {
    if (!userAgent?.id || !amount || !recipient) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) return;
    createTransferMutation.mutate({
      agentId: userAgent.id,
      chainId: selectedChain,
      tokenSymbol: selectedToken,
      tokenAddress: selectedContract.tokenAddress,
      recipientAddress: recipient,
      amount,
      walletAddress: wallet.address,
    });
  };

  const getChainName = (chainId: number): string => {
    const chain = SUPPORTED_PRIVACY_CHAINS[chainId as keyof typeof SUPPORTED_PRIVACY_CHAINS];
    return chain?.name || `Chain ${chainId}`;
  };

  const getExplorerUrl = (chainId: number, txHash: string): string => {
    const chain = SUPPORTED_PRIVACY_CHAINS[chainId as keyof typeof SUPPORTED_PRIVACY_CHAINS];
    return chain ? `${chain.explorer}/tx/${txHash}` : "#";
  };

  return (
    <div className="min-h-screen bg-black text-white" data-testid="privacy-page">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center gap-4 mb-8">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-gray-400 hover:text-white" data-testid="link-back-home">
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-3" data-testid="text-page-title">
              <Shield className="w-8 h-8 text-emerald-400" />
              Privacy Transfers
            </h1>
            <p className="text-gray-400 mt-1">
              Zero-knowledge private transfers powered by ZERC20 + Poseidon hashing
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card className="bg-gray-900/50 border-gray-800 p-6" data-testid="card-how-it-works">
              <button
                onClick={() => setShowHowItWorks(!showHowItWorks)}
                className="w-full flex items-center justify-between text-left"
                data-testid="button-toggle-how-it-works"
              >
                <div className="flex items-center gap-3">
                  <Info className="w-5 h-5 text-blue-400" />
                  <span className="text-lg font-semibold">How ZERC20 Privacy Works</span>
                </div>
                <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${showHowItWorks ? "rotate-180" : ""}`} />
              </button>
              {showHowItWorks && (
                <div className="mt-4 space-y-4 text-gray-300">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold">1</div>
                        <span className="font-semibold">Deposit</span>
                      </div>
                      <p className="text-sm text-gray-400">Poseidon hash derives a unique burn address from recipient + secret. Tokens are sent to this address.</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 font-bold">2</div>
                        <span className="font-semibold">ZK Proof</span>
                      </div>
                      <p className="text-sm text-gray-400">ZERC20 SDK generates a zero-knowledge proof from the commitment and nullifier, proving deposit without revealing details.</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 font-bold">3</div>
                        <span className="font-semibold">Withdraw</span>
                      </div>
                      <p className="text-sm text-gray-400">Recipient claims tokens using the proof. The on-chain verifier validates the proof with no link between sender and recipient.</p>
                    </div>
                  </div>
                  <div className="bg-emerald-900/20 border border-emerald-800/30 rounded-lg p-4">
                    <p className="text-sm">
                      <Hash className="w-4 h-4 inline mr-1 text-emerald-400" />
                      Burn addresses are derived using <span className="text-emerald-400 font-mono">Poseidon(recipient, secret, chainId)</span> from circomlibjs.
                      The commitment and nullifier hashes ensure privacy while preventing double-spending.
                    </p>
                  </div>
                </div>
              )}
            </Card>

            <Card className="bg-gray-900/50 border-gray-800 p-6" data-testid="card-new-transfer">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <EyeOff className="w-5 h-5 text-emerald-400" />
                Initiate Private Transfer
              </h2>

              {!wallet.connected ? (
                <div className="bg-gray-800/50 rounded-lg p-8 text-center border border-gray-700" data-testid="text-connect-wallet-prompt">
                  <Wallet className="w-12 h-12 text-gray-500 mx-auto mb-3" />
                  <p className="text-gray-400 mb-2">Connect your wallet to initiate privacy transfers</p>
                  <p className="text-sm text-gray-500">Wallet-based identity - no registration required</p>
                </div>
              ) : !userAgent ? (
                <div className="bg-gray-800/50 rounded-lg p-8 text-center border border-gray-700" data-testid="text-no-agent">
                  <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-3" />
                  <p className="text-gray-400 mb-2">You need an agent to use privacy transfers</p>
                  <Link href="/autonomous-economy">
                    <Button variant="outline" className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10" data-testid="link-create-agent">
                      Create Agent <ArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Token</label>
                    <div className="flex gap-2">
                      {(Object.keys(ZERC20_CONTRACTS) as TokenKey[]).filter(k => ZERC20_CONTRACTS[k].tokenAddress).map((token) => (
                        <button
                          key={token}
                          onClick={() => {
                            setSelectedToken(token);
                            const chains = Object.keys(ZERC20_CONTRACTS[token].chains || {}).map(Number);
                            if (chains.length > 0 && !chains.includes(selectedChain)) {
                              setSelectedChain(chains[0]);
                            }
                          }}
                          className={`px-4 py-2 rounded-lg border transition-all ${
                            selectedToken === token
                              ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400"
                              : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                          }`}
                          data-testid={`button-token-${token}`}
                        >
                          {token}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Source Chain</label>
                    <div className="flex flex-wrap gap-2">
                      {availableChains.map((chainId) => (
                        <button
                          key={chainId}
                          onClick={() => setSelectedChain(chainId)}
                          className={`px-3 py-1.5 rounded-lg border text-sm transition-all ${
                            selectedChain === chainId
                              ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                              : "bg-gray-800/50 border-gray-700 text-gray-400 hover:border-gray-600"
                          }`}
                          data-testid={`button-chain-${chainId}`}
                        >
                          {getChainName(chainId)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Amount</label>
                    <input
                      type="text"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.001"
                      className="w-full bg-gray-800/50 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-emerald-500/50 focus:outline-none"
                      data-testid="input-amount"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Recipient Address</label>
                    <input
                      type="text"
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder="0x..."
                      className="w-full bg-gray-800/50 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-emerald-500/50 focus:outline-none font-mono text-sm"
                      data-testid="input-recipient"
                    />
                  </div>

                  <div className="bg-gray-800/30 rounded-lg p-4 border border-gray-700/50">
                    <h3 className="text-sm font-semibold text-gray-300 mb-2">ZERC20 Contract</h3>
                    <div className="flex items-center gap-2 text-xs text-gray-400 font-mono">
                      <span className="truncate">{selectedContract.tokenAddress}</span>
                      <button
                        onClick={() => handleCopy(selectedContract.tokenAddress, "contract")}
                        className="text-gray-500 hover:text-white shrink-0"
                        data-testid="button-copy-contract"
                      >
                        {copiedField === "contract" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                      <Hash className="w-3 h-3 text-purple-400" />
                      <span>Burn address derived via Poseidon(recipient, secret, chainId)</span>
                    </div>
                  </div>

                  <Button
                    onClick={handleInitiateTransfer}
                    disabled={!amount || !recipient || createTransferMutation.isPending}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-3"
                    data-testid="button-initiate-transfer"
                  >
                    {createTransferMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Deriving Burn Address & Creating Transfer...
                      </>
                    ) : (
                      <>
                        <Shield className="w-4 h-4 mr-2" />
                        Initiate Private Transfer
                      </>
                    )}
                  </Button>

                  {createTransferMutation.isError && (
                    <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-3 text-sm text-red-400" data-testid="text-transfer-error">
                      <AlertTriangle className="w-4 h-4 inline mr-1" />
                      {(createTransferMutation.error as Error)?.message || "Failed to create transfer"}
                    </div>
                  )}

                  {lastTransferResult && (
                    <div className="bg-purple-900/20 border border-purple-800/30 rounded-lg p-4 space-y-3" data-testid="card-transfer-result">
                      <h3 className="text-sm font-semibold text-purple-300 flex items-center gap-2">
                        <FileCheck className="w-4 h-4" />
                        Transfer Created - Poseidon Derivation Complete
                      </h3>
                      <div className="space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400">Burn Address:</span>
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-emerald-400">{lastTransferResult.burnAddress?.slice(0, 20)}...</span>
                            <button onClick={() => handleCopy(lastTransferResult.burnAddress || "", "burn")} className="text-gray-500 hover:text-white" data-testid="button-copy-burn">
                              {copiedField === "burn" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                            </button>
                          </div>
                        </div>
                        {lastTransferResult.commitment && (
                          <div className="flex items-center justify-between">
                            <span className="text-gray-400">Commitment:</span>
                            <div className="flex items-center gap-1">
                              <span className="font-mono text-blue-400">{lastTransferResult.commitment.slice(0, 20)}...</span>
                              <button onClick={() => handleCopy(lastTransferResult.commitment || "", "commitment")} className="text-gray-500 hover:text-white" data-testid="button-copy-commitment">
                                {copiedField === "commitment" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              </button>
                            </div>
                          </div>
                        )}
                        {lastTransferResult.nullifier && (
                          <div className="flex items-center justify-between">
                            <span className="text-gray-400">Nullifier:</span>
                            <div className="flex items-center gap-1">
                              <span className="font-mono text-amber-400">{lastTransferResult.nullifier.slice(0, 20)}...</span>
                              <button onClick={() => handleCopy(lastTransferResult.nullifier || "", "nullifier")} className="text-gray-500 hover:text-white" data-testid="button-copy-nullifier">
                                {copiedField === "nullifier" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {lastTransferResult.secret && (
                        <div className="bg-amber-900/20 border border-amber-800/30 rounded p-2">
                          <p className="text-xs text-amber-400 font-semibold flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> Secret saved to your browser
                          </p>
                          <p className="text-xs text-amber-400/70 mt-1">
                            Your secret is stored locally and will NOT be saved on the server. Back it up if needed - it cannot be recovered.
                          </p>
                        </div>
                      )}
                      <p className="text-xs text-gray-500">
                        Send tokens to the burn address, then generate ZK proof to complete the transfer.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </Card>

            {userAgent && transfersQuery.data && transfersQuery.data.length > 0 && (
              <Card className="bg-gray-900/50 border-gray-800 p-6" data-testid="card-transfer-history">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold flex items-center gap-2">
                    <Clock className="w-5 h-5 text-blue-400" />
                    Transfer History
                  </h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/privacy/transfers", userAgent.id] })}
                    className="text-gray-400 hover:text-white"
                    data-testid="button-refresh-transfers"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>

                <div className="space-y-3">
                  {transfersQuery.data.map((transfer) => (
                    <div
                      key={transfer.id}
                      className="bg-gray-800/30 rounded-lg p-4 border border-gray-700/50"
                      data-testid={`card-transfer-${transfer.id}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Badge className={`${STATUS_COLORS[transfer.status] || "bg-gray-500/20 text-gray-400"} border text-xs`}>
                            {transfer.status}
                          </Badge>
                          <span className="text-sm font-medium">{transfer.tokenSymbol}</span>
                          <span className="text-xs text-gray-500">on {getChainName(transfer.chainId)}</span>
                        </div>
                        <span className="text-sm font-mono text-emerald-400">{transfer.amount}</span>
                      </div>
                      <div className="text-xs text-gray-500 space-y-1">
                        <div className="flex items-center gap-1">
                          <ArrowRight className="w-3 h-3" />
                          <span className="font-mono truncate">{transfer.recipientAddress}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Hash className="w-3 h-3 text-purple-400" />
                          <span className="font-mono truncate text-purple-400/70">{transfer.burnAddress}</span>
                        </div>
                        {transfer.proofId && (
                          <div className="flex items-center gap-1">
                            <FileCheck className="w-3 h-3 text-emerald-400" />
                            <span className="text-emerald-400/70">Proof: {transfer.proofId}</span>
                          </div>
                        )}
                        {transfer.depositTxHash && (
                          <div className="flex items-center gap-1">
                            <ExternalLink className="w-3 h-3" />
                            <a
                              href={getExplorerUrl(transfer.chainId, transfer.depositTxHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:underline font-mono truncate"
                              data-testid={`link-tx-${transfer.id}`}
                            >
                              {transfer.depositTxHash.slice(0, 16)}...
                            </a>
                          </div>
                        )}
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>{transfer.createdAt ? new Date(transfer.createdAt).toLocaleString() : "N/A"}</span>
                        </div>
                      </div>
                      {(transfer.status === "pending" || transfer.status === "deposited") && (
                        <div className="mt-3">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 text-xs"
                            onClick={() => generateProofMutation.mutate(transfer.id)}
                            disabled={generateProofMutation.isPending}
                            data-testid={`button-prove-${transfer.id}`}
                          >
                            {generateProofMutation.isPending ? (
                              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Generating Proof...</>
                            ) : (
                              <><FileCheck className="w-3 h-3 mr-1" /> Generate ZK Proof</>
                            )}
                          </Button>
                        </div>
                      )}
                      {transfer.errorMessage && (
                        <div className="mt-2 text-xs text-red-400 bg-red-900/10 rounded p-2">
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          {transfer.errorMessage}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card className="bg-gray-900/50 border-gray-800 p-6" data-testid="card-supported-tokens">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-amber-400" />
                Supported Tokens
              </h3>
              <div className="space-y-3">
                {(Object.entries(ZERC20_CONTRACTS) as [TokenKey, typeof ZERC20_CONTRACTS[TokenKey]][]).filter(([, v]) => v.tokenAddress).map(([symbol, contract]) => (
                  <div key={symbol} className="bg-gray-800/30 rounded-lg p-3 border border-gray-700/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-emerald-400">{symbol}</span>
                      <Badge variant="outline" className="text-xs border-gray-600 text-gray-400">
                        {Object.keys(contract.chains || {}).length} chains
                      </Badge>
                    </div>
                    <div className="text-xs text-gray-500 font-mono truncate">{contract.tokenAddress}</div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {Object.entries(contract.chains || {}).map(([chainId, info]) => (
                        <Badge
                          key={chainId}
                          variant="outline"
                          className="text-[10px] border-gray-700 text-gray-500"
                        >
                          {(info as any).label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="bg-gray-900/50 border-gray-800 p-6" data-testid="card-privacy-features">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Lock className="w-5 h-5 text-purple-400" />
                Privacy Features
              </h3>
              <div className="space-y-3 text-sm text-gray-400">
                <div className="flex items-start gap-2">
                  <Hash className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                  <span>Poseidon hashing (circomlibjs) for cryptographic burn address derivation</span>
                </div>
                <div className="flex items-start gap-2">
                  <EyeOff className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                  <span>ZK proof-of-burn via ZERC20 SDK breaks on-chain sender-recipient link</span>
                </div>
                <div className="flex items-start gap-2">
                  <Shield className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                  <span>Cross-chain privacy via LayerZero omnichain messaging</span>
                </div>
                <div className="flex items-start gap-2">
                  <Lock className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                  <span>Commitment + nullifier scheme prevents double-spending</span>
                </div>
                <div className="flex items-start gap-2">
                  <Unlock className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                  <span>Permissionless - any agent can use without registration</span>
                </div>
              </div>
            </Card>

            <Card className="bg-gradient-to-br from-emerald-900/20 to-blue-900/20 border-emerald-800/30 p-6" data-testid="card-why-privacy">
              <h3 className="text-lg font-semibold mb-3">Why Privacy Matters for Agents</h3>
              <p className="text-sm text-gray-400 leading-relaxed">
                Autonomous agents transacting on public blockchains expose their strategies, partnerships, and financial positions.
                ZERC20 privacy transfers protect agent operations from front-running, competitive intelligence, and surveillance.
                This is essential infrastructure for a truly autonomous agent economy.
              </p>
              <div className="mt-4 pt-4 border-t border-gray-700/50">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Eye className="w-3 h-3" />
                  <span>Powered by zerc20.io ZK protocol + circomlibjs Poseidon</span>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
