require("@nomicfoundation/hardhat-toolbox");

// BUILD4 Smart Contract Configuration
// Primary deployment target: BNB Chain (BSC) - Chain ID 56
// All core contracts deployed on BNB Smart Chain mainnet
// $B4 Token: 0x1d547f9d0890ee5abfb49d7d53ca19df85da4444 (BEP-20 on BSC)
// Staking: 0x5005dd0F5B3338526dd12f0Abc34C0Cb1Aa362ea (BNB Chain)

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: false,
    },
  },
  defaultNetwork: "bnbMainnet",
  paths: {
    sources: "./contracts",
    tests: "./contracts/test",
    cache: "./contracts/cache",
    artifacts: "./contracts/artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    // PRIMARY: BNB Chain (BSC) - All core contracts deployed here
    bnbTestnet: {
      url: process.env.BNB_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    bnbMainnet: {
      url: process.env.BNB_MAINNET_RPC || "https://bsc-dataseed1.binance.org",
      chainId: 56,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    baseTestnet: {
      url: process.env.BASE_TESTNET_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    baseMainnet: {
      url: process.env.BASE_MAINNET_RPC || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    xlayerTestnet: {
      url: process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech",
      chainId: 1952,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    xlayerMainnet: {
      url: process.env.XLAYER_MAINNET_RPC || "https://rpc.xlayer.tech",
      chainId: 196,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  sourcify: {
    enabled: true,
  },
  etherscan: {
    apiKey: {
      bsc: process.env.BSCSCAN_API_KEY || "PLACEHOLDER",
      base: process.env.BASESCAN_API_KEY || "PLACEHOLDER",
    },
    customChains: [
      {
        network: "xlayerMainnet",
        chainId: 196,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER",
          browserURL: "https://www.oklink.com/xlayer",
        },
      },
    ],
  },
};
