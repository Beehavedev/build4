import { useState, useCallback, useEffect, useRef, createContext, useContext } from "react";
import { BrowserProvider, JsonRpcSigner, Contract, formatEther, parseEther, keccak256, toUtf8Bytes } from "ethers";
import { AgentEconomyHubABI, SkillMarketplaceABI, ConstitutionRegistryABI, AgentReplicationABI } from "@/contracts/web4";
import { EVM_CHAINS, CONTRACT_CHAINS, getChainName, getChainCurrency, isContractChain } from "@shared/evm-chains";

interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  balance: string | null;
  signer: JsonRpcSigner | null;
  provider: BrowserProvider | null;
  error: string | null;
  connecting: boolean;
  walletType: "metamask" | "walletconnect" | "okxwallet" | null;
}

interface ContractAddresses {
  AgentEconomyHub?: string;
  SkillMarketplace?: string;
  AgentReplication?: string;
  ConstitutionRegistry?: string;
}

const CHAIN_CONFIGS: Record<number, { chainId: string; chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] }> = {};
for (const [id, info] of Object.entries(EVM_CHAINS)) {
  const chainId = Number(id);
  CHAIN_CONFIGS[chainId] = {
    chainId: "0x" + chainId.toString(16),
    chainName: info.name,
    rpcUrls: info.rpcUrls,
    nativeCurrency: { name: info.currency, symbol: info.currency, decimals: info.decimals },
    blockExplorerUrls: [info.explorerUrl],
  };
}

export type WalletContextType = ReturnType<typeof useWalletInternal>;

const WalletContext = createContext<WalletContextType | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletInternal();
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}

function useWalletInternal() {
  const [state, setState] = useState<WalletState>({
    connected: false,
    address: null,
    chainId: null,
    balance: null,
    signer: null,
    provider: null,
    error: null,
    connecting: false,
    walletType: null,
  });

  const [contractAddresses, setContractAddresses] = useState<ContractAddresses>({});
  const [allDeployments, setAllDeployments] = useState<Record<string, any>>({});
  const [wcProjectId, setWcProjectId] = useState<string | null>(null);
  const wcProviderRef = useRef<any>(null);

  const autoReconnectRef = useRef(false);

  useEffect(() => {
    fetch("/api/web4/contracts")
      .then(r => r.json())
      .then(data => {
        const deployments = data.deployments || {};
        setAllDeployments(deployments);
      })
      .catch(() => {});

    fetch("/api/web4/walletconnect-config")
      .then(r => r.json())
      .then(data => {
        if (data.projectId) setWcProjectId(data.projectId);
      })
      .catch(() => {});

    if (!autoReconnectRef.current) {
      autoReconnectRef.current = true;
      const savedType = (() => { try { return localStorage.getItem("build4_wallet_type"); } catch { return null; } })();
      if (savedType === "metamask" && typeof window !== "undefined" && (window as any).ethereum) {
        const ethereum = (window as any).ethereum;
        ethereum.request({ method: "eth_accounts" }).then((accounts: string[]) => {
          if (accounts.length > 0) {
            setupFromProvider(ethereum, "metamask").catch(() => {});
          }
        }).catch(() => {});
      }
    }
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

  const setupFromProvider = useCallback(async (rawProvider: any, walletType: "metamask" | "walletconnect" | "okxwallet") => {
    const provider = new BrowserProvider(rawProvider);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    let balance = "0";
    try {
      const balanceWei = await provider.getBalance(address);
      balance = formatEther(balanceWei);
    } catch {
    }

    try { localStorage.setItem("build4_wallet_type", walletType); } catch {}
    try { localStorage.setItem("connectedWallet", address); } catch {}

    setState({
      connected: true,
      address,
      chainId,
      balance,
      signer,
      provider,
      error: null,
      connecting: false,
      walletType,
    });
  }, []);

  const connectMetaMask = useCallback(async () => {
    if (typeof window === "undefined" || !(window as any).ethereum) {
      setState(s => ({ ...s, error: "No browser wallet detected. Install MetaMask or use WalletConnect." }));
      return;
    }

    setState(s => ({ ...s, connecting: true, error: null }));

    try {
      const ethereum = (window as any).ethereum;
      await ethereum.request({ method: "eth_requestAccounts" });
      await setupFromProvider(ethereum, "metamask");
    } catch (err: any) {
      const raw = err.message || "";
      let friendly = "Failed to connect wallet. Please try again.";
      if (raw.includes("user rejected") || raw.includes("User denied")) {
        friendly = "Connection cancelled. Click Connect Wallet to try again.";
      } else if (raw.includes("failed to fetch") || raw.includes("could not coalesce") || raw.includes("UNKNOWN_ERROR")) {
        friendly = "Network issue — wallet connected but couldn't reach the blockchain. Try switching networks or refreshing the page.";
      }
      setState(s => ({
        ...s,
        error: friendly,
        connecting: false,
      }));
    }
  }, [setupFromProvider]);

  const connectWalletConnect = useCallback(async () => {
    if (!wcProjectId) {
      setState(s => ({ ...s, error: "WalletConnect not configured" }));
      return;
    }

    setState(s => ({ ...s, connecting: true, error: null }));

    try {
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");

      const allChainIds = Object.keys(EVM_CHAINS).map(Number);
      const wcRpcMap: Record<number, string> = {};
      for (const [id, info] of Object.entries(EVM_CHAINS)) {
        wcRpcMap[Number(id)] = info.rpcUrls[0];
      }
      wcRpcMap[97] = "https://data-seed-prebsc-1-s1.binance.org:8545";
      wcRpcMap[84532] = "https://sepolia.base.org";
      wcRpcMap[1952] = "https://testrpc.xlayer.tech";

      if (wcProviderRef.current) {
        try { await wcProviderRef.current.disconnect(); } catch {}
        wcProviderRef.current = null;
      }

      const wcProvider = await EthereumProvider.init({
        projectId: wcProjectId,
        chains: [56],
        optionalChains: allChainIds.filter(id => id !== 56),
        showQrModal: true,
        metadata: {
          name: "BUILD4",
          description: "Autonomous AI Agent Economy — All EVM Chains",
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.ico`],
        },
        rpcMap: wcRpcMap,
      });

      wcProviderRef.current = wcProvider;

      wcProvider.on("disconnect", () => {
        setState({
          connected: false,
          address: null,
          chainId: null,
          balance: null,
          signer: null,
          provider: null,
          error: null,
          connecting: false,
          walletType: null,
        });
        wcProviderRef.current = null;
      });

      wcProvider.on("chainChanged", async () => {
        try {
          await setupFromProvider(wcProvider, "walletconnect");
        } catch {}
      });

      wcProvider.on("accountsChanged", async (accounts: string[]) => {
        if (accounts.length === 0) {
          setState(s => ({ ...s, connected: false, address: null, walletType: null }));
        } else {
          try {
            await setupFromProvider(wcProvider, "walletconnect");
          } catch {}
        }
      });

      const enableTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WC_TIMEOUT")), 120000)
      );
      await Promise.race([wcProvider.enable(), enableTimeout]);
      await setupFromProvider(wcProvider, "walletconnect");
    } catch (err: any) {
      const raw = err.message || err.toString() || "";
      let friendly = "Failed to connect via WalletConnect. Please try again.";
      if (raw.includes("user rejected") || raw.includes("User denied") || raw.includes("User closed") || raw.includes("modal_closed")) {
        friendly = "Connection cancelled. Tap Connect Wallet to try again.";
      } else if (raw.includes("WC_TIMEOUT")) {
        friendly = "Connection timed out. Make sure you approve the request in your wallet app.";
      } else if (raw.includes("failed to fetch") || raw.includes("could not coalesce") || raw.includes("UNKNOWN_ERROR")) {
        friendly = "Network issue — try switching networks in your wallet or refreshing the page.";
      } else if (raw.includes("Missing or invalid") || raw.includes("projectId")) {
        friendly = "WalletConnect configuration issue. Please try Browser Wallet instead.";
      }
      if (wcProviderRef.current) {
        try { await wcProviderRef.current.disconnect(); } catch {}
        wcProviderRef.current = null;
      }
      setState(s => ({
        ...s,
        error: friendly,
        connecting: false,
      }));
    }
  }, [wcProjectId, setupFromProvider]);

  const connectOKXWallet = useCallback(async () => {
    const okxProvider = (window as any).okxwallet;
    if (!okxProvider) {
      setState(s => ({ ...s, error: "OKX Wallet not detected. Install the OKX Wallet extension." }));
      return;
    }

    setState(s => ({ ...s, connecting: true, error: null }));

    try {
      await okxProvider.request({ method: "eth_requestAccounts" });
      await setupFromProvider(okxProvider, "okxwallet");
    } catch (err: any) {
      const raw = err.message || "";
      let friendly = "Failed to connect OKX Wallet. Please try again.";
      if (raw.includes("user rejected") || raw.includes("User denied")) {
        friendly = "Connection cancelled. Click Connect Wallet to try again.";
      }
      setState(s => ({ ...s, error: friendly, connecting: false }));
    }
  }, [setupFromProvider]);

  const connect = useCallback(async (type?: "metamask" | "walletconnect" | "okxwallet") => {
    if (type === "walletconnect") {
      return connectWalletConnect();
    }
    if (type === "okxwallet") {
      return connectOKXWallet();
    }
    if (type === "metamask") {
      return connectMetaMask();
    }
    return connectMetaMask();
  }, [connectMetaMask, connectWalletConnect, connectOKXWallet]);

  const disconnect = useCallback(async () => {
    try { localStorage.removeItem("build4_wallet_type"); } catch {}
    try { localStorage.removeItem("connectedWallet"); } catch {}
    if (wcProviderRef.current) {
      try {
        await wcProviderRef.current.disconnect();
      } catch {}
      wcProviderRef.current = null;
    }
    setState({
      connected: false,
      address: null,
      chainId: null,
      balance: null,
      signer: null,
      provider: null,
      error: null,
      connecting: false,
      walletType: null,
    });
  }, []);

  const switchChain = useCallback(async (targetChainId: number) => {
    const hexChainId = "0x" + targetChainId.toString(16);

    if (state.walletType === "walletconnect" && wcProviderRef.current) {
      try {
        await wcProviderRef.current.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexChainId }],
        });
      } catch {}
      return;
    }

    if (!(window as any).ethereum) return;

    try {
      await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
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
  }, [state.walletType]);

  const getHubContract = useCallback(() => {
    if (!state.signer || !contractAddresses.AgentEconomyHub) return null;
    return new Contract(contractAddresses.AgentEconomyHub, AgentEconomyHubABI, state.signer);
  }, [state.signer, contractAddresses.AgentEconomyHub]);

  const getMarketplaceContract = useCallback(() => {
    if (!state.signer || !contractAddresses.SkillMarketplace) return null;
    return new Contract(contractAddresses.SkillMarketplace, SkillMarketplaceABI, state.signer);
  }, [state.signer, contractAddresses.SkillMarketplace]);

  const getConstitutionContract = useCallback(() => {
    if (!state.signer || !contractAddresses.ConstitutionRegistry) return null;
    return new Contract(contractAddresses.ConstitutionRegistry, ConstitutionRegistryABI, state.signer);
  }, [state.signer, contractAddresses.ConstitutionRegistry]);

  const getReplicationContract = useCallback(() => {
    if (!state.signer || !contractAddresses.AgentReplication) return null;
    return new Contract(contractAddresses.AgentReplication, AgentReplicationABI, state.signer);
  }, [state.signer, contractAddresses.AgentReplication]);

  const depositToAgent = useCallback(async (agentId: bigint | number, amountEth: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available. Connect wallet first.");
    const tx = await hub.deposit(BigInt(agentId), { value: parseEther(amountEth) });
    return tx.wait();
  }, [getHubContract]);

  const withdrawFromAgent = useCallback(async (agentId: bigint | number, amountEth: string, toAddress: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.withdraw(BigInt(agentId), parseEther(amountEth), toAddress);
    return tx.wait();
  }, [getHubContract]);

  const transferBetweenAgents = useCallback(async (fromId: bigint | number, toId: bigint | number, amountEth: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.transfer(BigInt(fromId), BigInt(toId), parseEther(amountEth));
    return tx.wait();
  }, [getHubContract]);

  const registerAgent = useCallback(async (agentId: bigint | number) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.registerAgent(BigInt(agentId));
    return tx.wait();
  }, [getHubContract]);

  const getAgentOnChainWallet = useCallback(async (agentId: number | bigint) => {
    const hub = getHubContract();
    if (!hub) return null;
    try {
      const [balance, totalEarned, totalSpent, lastActiveBlock] = await hub.getWallet(agentId);
      const tier = await hub.computeTier(agentId);
      const isRegistered = await hub.isAgentRegistered(agentId);
      return {
        balance: formatEther(balance),
        totalEarned: formatEther(totalEarned),
        totalSpent: formatEther(totalSpent),
        lastActiveBlock: Number(lastActiveBlock),
        tier: Number(tier),
        isRegistered,
      };
    } catch {
      return null;
    }
  }, [getHubContract]);

  const getSkillOnChain = useCallback(async (skillId: number) => {
    const marketplace = getMarketplaceContract();
    if (!marketplace) return null;
    try {
      const [agentId, name, metadataUri, price, totalSales, totalRevenue, isActive] = await marketplace.getSkill(skillId);
      return {
        agentId: Number(agentId),
        name,
        metadataUri,
        price: formatEther(price),
        totalSales: Number(totalSales),
        totalRevenue: formatEther(totalRevenue),
        isActive,
      };
    } catch {
      return null;
    }
  }, [getMarketplaceContract]);

  const getConstitution = useCallback(async (agentId: number | bigint) => {
    const constitution = getConstitutionContract();
    if (!constitution) return null;
    try {
      const lawCount = Number(await constitution.getLawCount(agentId));
      const sealed = await constitution.isSealed(agentId);
      const hash = await constitution.getConstitutionHash(agentId);
      const laws: { lawHash: string; createdBlock: number; isImmutable: boolean }[] = [];
      for (let i = 0; i < lawCount; i++) {
        const [lawHash, createdBlock, isImmutable] = await constitution.getLaw(agentId, i);
        laws.push({ lawHash, createdBlock: Number(createdBlock), isImmutable });
      }
      return { lawCount, sealed, hash, laws };
    } catch {
      return null;
    }
  }, [getConstitutionContract]);

  const addLawOnChain = useCallback(async (agentId: number | bigint, lawText: string, isImmutable: boolean) => {
    const constitution = getConstitutionContract();
    if (!constitution) throw new Error("Constitution contract not available");
    const lawHash = keccak256(toUtf8Bytes(lawText));
    const tx = await constitution.addLaw(agentId, lawHash, isImmutable);
    return tx.wait();
  }, [getConstitutionContract]);

  const sealConstitutionOnChain = useCallback(async (agentId: number | bigint) => {
    const constitution = getConstitutionContract();
    if (!constitution) throw new Error("Constitution contract not available");
    const tx = await constitution.sealConstitution(agentId);
    return tx.wait();
  }, [getConstitutionContract]);

  const getLineageOnChain = useCallback(async (agentId: number | bigint) => {
    const replication = getReplicationContract();
    if (!replication) return null;
    try {
      const [parentId, revenueShareBps, exists] = await replication.getParent(agentId);
      const children = await replication.getChildren(agentId);
      const generation = Number(await replication.agentGeneration(agentId));
      return {
        parentId: Number(parentId),
        revenueShareBps: Number(revenueShareBps),
        hasParent: exists,
        children: children.map((c: bigint) => Number(c)),
        generation,
      };
    } catch {
      return null;
    }
  }, [getReplicationContract]);

  const replicateOnChain = useCallback(async (parentId: number, childId: number, revenueShareBps: number, fundingEth: string) => {
    const replication = getReplicationContract();
    if (!replication) throw new Error("Replication contract not available");
    const tx = await replication.replicate(parentId, childId, revenueShareBps, parseEther(fundingEth));
    return tx.wait();
  }, [getReplicationContract]);

  const sendDirectTransfer = useCallback(async (toAddress: string, amountEth: string) => {
    if (!state.signer) throw new Error("Wallet not connected");
    const tx = await state.signer.sendTransaction({
      to: toAddress,
      value: parseEther(amountEth),
    });
    const receipt = await tx.wait();
    if (!receipt) throw new Error("Transaction failed");
    return receipt;
  }, [state.signer]);

  const getExplorerUrl = useCallback((txHash: string) => {
    if (!state.chainId) return null;
    const chain = EVM_CHAINS[state.chainId];
    return chain ? `${chain.explorerUrl}/tx/${txHash}` : null;
  }, [state.chainId]);

  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).ethereum) return;
    if (state.walletType === "walletconnect") return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect();
      } else if (state.connected) {
        connectMetaMask();
      }
    };

    const handleChainChanged = () => {
      if (state.connected) connectMetaMask();
    };

    (window as any).ethereum.on("accountsChanged", handleAccountsChanged);
    (window as any).ethereum.on("chainChanged", handleChainChanged);

    return () => {
      (window as any).ethereum?.removeListener("accountsChanged", handleAccountsChanged);
      (window as any).ethereum?.removeListener("chainChanged", handleChainChanged);
    };
  }, [state.connected, state.walletType, connectMetaMask, disconnect]);

  return {
    ...state,
    chainName: state.chainId ? getChainName(state.chainId) : null,
    chainCurrency: state.chainId ? getChainCurrency(state.chainId) : "ETH",
    isContractChain: state.chainId ? isContractChain(state.chainId) : false,
    contractAddresses,
    connect,
    connectMetaMask,
    connectWalletConnect,
    connectOKXWallet,
    disconnect,
    switchChain,
    getHubContract,
    getMarketplaceContract,
    getConstitutionContract,
    getReplicationContract,
    depositToAgent,
    withdrawFromAgent,
    transferBetweenAgents,
    registerAgent,
    getAgentOnChainWallet,
    getSkillOnChain,
    getConstitution,
    addLawOnChain,
    sealConstitutionOnChain,
    getLineageOnChain,
    replicateOnChain,
    sendDirectTransfer,
    getExplorerUrl,
    signMessage: async (message: string): Promise<string> => {
      if (!state.signer) throw new Error("Wallet not connected");
      return await state.signer.signMessage(message);
    },
    hasContracts: !!contractAddresses.AgentEconomyHub,
    hasWalletConnect: !!wcProjectId,
    contractChains: CONTRACT_CHAINS,
  };
}
