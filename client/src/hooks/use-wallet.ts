import { useState, useCallback, useEffect, useRef } from "react";
import { BrowserProvider, JsonRpcSigner, Contract, formatEther, parseEther, keccak256, toUtf8Bytes } from "ethers";
import { AgentEconomyHubABI, SkillMarketplaceABI, ConstitutionRegistryABI, AgentReplicationABI } from "@/contracts/web4";

interface WalletState {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  balance: string | null;
  signer: JsonRpcSigner | null;
  provider: BrowserProvider | null;
  error: string | null;
  connecting: boolean;
  walletType: "metamask" | "walletconnect" | null;
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
  1952: "XLayer Testnet",
  196: "XLayer",
  31337: "Hardhat Local",
};

const CHAIN_CONFIGS: Record<number, { chainId: string; chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] }> = {
  56: {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    rpcUrls: ["https://bsc-dataseed1.binance.org"],
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrls: ["https://bscscan.com"],
  },
  97: {
    chainId: "0x61",
    chainName: "BNB Smart Chain Testnet",
    rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    blockExplorerUrls: ["https://testnet.bscscan.com"],
  },
  8453: {
    chainId: "0x2105",
    chainName: "Base",
    rpcUrls: ["https://mainnet.base.org"],
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://basescan.org"],
  },
  84532: {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    rpcUrls: ["https://sepolia.base.org"],
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
  196: {
    chainId: "0xc4",
    chainName: "XLayer",
    rpcUrls: ["https://rpc.xlayer.tech"],
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    blockExplorerUrls: ["https://www.oklink.com/xlayer"],
  },
  1952: {
    chainId: "0x7a0",
    chainName: "XLayer Testnet",
    rpcUrls: ["https://testrpc.xlayer.tech"],
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    blockExplorerUrls: ["https://www.oklink.com/xlayer-test"],
  },
};

const BLOCK_EXPLORER: Record<number, string> = {
  97: "https://testnet.bscscan.com",
  56: "https://bscscan.com",
  84532: "https://sepolia.basescan.org",
  8453: "https://basescan.org",
  1952: "https://www.oklink.com/xlayer-test",
  196: "https://www.oklink.com/xlayer",
};

const SUPPORTED_CHAIN_IDS = [56, 8453, 196, 97, 84532, 1952];

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
    walletType: null,
  });

  const [contractAddresses, setContractAddresses] = useState<ContractAddresses>({});
  const [allDeployments, setAllDeployments] = useState<Record<string, any>>({});
  const [wcProjectId, setWcProjectId] = useState<string | null>(null);
  const wcProviderRef = useRef<any>(null);

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

  const setupFromProvider = useCallback(async (rawProvider: any, walletType: "metamask" | "walletconnect") => {
    const provider = new BrowserProvider(rawProvider);
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
      setState(s => ({
        ...s,
        error: err.message || "Failed to connect MetaMask",
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

      const wcProvider = await EthereumProvider.init({
        projectId: wcProjectId,
        chains: [56],
        optionalChains: [8453, 196, 97, 84532, 1952],
        showQrModal: true,
        metadata: {
          name: "BUILD4",
          description: "Autonomous AI Agent Economy on BNB Chain, Base & XLayer",
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.ico`],
        },
        rpcMap: {
          56: "https://bsc-dataseed1.binance.org",
          97: "https://data-seed-prebsc-1-s1.binance.org:8545",
          8453: "https://mainnet.base.org",
          84532: "https://sepolia.base.org",
          196: "https://rpc.xlayer.tech",
          1952: "https://testrpc.xlayer.tech",
        },
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

      await wcProvider.enable();
      await setupFromProvider(wcProvider, "walletconnect");
    } catch (err: any) {
      setState(s => ({
        ...s,
        error: err.message || "Failed to connect via WalletConnect",
        connecting: false,
      }));
    }
  }, [wcProjectId, setupFromProvider]);

  const connect = useCallback(async (type?: "metamask" | "walletconnect") => {
    if (type === "walletconnect") {
      return connectWalletConnect();
    }
    if (type === "metamask") {
      return connectMetaMask();
    }
    return connectMetaMask();
  }, [connectMetaMask, connectWalletConnect]);

  const disconnect = useCallback(async () => {
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

  const depositToAgent = useCallback(async (agentId: number, amountEth: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available. Connect wallet first.");
    const tx = await hub.deposit(agentId, { value: parseEther(amountEth) });
    return tx.wait();
  }, [getHubContract]);

  const withdrawFromAgent = useCallback(async (agentId: number, amountEth: string, toAddress: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.withdraw(agentId, parseEther(amountEth), toAddress);
    return tx.wait();
  }, [getHubContract]);

  const transferBetweenAgents = useCallback(async (fromId: number, toId: number, amountEth: string) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.transfer(fromId, toId, parseEther(amountEth));
    return tx.wait();
  }, [getHubContract]);

  const registerAgent = useCallback(async (agentId: number) => {
    const hub = getHubContract();
    if (!hub) throw new Error("Hub contract not available");
    const tx = await hub.registerAgent(agentId);
    return tx.wait();
  }, [getHubContract]);

  const getAgentOnChainWallet = useCallback(async (agentId: number) => {
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

  const getConstitution = useCallback(async (agentId: number) => {
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

  const addLawOnChain = useCallback(async (agentId: number, lawText: string, isImmutable: boolean) => {
    const constitution = getConstitutionContract();
    if (!constitution) throw new Error("Constitution contract not available");
    const lawHash = keccak256(toUtf8Bytes(lawText));
    const tx = await constitution.addLaw(agentId, lawHash, isImmutable);
    return tx.wait();
  }, [getConstitutionContract]);

  const sealConstitutionOnChain = useCallback(async (agentId: number) => {
    const constitution = getConstitutionContract();
    if (!constitution) throw new Error("Constitution contract not available");
    const tx = await constitution.sealConstitution(agentId);
    return tx.wait();
  }, [getConstitutionContract]);

  const getLineageOnChain = useCallback(async (agentId: number) => {
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

  const getExplorerUrl = useCallback((txHash: string) => {
    if (!state.chainId) return null;
    const base = BLOCK_EXPLORER[state.chainId];
    return base ? `${base}/tx/${txHash}` : null;
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
    chainName: state.chainId ? (CHAIN_NAMES[state.chainId] || `Chain ${state.chainId}`) : null,
    contractAddresses,
    connect,
    connectMetaMask,
    connectWalletConnect,
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
    getExplorerUrl,
    hasContracts: !!contractAddresses.AgentEconomyHub,
    hasWalletConnect: !!wcProjectId,
    supportedChains: SUPPORTED_CHAIN_IDS,
  };
}
