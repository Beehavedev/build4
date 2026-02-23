import { deriveBurnAddress, generateSecret, generateProofInputs, poseidonHash, poseidonHashHex } from "./poseidon";
import { ZERC20_CONTRACTS, SUPPORTED_PRIVACY_CHAINS } from "@shared/schema";

export interface ZERC20TransferParams {
  recipientAddress: string;
  chainId: number;
  tokenSymbol: string;
  amount: string;
}

export interface ZERC20PreparedTransfer {
  burnAddress: string;
  commitmentHash: string;
  nullifierHash: string;
  secret: string;
  proofInputs: {
    recipient: string;
    chainId: number;
    amount: string;
    tokenAddress: string;
    commitmentHash: string;
    nullifierHash: string;
  };
  tokenAddress: string;
  verifierAddress: string;
  hubAddress: string;
}

export interface ZERC20ProofResult {
  proofId: string;
  status: "generated" | "pending" | "failed";
  commitment: string;
  nullifier: string;
  proofData?: string;
  timestamp: number;
  error?: string;
}

const proofStore = new Map<string, ZERC20ProofResult>();

export function getTokenConfig(tokenSymbol: string) {
  const config = ZERC20_CONTRACTS[tokenSymbol as keyof typeof ZERC20_CONTRACTS];
  if (!config || !config.tokenAddress) {
    return null;
  }
  return config;
}

export function isSupportedChain(chainId: number): boolean {
  return chainId in SUPPORTED_PRIVACY_CHAINS;
}

export function isTokenSupportedOnChain(tokenSymbol: string, chainId: number): boolean {
  const config = getTokenConfig(tokenSymbol);
  if (!config) return false;
  return chainId.toString() in (config.chains || {});
}

export async function preparePrivacyTransfer(
  params: ZERC20TransferParams
): Promise<ZERC20PreparedTransfer> {
  const { recipientAddress, chainId, tokenSymbol, amount } = params;

  if (!/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
    throw new Error("Invalid recipient address");
  }

  if (!isSupportedChain(chainId)) {
    throw new Error(`Chain ${chainId} not supported for privacy transfers`);
  }

  const tokenConfig = getTokenConfig(tokenSymbol);
  if (!tokenConfig) {
    throw new Error(`Token ${tokenSymbol} not supported`);
  }

  if (!isTokenSupportedOnChain(tokenSymbol, chainId)) {
    throw new Error(`Token ${tokenSymbol} not available on chain ${chainId}`);
  }

  const secret = generateSecret();
  const { burnAddress, nullifierHash, commitmentHash } = await deriveBurnAddress(
    recipientAddress,
    secret,
    chainId
  );

  const proofInputs = await generateProofInputs(
    recipientAddress,
    secret,
    chainId,
    amount,
    tokenConfig.tokenAddress
  );

  return {
    burnAddress,
    commitmentHash,
    nullifierHash,
    secret: secret.toString(),
    proofInputs: proofInputs.publicInputs,
    tokenAddress: tokenConfig.tokenAddress,
    verifierAddress: tokenConfig.verifierAddress,
    hubAddress: tokenConfig.hubAddress,
  };
}

export async function generateProof(
  transferId: string,
  recipientAddress: string,
  secret: string,
  chainId: number,
  amount: string,
  tokenSymbol: string
): Promise<ZERC20ProofResult> {
  const tokenConfig = getTokenConfig(tokenSymbol);
  if (!tokenConfig) {
    const result: ZERC20ProofResult = {
      proofId: `proof_${transferId}`,
      status: "failed",
      commitment: "",
      nullifier: "",
      timestamp: Date.now(),
      error: `Token ${tokenSymbol} not configured`,
    };
    proofStore.set(result.proofId, result);
    return result;
  }

  try {
    const secretBigInt = BigInt(secret);
    const proofInputs = await generateProofInputs(
      recipientAddress,
      secretBigInt,
      chainId,
      amount,
      tokenConfig.tokenAddress
    );

    const proofDataPayload = {
      protocol: "zerc20",
      version: "1.0-simulation",
      circuit: "burn-proof",
      note: "Simulated proof structure - production requires ZERC20 circuit WASM/zkey for real Groth16 proof generation",
      publicSignals: [
        proofInputs.publicInputs.commitmentHash,
        proofInputs.publicInputs.nullifierHash,
        recipientAddress,
        chainId.toString(),
        amount,
        tokenConfig.tokenAddress,
      ],
      proof: {
        pi_a: [proofInputs.commitment, proofInputs.nullifier],
        pi_b: [[proofInputs.commitment, proofInputs.nullifier]],
        pi_c: [proofInputs.commitment],
      },
      verifier: tokenConfig.verifierAddress,
      hub: tokenConfig.hubAddress,
    };

    const result: ZERC20ProofResult = {
      proofId: `proof_${transferId}`,
      status: "generated",
      commitment: proofInputs.commitment,
      nullifier: proofInputs.nullifier,
      proofData: JSON.stringify(proofDataPayload),
      timestamp: Date.now(),
    };

    proofStore.set(result.proofId, result);
    return result;
  } catch (error: any) {
    const result: ZERC20ProofResult = {
      proofId: `proof_${transferId}`,
      status: "failed",
      commitment: "",
      nullifier: "",
      timestamp: Date.now(),
      error: error.message,
    };
    proofStore.set(result.proofId, result);
    return result;
  }
}

export function getProof(proofId: string): ZERC20ProofResult | undefined {
  return proofStore.get(proofId);
}

export async function verifyCommitment(
  recipientAddress: string,
  secret: string,
  chainId: number,
  expectedBurnAddress: string
): Promise<{ valid: boolean; computedBurnAddress: string; commitmentHash: string }> {
  try {
    const secretBigInt = BigInt(secret);
    const { burnAddress, commitmentHash } = await deriveBurnAddress(
      recipientAddress,
      secretBigInt,
      chainId
    );
    return {
      valid: burnAddress.toLowerCase() === expectedBurnAddress.toLowerCase(),
      computedBurnAddress: burnAddress,
      commitmentHash,
    };
  } catch {
    return { valid: false, computedBurnAddress: "", commitmentHash: "" };
  }
}

export async function computeNullifier(secret: string, commitment: string): Promise<string> {
  const secretBigInt = BigInt(secret);
  const commitmentBigInt = BigInt(commitment);
  return poseidonHashHex([secretBigInt, commitmentBigInt]);
}
