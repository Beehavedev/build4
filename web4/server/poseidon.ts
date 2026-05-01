let poseidonInstance: any = null;

export async function getPoseidon(): Promise<any> {
  if (!poseidonInstance) {
    const { buildPoseidon } = await import("circomlibjs");
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const hash = poseidon(inputs);
  return poseidon.F.toObject(hash);
}

export async function poseidonHashHex(inputs: bigint[]): Promise<string> {
  const hash = await poseidonHash(inputs);
  return "0x" + hash.toString(16).padStart(64, "0");
}

export function addressToBigInt(address: string): bigint {
  return BigInt(address.toLowerCase());
}

export function bigIntToAddress(value: bigint): string {
  const hex = value.toString(16).padStart(40, "0").slice(-40);
  return "0x" + hex;
}

export async function deriveBurnAddress(
  recipientAddress: string,
  secret: bigint,
  chainId: number
): Promise<{ burnAddress: string; nullifierHash: string; commitmentHash: string }> {
  const recipient = addressToBigInt(recipientAddress);
  const chainBigInt = BigInt(chainId);

  const commitment = await poseidonHash([recipient, secret, chainBigInt]);

  const nullifier = await poseidonHash([secret, commitment]);

  const burnAddressBigInt = commitment % BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  const burnAddress = bigIntToAddress(burnAddressBigInt);

  const commitmentHash = "0x" + commitment.toString(16).padStart(64, "0");
  const nullifierHash = "0x" + nullifier.toString(16).padStart(64, "0");

  return { burnAddress, nullifierHash, commitmentHash };
}

export function generateSecret(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}

export async function generateProofInputs(
  recipientAddress: string,
  secret: bigint,
  chainId: number,
  amount: string,
  tokenAddress: string
): Promise<{
  commitment: string;
  nullifier: string;
  burnAddress: string;
  publicInputs: {
    recipient: string;
    chainId: number;
    amount: string;
    tokenAddress: string;
    commitmentHash: string;
    nullifierHash: string;
  };
  privateInputs: {
    secret: string;
  };
}> {
  const { burnAddress, nullifierHash, commitmentHash } = await deriveBurnAddress(
    recipientAddress,
    secret,
    chainId
  );

  return {
    commitment: commitmentHash,
    nullifier: nullifierHash,
    burnAddress,
    publicInputs: {
      recipient: recipientAddress,
      chainId,
      amount,
      tokenAddress,
      commitmentHash,
      nullifierHash,
    },
    privateInputs: {
      secret: secret.toString(),
    },
  };
}
