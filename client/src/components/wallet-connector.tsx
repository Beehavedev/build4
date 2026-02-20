import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wallet, ExternalLink, ChevronDown } from "lucide-react";
import { useState } from "react";

export function WalletConnector() {
  const {
    connected,
    address,
    chainName,
    balance,
    connecting,
    error,
    connect,
    disconnect,
    hasContracts,
  } = useWallet();
  const [showDetails, setShowDetails] = useState(false);

  if (!connected) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={connect}
        disabled={connecting}
        className="font-mono text-xs gap-1.5"
        data-testid="button-connect-wallet"
      >
        <Wallet className="w-3.5 h-3.5" />
        {connecting ? "..." : "Connect"}
      </Button>
    );
  }

  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowDetails(!showDetails)}
        className="font-mono text-xs gap-1.5"
        data-testid="button-wallet-info"
      >
        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span>{shortAddress}</span>
        <ChevronDown className="w-3 h-3" />
      </Button>

      {showDetails && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-card border rounded-lg shadow-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">Wallet</span>
            <Badge variant="default" className="text-[10px]">Connected</Badge>
          </div>
          <div className="font-mono text-xs break-all" data-testid="text-wallet-address">{address}</div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">Network</span>
            <span className="font-mono text-xs" data-testid="text-chain-name">{chainName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">Balance</span>
            <span className="font-mono text-xs" data-testid="text-wallet-balance">{parseFloat(balance || "0").toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">Contracts</span>
            <Badge variant={hasContracts ? "default" : "secondary"} className="text-[10px]">
              {hasContracts ? "Deployed" : "Not Found"}
            </Badge>
          </div>
          {error && (
            <div className="text-[10px] text-destructive font-mono">{error}</div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { disconnect(); setShowDetails(false); }}
            className="w-full text-xs font-mono"
            data-testid="button-disconnect-wallet"
          >
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}
