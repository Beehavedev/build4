import { useState, useCallback, useEffect } from "react";
import { BrowserProvider, JsonRpcSigner, Contract, formatEther, parseEther } from "ethers";
import { AgentEconomyHubABI } from "@/contracts/web4";

interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  balance: string | null;
  signer: JsonRpcSigner | null;
  provider: BrowserProvider | null;
  error: string | null;
  connecting: boolean;
}

interface ContractAddresses {
  AgentEconomyHub?: string;
  SkillMarketplace?: string;
  AgentReplication?: string;
  ConstitutionRegistry?: string;
}

const CHAIN_NAMES: Record<number, string> = {
  97: "BNB Chain Testnet",
  56: "BNB Chain",
  84532: "Base Sepolia",
  8453: "Base",
  195: "XLayer Testnet",
  196: "XLayer",
  31337: "Hardhat Local",
};

const CHAIN_CONFIGS: Record<number, { chainId: string; chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] }> = {
  97: {
    chainId: "0x61",
    chainName: "BNB Smart Chain Testnet",
    rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    blockExplorerUrls: ["https://testnet.bscscan.com"],
  },
  84532: {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    rpcUrls: ["https://sepolia.base.org"],
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
  195: {
    chainId: "0xc3",
    chainName: "XLayer Testnet",
    rpcUrls: ["https://testrpc.xlayer.tech"],
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    blockExplorerUrls: ["https://www.oklink.com/xlayer-test"],
  },
};

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    connected: false,
    address: null,
    chainId: null,
    balance: null,
    signer: null,
    provider: null,
    error: null,
    connecting: false,
  });

  const [contractAddresses, setContractAddresses] = useState<ContractAddresses>({});

  const [allDeployments, setAllDeployments] = useState<Record<string, any>>({});

  useEffect(() => {
    fetch("/api/web4/contracts")
      .then(r => r.json())
      .then(data => {
        const deployments = data.deployments || {};
        setAllDeployments(deployments);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!state.chainId || Object.keys(allDeployments).length === 0) return;
    const match = Object.values(allDeployments).find(
      (d: any) => d.chainId === state.chainId
    );
    if (match) {
      setContractAddresses((match as any).contracts || {});
    } else {
      const fallback = Object.values(allDeployments)[0] as any;
      if (fallback) setContractAddresses(fallback.contracts || {});
    }
  }, [state.chainId, allDeployments]);

  const connect = useCallback(async () => {
    if (typeof window === "undefined" || !(window as any).ethereum) {
      setState(s => ({ ...s, error: "No wallet detected. Install MetaMask or a compatible wallet." }));
      return;
    }

    setState(s => ({ ...s, connecting: true, error: null }));

    try {
      const provider = new BrowserProvider((window as any).ethereum);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);
      const balanceWei = await provider.getBalance(address);
      const balance = formatEther(balanceWei);

      setState({
        connected: true,
        address,
        chainId,
        balance,
        signer,
        provider,
        error: null,
        connecting: false,
      });
    } catch (err: any) {
      setState(s => ({
        ...s,
        error: err.message || "Failed to connect wallet",
        connecting: false,
      }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({
      connected: false,
      address: null,
      chainId: null,
      balance: null,
      signer: null,
      provider: null,
      error: null,
      connecting: false,
    });
  }, []);

  const switchChain = useCallback(async (targetChainId: number) => {
    if (!(window as any).ethereum) return;

    try {
      await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + targetChainId.toString(16) }],
      });
    } catch (switchError: any) {
      if (switchError.code === 4902 && CHAIN_CONFIGS[targetChainId]) {
        try {
          await (window as any).ethereum.request({
            method: "wallet_addEthereumChain",
            params: [CHAIN_CONFIGS[targetChainId]],
          });
        } catch {}
      }
    }
  }, []);

  const getHubContract = useCallback(() => {
    if (!state.signer || !contractAddresses.AgentEconomyHub) return null;
    return new Contract(contractAddresses.AgentEconomyHub, AgentEconomyHubABI, state.signer);
  }, [state.signer, contractAddresses.AgentEconomyHub]);

  const depositToAgent = useCallback(async (agentId: string, amountEth: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.deposit(agentId, { value: parseEther(amountEth) });
    return tx.wait();
  }, [getHubContract]);

  const getAgentBalance = useCallback(async (agentId: string) => {
    const hub = getHubContract();
    if (!hub) return "0";
    const balance = await hub.getBalance(agentId);
    return formatEther(balance);
  }, [getHubContract]);

  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).ethereum) return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect();
      } else if (state.connected) {
        connect();
      }
    };

    const handleChainChanged = () => {
      if (state.connected) connect();
    };

    (window as any).ethereum.on("accountsChanged", handleAccountsChanged);
    (window as any).ethereum.on("chainChanged", handleChainChanged);

    return () => {
      (window as any).ethereum?.removeListener("accountsChanged", handleAccountsChanged);
      (window as any).ethereum?.removeListener("chainChanged", handleChainChanged);
    };
  }, [state.connected, connect, disconnect]);

  return {
    ...state,
    chainName: state.chainId ? (CHAIN_NAMES[state.chainId] || `Chain ${state.chainId}`) : null,
    contractAddresses,
    connect,
    disconnect,
    switchChain,
    getHubContract,
    depositToAgent,
    getAgentBalance,
    hasContracts: !!contractAddresses.AgentEconomyHub,
  };
}
