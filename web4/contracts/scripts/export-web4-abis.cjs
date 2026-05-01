const fs = require("fs");
const path = require("path");

const CONTRACTS = [
  "AgentEconomyHub",
  "ConstitutionRegistry",
  "SkillMarketplace",
  "AgentReplication",
  "BUILD4Staking",
];

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "contracts", "web4");
const OUTPUT_DIR = path.join(__dirname, "..", "..", "client", "src", "contracts", "web4");

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const abis = {};

  for (const name of CONTRACTS) {
    const artifactPath = path.join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(artifactPath)) {
      console.warn(`Artifact not found for ${name} at ${artifactPath}`);
      continue;
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    abis[name] = artifact.abi;

    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${name}.abi.json`),
      JSON.stringify(artifact.abi, null, 2)
    );
    console.log(`Exported ABI: ${name} (${artifact.abi.length} entries)`);
  }

  let deploymentsDir = path.join(__dirname, "..", "deployments");
  let addresses = {};

  if (fs.existsSync(deploymentsDir)) {
    const files = fs.readdirSync(deploymentsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), "utf8"));
      const network = file.replace(".json", "");
      addresses[network] = data.contracts;
    }
  }

  const indexContent = `
export const WEB4_CONTRACTS = ${JSON.stringify(CONTRACTS)} as const;

export type Web4ContractName = typeof WEB4_CONTRACTS[number];

${CONTRACTS.map((name) => {
    const abi = abis[name];
    if (!abi) return `export const ${name}ABI = [] as const;`;
    return `export const ${name}ABI = ${JSON.stringify(abi, null, 2)} as const;`;
  }).join("\n\n")}

export const WEB4_ADDRESSES: Record<string, Record<Web4ContractName, string>> = ${JSON.stringify(addresses, null, 2)};

export const WEB4_ABIS: Record<Web4ContractName, readonly any[]> = {
  ${CONTRACTS.map((name) => `${name}: ${name}ABI`).join(",\n  ")}
};
`.trim();

  fs.writeFileSync(path.join(OUTPUT_DIR, "index.ts"), indexContent);
  console.log("\nGenerated client/src/contracts/web4/index.ts");
}

main();
