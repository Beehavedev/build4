import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wallet, ExternalLink, ChevronDown, Smartphone, Globe } from "lucide-react";
import { useState, useEffect } from "react";

export function WalletConnector() {
  const {
    connected,
    address,
    chainName,
    balance,
    connecting,
    error,
    walletType,
    connect,
    connectMetaMask,
    connectWalletConnect,
    disconnect,
    hasContracts,
    hasWalletConnect,
  } = useWallet();
  const [showDetails, setShowDetails] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [dismissedError, setDismissedError] = useState(false);

  useEffect(() => {
    if (error) {
      setDismissedError(false);
      const timer = setTimeout(() => setDismissedError(true), 5000);
      return () => clearTimeout(timer);
    }
    setDismissedError(false);
  }, [error]);

  const visibleError = error && !dismissedError ? error : null;

  if (!connected) {
    return (
      <div className="relative">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (hasWalletConnect) {
              setShowOptions(!showOptions);
            } else {
              connect("metamask");
            }
          }}
          disabled={connecting}
          className="font-mono text-xs gap-1.5"
          data-testid="button-connect-wallet"
        >
          <Wallet className="w-3.5 h-3.5" />
          {connecting ? "Connecting..." : "Connect Wallet"}
        </Button>

        {showOptions && !connecting && (
          <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-card border rounded-lg shadow-xl p-2 space-y-1">
            <button
              onClick={() => { setShowOptions(false); connect("metamask"); }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-accent transition-colors text-left"
              data-testid="button-connect-metamask"
            >
              <Globe className="w-4 h-4 text-orange-500" />
              <div>
                <div className="font-mono text-xs font-medium">Browser Wallet</div>
                <div className="font-mono text-[10px] text-muted-foreground">MetaMask, Brave, etc.</div>
              </div>
            </button>
            <button
              onClick={() => { setShowOptions(false); connect("walletconnect"); }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-accent transition-colors text-left"
              data-testid="button-connect-walletconnect"
            >
              <Smartphone className="w-4 h-4 text-blue-500" />
              <div>
                <div className="font-mono text-xs font-medium">WalletConnect</div>
                <div className="font-mono text-[10px] text-muted-foreground">Scan QR with mobile wallet</div>
              </div>
            </button>
          </div>
        )}

        {visibleError && (
          <div className="absolute right-0 top-full mt-1 z-40 w-56 bg-destructive/10 border border-destructive/30 rounded-lg p-2 animate-in fade-in">
            <p className="font-mono text-[10px] text-destructive">{visibleError}</p>
          </div>
        )}
      </div>
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
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px]">
                {walletType === "walletconnect" ? "WalletConnect" : "Browser"}
              </Badge>
              <Badge variant="default" className="text-[10px]">Connected</Badge>
            </div>
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
          {visibleError && (
            <div className="text-[10px] text-destructive font-mono">{visibleError}</div>
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
