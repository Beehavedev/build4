// One-off: print the campaign agent's wallet address + decrypted PK so it can
// be reused as HOUSE_AGENT_PRIVATE_KEY for the PancakeSwap competition.
//
// Run locally (NEVER in a deploy log):
//   FT_CAMPAIGN_AGENT_ID=<agentId> npx tsx scripts/exportCampaignHousePK.ts
//
// Requires DATABASE_URL + WALLET_ENCRYPTION_KEY (and/or MASTER_ENCRYPTION_KEY)
// to be the SAME values production uses, otherwise decrypt fails.

import { db } from '../src/db';
import { decryptPrivateKey } from '../src/services/wallet';

async function main() {
  const agentId = process.env.FT_CAMPAIGN_AGENT_ID;
  if (!agentId) {
    console.error('FT_CAMPAIGN_AGENT_ID env var not set. Aborting.');
    process.exit(1);
  }

  const rows = await db.$queryRawUnsafe<
    Array<{ id: string; userId: string; walletId: string | null; name: string }>
  >(`SELECT id, "userId", "walletId", name FROM "Agent" WHERE id = $1 LIMIT 1`, agentId);

  const agent = rows[0];
  if (!agent) {
    console.error(`Agent ${agentId} not found.`);
    process.exit(1);
  }
  if (!agent.walletId) {
    console.error(`Agent ${agentId} has no walletId bound. Run /bindcampaignwallet first.`);
    process.exit(1);
  }

  const w = await db.wallet.findUnique({ where: { id: agent.walletId } });
  if (!w || !w.encryptedPK) {
    console.error(`Wallet ${agent.walletId} not found or missing encryptedPK.`);
    process.exit(1);
  }

  let pk: string;
  try {
    pk = decryptPrivateKey(w.encryptedPK, w.userId);
  } catch (e: any) {
    console.error('Decrypt failed:', e?.message);
    process.exit(1);
  }
  if (!pk.startsWith('0x')) pk = '0x' + pk;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Agent name :', agent.name);
  console.log(' Agent id   :', agent.id);
  console.log(' Address    :', w.address);
  console.log(' Label      :', (w as any).label ?? '(none)');
  console.log('───────────────────────────────────────────────────────────');
  console.log(' PRIVATE KEY (paste into Replit Publish Secrets as');
  console.log(' HOUSE_AGENT_PRIVATE_KEY, then DELETE this terminal output):');
  console.log('');
  console.log(' ', pk);
  console.log('═══════════════════════════════════════════════════════════');

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
