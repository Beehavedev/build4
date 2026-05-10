// ── four.meme Module 3 — token launch (creation) ─────────────────────
//
// Ports the previously-working four.meme token launcher into the BUILD4
// bot codebase. Same wire-protocol the marketing-site launcher used:
//
//   1. Sign in with the user's BSC wallet via four.meme's `private/user`
//      endpoints to obtain a `meme-web-access` token.
//   2. (Optional) upload a PNG logo to four.meme's CDN with that token.
//   3. Fetch the dynamic BNB raise config from `private/token/raise`.
//   4. POST to `private/token/create` to get an EIP-712-style
//      `(createArg, signature)` pair the on-chain factory will accept.
//   5. Send `createToken(createArg, signature)` to the V2 factory at
//      0x5c95...0762b with the user's optional initial-buy BNB as msg.value.
//   6. Parse the TokenCreate event from the receipt to surface the new
//      token address.
//
// Design constraints:
//   - Reuses `buildBscProvider` from the trading service so we share the
//     same hardened RPC fallback layer.
//   - Reuses `loadUserBscPrivateKey` so the launch wallet IS the user's
//     primary BSC wallet — no new wallet flow, no per-user PK exposure.
//   - Both feature flags are fail-closed: `FOUR_MEME_ENABLED=true`
//     remains the master switch (Module 1 already requires it), and a
//     new `FOUR_MEME_LAUNCH_ENABLED=true` independently gates launch.
//   - Logo is optional. If the caller doesn't supply one, we synthesise
//     an SVG -> PNG (sharp is already a runtime dep) so the launch
//     never blocks on a missing image.

import { ethers } from 'ethers'
import crypto from 'node:crypto'
import { buildBscProvider } from './bscProvider'
import { loadUserBscPrivateKey, isFourMemeEnabled } from './fourMemeTrading'
import { db } from '../db'

const FOUR_MEME_API = 'https://four.meme'
const FOUR_MEME_FACTORY_V2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b'
// Same TokenCreate topic the original launcher used; verified against
// historical four.meme launches on BscScan.
const TOKEN_CREATE_EVENT_TOPIC =
  '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20'

// Inline ABI — only the launch entrypoint. Trading uses
// src/abi/fourMeme/TokenManager2.lite.abi.json which doesn't include
// createToken.
const FOUR_MEME_LAUNCH_ABI = [
  'function createToken(bytes args, bytes signature) payable',
] as const

export function isFourMemeLaunchEnabled(): boolean {
  if (!isFourMemeEnabled()) return false
  return process.env.FOUR_MEME_LAUNCH_ENABLED === 'true'
}

function getProvider(): ethers.Provider {
  return buildBscProvider(process.env.BSC_RPC_URL)
}

// ── Validation ────────────────────────────────────────────────────────
// Cheap synchronous checks that mirror what the original launcher
// learned from operating in production. Surface them as a typed error
// so the bot/api layers can show a clean message instead of a 500.
export class LaunchValidationError extends Error {
  code = 'LAUNCH_INVALID' as const
  constructor(msg: string) {
    super(msg)
  }
}

export interface LaunchParams {
  tokenName: string
  tokenSymbol: string
  tokenDescription?: string
  // Optional caller-provided logo. If absent we synthesise one.
  imageBuffer?: Buffer
  // Optional pre-uploaded URL (e.g. caller already pushed to CDN).
  imageUrl?: string
  // Initial dev-wallet buy in BNB, e.g. "0.05". Default "0" => no buy.
  initialBuyBnb?: string
  // Optional social links forwarded into the four.meme listing.
  webUrl?: string
  twitterUrl?: string
  telegramUrl?: string
}

export interface LaunchResult {
  txHash: string
  tokenAddress: string | null
  launchUrl: string
  bnbSpentWei: string
  initialBuyBnb: string
  imageUrl: string | null
}

export function validateLaunchParams(p: LaunchParams): void {
  const name = (p.tokenName ?? '').trim()
  const sym = (p.tokenSymbol ?? '').trim()
  if (name.length < 2 || name.length > 100) {
    throw new LaunchValidationError('tokenName must be 2–100 characters')
  }
  if (sym.length < 1 || sym.length > 10) {
    throw new LaunchValidationError('tokenSymbol must be 1–10 characters')
  }
  if (!/^[a-zA-Z0-9$]+$/.test(sym)) {
    throw new LaunchValidationError('tokenSymbol must be alphanumeric (or $)')
  }
  if (p.initialBuyBnb != null && p.initialBuyBnb !== '') {
    let v: bigint
    try { v = ethers.parseEther(String(p.initialBuyBnb)) } catch {
      throw new LaunchValidationError('initialBuyBnb must be a decimal BNB amount')
    }
    if (v < 0n) throw new LaunchValidationError('initialBuyBnb must be >= 0')
    // Hard cap to prevent fat-finger launches; matches the cap the
    // original launcher used after the "Adjust default initial liquidity"
    // commit on the gitsafe-backup branch.
    const cap = ethers.parseEther('5')
    if (v > cap) throw new LaunchValidationError('initialBuyBnb cannot exceed 5 BNB')
  }
}

// ── Image helpers ────────────────────────────────────────────────────
function hashToColors(input: string): { bg1: string; bg2: string; fg: string; accent: string } {
  const hash = crypto.createHash('sha256').update(input).digest('hex')
  const hue1 = parseInt(hash.substring(0, 4), 16) % 360
  const hue2 = (hue1 + 40 + (parseInt(hash.substring(4, 6), 16) % 60)) % 360
  const sat = 65 + (parseInt(hash.substring(6, 8), 16) % 25)
  return {
    bg1: `hsl(${hue1}, ${sat}%, 45%)`,
    bg2: `hsl(${hue2}, ${sat}%, 30%)`,
    fg: '#ffffff',
    accent: `hsl(${hue1}, ${sat}%, 65%)`,
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function generateTokenSvg(tokenName: string, tokenSymbol: string): string {
  const colors = hashToColors(`${tokenName}-${tokenSymbol}`)
  const displaySymbol = escapeXml(tokenSymbol.substring(0, 4).replace(/[^a-zA-Z0-9]/g, ''))
  const fontSize = displaySymbol.length <= 2 ? 180 : displaySymbol.length === 3 ? 150 : 120
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
<radialGradient id="bg" cx="35%" cy="35%" r="65%">
<stop offset="0%" stop-color="${colors.bg1}"/>
<stop offset="100%" stop-color="${colors.bg2}"/>
</radialGradient>
</defs>
<circle cx="256" cy="256" r="250" fill="url(#bg)"/>
<circle cx="256" cy="256" r="220" fill="none" stroke="${colors.accent}" stroke-width="3" opacity="0.4"/>
<text x="256" y="${268 + (fontSize > 140 ? 10 : 0)}" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-weight="bold" font-size="${fontSize}" fill="${colors.fg}">${displaySymbol}</text>
</svg>`
}

async function generateTokenPng(tokenName: string, tokenSymbol: string): Promise<Buffer | null> {
  try {
    const sharpMod: any = await import('sharp')
    const sharp = sharpMod.default ?? sharpMod
    const svg = generateTokenSvg(tokenName, tokenSymbol)
    return await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer()
  } catch (err: any) {
    console.warn('[fourMemeLaunch] PNG fallback generation failed:', err?.message ?? err)
    return null
  }
}

// ── four.meme private API ────────────────────────────────────────────
async function fourMemeLogin(wallet: ethers.Wallet): Promise<string> {
  const nonceRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/user/nonce/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountAddress: wallet.address,
      verifyType: 'LOGIN',
      networkCode: 'BSC',
    }),
  })
  if (!nonceRes.ok) throw new Error(`four.meme nonce HTTP ${nonceRes.status}`)
  const nonceJson: any = await nonceRes.json()
  if (!nonceJson?.data) throw new Error(`four.meme nonce failed: ${nonceJson?.msg ?? 'no data'}`)

  // four.meme requires this exact phrasing — the on-chain admin is
  // strict about whitespace/case in the recovered EIP-191 signer.
  const message = `You are sign in Meme ${nonceJson.data}`
  const signature = await wallet.signMessage(message)

  const loginRes = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/user/login/dex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      region: 'WEB',
      langType: 'EN',
      loginIp: '',
      inviteCode: '',
      verifyInfo: {
        address: wallet.address,
        networkCode: 'BSC',
        signature,
        verifyType: 'LOGIN',
      },
      walletName: 'MetaMask',
    }),
  })
  if (!loginRes.ok) throw new Error(`four.meme login HTTP ${loginRes.status}`)
  const loginJson: any = await loginRes.json()
  if (!loginJson?.data) throw new Error(`four.meme login failed: ${loginJson?.msg ?? 'no data'}`)
  return loginJson.data as string
}

async function fourMemeUploadImage(pngBuffer: Buffer, accessToken: string): Promise<string | null> {
  const boundary = `----FormBoundary${crypto.randomBytes(8).toString('hex')}`
  const filename = `token-${Date.now()}.png`
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
  const footer = `\r\n--${boundary}--\r\n`
  const body = Buffer.concat([Buffer.from(header), pngBuffer, Buffer.from(footer)])

  const res = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'meme-web-access': accessToken,
    },
    body,
  })
  if (!res.ok) {
    console.warn(`[fourMemeLaunch] image upload HTTP ${res.status}`)
    return null
  }
  const text = await res.text()
  try {
    const json: any = JSON.parse(text)
    if (json?.code === 0 && json?.data) {
      const url =
        typeof json.data === 'string'
          ? json.data
          : json.data.url || json.data.imgUrl || json.data.imageUrl
      return url ?? null
    }
  } catch {
    /* not JSON */
  }
  return null
}

interface RaiseConfig {
  symbol: string
  nativeSymbol: string
  symbolAddress: string
  deployCost: string
  buyFee: string
  sellFee: string
  minTradeFee: string
  b0Amount: string
  totalBAmount: string
  totalAmount: string
  logoUrl: string
  status: string
  saleRate?: string
}

const RAISE_CONFIG_DEFAULTS: RaiseConfig = {
  symbol: 'BNB',
  nativeSymbol: 'BNB',
  symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  deployCost: '0',
  buyFee: '0.01',
  sellFee: '0.01',
  minTradeFee: '0',
  b0Amount: '8',
  totalBAmount: '18',
  totalAmount: '1000000000',
  logoUrl:
    'https://static.four.meme/market/fc6c4c92-63a3-4034-bc27-355ea380a6795959172881106751506.png',
  status: 'PUBLISH',
}

async function fourMemeFetchRaiseConfig(accessToken: string): Promise<RaiseConfig> {
  try {
    const res = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/raise`, {
      headers: { Accept: 'application/json', 'meme-web-access': accessToken },
    })
    if (!res.ok) return RAISE_CONFIG_DEFAULTS
    const json: any = await res.json()
    if (json?.code !== 0 || !json?.data) return RAISE_CONFIG_DEFAULTS
    const configs: any[] = Array.isArray(json.data) ? json.data : [json.data]
    const bnb = configs.find(
      (c: any) => c?.symbol === 'BNB' && c?.status === 'PUBLISH' && c?.platform === 'MEME',
    )
    if (!bnb) return RAISE_CONFIG_DEFAULTS
    return {
      symbol: bnb.symbol ?? 'BNB',
      nativeSymbol: bnb.nativeSymbol ?? 'BNB',
      symbolAddress: bnb.symbolAddress ?? RAISE_CONFIG_DEFAULTS.symbolAddress,
      deployCost: bnb.deployCost ?? '0',
      buyFee: bnb.buyFee ?? '0.01',
      sellFee: bnb.sellFee ?? '0.01',
      minTradeFee: bnb.minTradeFee ?? '0',
      b0Amount: bnb.b0Amount ?? RAISE_CONFIG_DEFAULTS.b0Amount,
      totalBAmount: bnb.totalBAmount ?? RAISE_CONFIG_DEFAULTS.totalBAmount,
      totalAmount: bnb.totalAmount ?? RAISE_CONFIG_DEFAULTS.totalAmount,
      logoUrl: bnb.logoUrl ?? RAISE_CONFIG_DEFAULTS.logoUrl,
      status: bnb.status ?? 'PUBLISH',
      saleRate: bnb.saleRate,
    }
  } catch (err: any) {
    console.warn('[fourMemeLaunch] raise config fetch failed:', err?.message ?? err)
    return RAISE_CONFIG_DEFAULTS
  }
}

interface CreateTokenData {
  createArg: string
  signature: string
  value: bigint
}

async function fourMemeCreateTokenData(
  params: LaunchParams,
  accessToken: string,
  imageUrlForBody: string | null,
): Promise<CreateTokenData> {
  const cfg = await fourMemeFetchRaiseConfig(accessToken)
  const totalBAmount = parseFloat(cfg.totalBAmount)
  const b0Amount = parseFloat(cfg.b0Amount)
  const raisedAmount = totalBAmount + b0Amount
  const saleRate = cfg.saleRate ? parseFloat(cfg.saleRate) : 0.8

  const preSaleEth = params.initialBuyBnb && params.initialBuyBnb !== '' ? params.initialBuyBnb : '0'

  const body: Record<string, any> = {
    name: params.tokenName,
    shortName: params.tokenSymbol,
    desc: params.tokenDescription ?? '',
    totalSupply: 1_000_000_000,
    raisedAmount,
    saleRate,
    reserveRate: 0,
    imgUrl: imageUrlForBody ?? cfg.logoUrl,
    raisedToken: cfg,
    launchTime: Date.now(),
    funGroup: false,
    preSale: preSaleEth,
    clickFun: false,
    symbol: 'BNB',
    label: 'Meme',
  }
  if (params.webUrl) body.webUrl = params.webUrl
  if (params.twitterUrl) body.twitterUrl = params.twitterUrl
  if (params.telegramUrl) body.telegramUrl = params.telegramUrl

  const res = await fetch(`${FOUR_MEME_API}/meme-api/v1/private/token/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'meme-web-access': accessToken,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`four.meme create HTTP ${res.status}`)
  const json: any = await res.json()
  if (
    (json?.code !== 0 && json?.msg !== 'success') ||
    !json?.data?.createArg ||
    !json?.data?.signature
  ) {
    throw new Error(`four.meme create failed: ${json?.msg ?? JSON.stringify(json).slice(0, 200)}`)
  }
  const preSaleWei = ethers.parseEther(preSaleEth)
  const txValue = json.data.value ? BigInt(json.data.value) : preSaleWei
  return { createArg: json.data.createArg, signature: json.data.signature, value: txValue }
}

// ── Receipt parsing ──────────────────────────────────────────────────
export function parseTokenAddressFromReceipt(receipt: ethers.TransactionReceipt): string | null {
  // Preferred: structured TokenCreate event.
  const tokenCreateLog = receipt.logs.find(
    (l) => l.topics?.[0] === TOKEN_CREATE_EVENT_TOPIC && (l as any).data,
  )
  if (tokenCreateLog) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address', 'address', 'uint256', 'string', 'string', 'uint256', 'uint256', 'uint256'],
        tokenCreateLog.data,
      )
      const addr = decoded[1] as string
      if (ethers.isAddress(addr) && addr !== ethers.ZeroAddress) return ethers.getAddress(addr)
    } catch {
      /* fall through */
    }
  }
  // Fallback: scan event data for a plausible address.
  for (const eventLog of receipt.logs) {
    if (eventLog.data && eventLog.data.length >= 66) {
      const possible = '0x' + eventLog.data.slice(26, 66)
      if (ethers.isAddress(possible) && possible !== ethers.ZeroAddress) {
        return ethers.getAddress(possible)
      }
    }
  }
  return null
}

// Hard ceiling on any *extra* BNB the four.meme upstream API can ask
// for above the user's declared initial buy. The marketing-site
// launcher historically saw `value` come back equal to the preSale
// amount plus, at most, a tiny deploy cost (currently 0). We allow a
// generous 0.05 BNB headroom and refuse the launch if the upstream
// asks for more — this protects against a malicious or compromised
// upstream draining a wallet that just happens to have a balance.
const MAX_UPSTREAM_VALUE_HEADROOM_WEI = ethers.parseEther('0.05')

// Best-effort persistence helpers. We can't add Module 3 to the
// prisma schema (prisma/ is locked per project preferences), so we
// write to the runtime-managed token_launches table via raw SQL.
// Failures here are tolerated — they must never abort an in-flight
// launch — but logged for ops visibility.
async function recordLaunchPending(row: {
  id: string
  userId: string | null
  agentId: string | null
  walletAddress: string
  tokenName: string
  tokenSymbol: string
  tokenDescription: string | null
  imageUrl: string | null
  initialBuyBnb: string
}): Promise<void> {
  try {
    // agent_id is included in the pending insert so Module 4's
    // per-agent cap query (src/agents/fourMemeLaunchAgent.ts) sees the
    // attempt the moment it's persisted — no back-tagging race. Column
    // is added by an idempotent ALTER in src/ensureTables.ts; on a
    // legacy DB that hasn't run ensureTables yet the column would be
    // missing and this INSERT would throw — which is fine because we
    // catch + log and the pending row simply isn't recorded (manual
    // launches still proceed; autonomous agents fail-closed because
    // their cap query throws separately).
    await db.$executeRawUnsafe(
      `INSERT INTO "token_launches"
        ("id","user_id","agent_id","creator_wallet","platform","chain_id","token_name","token_symbol","token_description","image_url","initial_liquidity_bnb","status","created_at")
       VALUES ($1,$2,$3,$4,'four_meme',56,$5,$6,$7,$8,$9,'pending', now())`,
      row.id,
      row.userId,
      row.agentId,
      row.walletAddress,
      row.tokenName,
      row.tokenSymbol,
      row.tokenDescription,
      row.imageUrl,
      row.initialBuyBnb,
    )
  } catch (err: any) {
    console.warn('[fourMemeLaunch] pending insert failed:', err?.message ?? err)
  }
}

async function recordLaunchResult(
  id: string,
  patch: {
    status: 'launched' | 'failed'
    txHash?: string | null
    tokenAddress?: string | null
    launchUrl?: string | null
    imageUrl?: string | null
    errorMessage?: string | null
  },
): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `UPDATE "token_launches" SET
         "status" = $2,
         "tx_hash" = COALESCE($3, "tx_hash"),
         "token_address" = COALESCE($4, "token_address"),
         "launch_url" = COALESCE($5, "launch_url"),
         "image_url" = COALESCE($6, "image_url"),
         "error_message" = COALESCE($7, "error_message")
       WHERE "id" = $1`,
      id,
      patch.status,
      patch.txHash ?? null,
      patch.tokenAddress ?? null,
      patch.launchUrl ?? null,
      patch.imageUrl ?? null,
      patch.errorMessage ? patch.errorMessage.substring(0, 500) : null,
    )
  } catch (err: any) {
    console.warn('[fourMemeLaunch] result update failed:', err?.message ?? err)
  }
}

// ── Public entrypoint ────────────────────────────────────────────────
// `existingLaunchId` (Task #64): when set, we skip recordLaunchPending
// and reuse the caller-supplied id for the success/failure UPDATE. The
// human-in-the-loop approval flow uses this so the original
// 'pending_user_approval' row written when the agent proposed becomes
// the same row that ends up 'launched'/'failed' — no duplicate audit
// trail per launch.
export async function launchFourMemeToken(
  privateKey: string,
  params: LaunchParams,
  persistContext?: { userId: string | null; agentId?: string | null; existingLaunchId?: string | null },
): Promise<LaunchResult> {
  if (!isFourMemeLaunchEnabled()) {
    const err = new Error('four.meme launch is disabled')
    ;(err as any).code = 'FOUR_MEME_LAUNCH_DISABLED'
    throw err
  }
  validateLaunchParams(params)

  const provider = getProvider()
  const wallet = new ethers.Wallet(privateKey, provider)

  const preSaleEth = params.initialBuyBnb && params.initialBuyBnb !== '' ? params.initialBuyBnb : '0'
  const preSaleWei = ethers.parseEther(preSaleEth)
  // 0.005 BNB headroom for gas — matches the original launcher's
  // pre-flight check.
  const gasReserve = ethers.parseEther('0.005')
  const balance = await provider.getBalance(wallet.address)
  if (balance < preSaleWei + gasReserve) {
    const err = new Error(
      `Insufficient BNB: have ${ethers.formatEther(balance)}, need ≥ ${ethers.formatEther(preSaleWei + gasReserve)} (initial buy + gas)`,
    )
    ;(err as any).code = 'INSUFFICIENT_BNB'
    throw err
  }

  // Persist a pending row so a launch attempt is auditable even if
  // the process crashes mid-flow. ID is independent of the on-chain
  // hash so we have a stable handle from the moment we commit to try.
  // When the caller supplied an existingLaunchId (HITL approval flow,
  // Task #64), we reuse that id and flip the existing
  // 'pending_user_approval' row to 'pending' instead of inserting a
  // duplicate audit row.
  let launchId: string
  if (persistContext?.existingLaunchId) {
    launchId = persistContext.existingLaunchId
    try {
      await db.$executeRawUnsafe(
        `UPDATE "token_launches" SET "status" = 'pending' WHERE "id" = $1`,
        launchId,
      )
    } catch (err: any) {
      console.warn('[fourMemeLaunch] approval status flip failed:', err?.message ?? err)
    }
  } else {
    launchId = `flm_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
    await recordLaunchPending({
      id: launchId,
      userId: persistContext?.userId ?? null,
      agentId: persistContext?.agentId ?? null,
      walletAddress: wallet.address,
      tokenName: params.tokenName,
      tokenSymbol: params.tokenSymbol,
      tokenDescription: params.tokenDescription ?? null,
      imageUrl: params.imageUrl ?? null,
      initialBuyBnb: preSaleEth,
    })
  }

  try {
    // 1) Login
    const accessToken = await fourMemeLogin(wallet)

    // 2) Image
    let imageUrl = params.imageUrl ?? null
    if (!imageUrl) {
      const png = params.imageBuffer ?? (await generateTokenPng(params.tokenName, params.tokenSymbol))
      if (png) {
        imageUrl = await fourMemeUploadImage(png, accessToken)
      }
    }

    // 3) Create token data
    const txData = await fourMemeCreateTokenData(params, accessToken, imageUrl)

    // 3a) Trust-boundary check: cap the value the upstream API can
    // make us send. Fail-closed if four.meme returns more than the
    // user asked for + a tightly-bounded deploy headroom.
    const maxAllowedValue = preSaleWei + MAX_UPSTREAM_VALUE_HEADROOM_WEI
    if (txData.value > maxAllowedValue) {
      const err = new Error(
        `four.meme upstream requested ${ethers.formatEther(txData.value)} BNB, ` +
          `which exceeds the allowed cap of ${ethers.formatEther(maxAllowedValue)} BNB ` +
          `(initial buy ${preSaleEth} + 0.05 headroom). Refusing to send.`,
      )
      ;(err as any).code = 'UPSTREAM_VALUE_EXCEEDS_CAP'
      throw err
    }

    // 4) On-chain TX
    const contract = new ethers.Contract(FOUR_MEME_FACTORY_V2, FOUR_MEME_LAUNCH_ABI, wallet)
    const tx = await contract.createToken(txData.createArg, txData.signature, {
      value: txData.value,
      // Generous limit — token creation does a CREATE2 + initial-buy hop.
      // The "Increase gas limit" commit on gitsafe-backup pushed it from
      // 2M to 3M; we keep that headroom.
      gasLimit: 3_000_000,
    })
    const receipt = (await Promise.race([
      tx.wait(),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('TX timeout (180s)')), 180_000)),
    ])) as ethers.TransactionReceipt | null
    if (!receipt || receipt.status !== 1) {
      const err = new Error(
        `four.meme launch reverted on-chain. TX ${tx.hash} — most likely the token name or symbol is already taken.`,
      )
      ;(err as any).code = 'LAUNCH_REVERTED'
      ;(err as any).txHash = tx.hash
      throw err
    }

    const tokenAddress = parseTokenAddressFromReceipt(receipt)
    const launchUrl = tokenAddress
      ? `https://four.meme/token/${tokenAddress}`
      : `https://bscscan.com/tx/${receipt.hash}`

    await recordLaunchResult(launchId, {
      status: 'launched',
      txHash: receipt.hash,
      tokenAddress,
      launchUrl,
      imageUrl,
    })

    return {
      txHash: receipt.hash,
      tokenAddress,
      launchUrl,
      bnbSpentWei: txData.value.toString(),
      initialBuyBnb: preSaleEth,
      imageUrl,
    }
  } catch (err: any) {
    await recordLaunchResult(launchId, {
      status: 'failed',
      txHash: err?.txHash ?? null,
      errorMessage: err?.message ?? String(err),
    })
    throw err
  }
}

// ── User-scoped helper: load PK + launch in one call ─────────────────
export async function launchFourMemeTokenForUser(
  userId: string,
  params: LaunchParams,
): Promise<LaunchResult & { walletAddress: string }> {
  const { address, privateKey } = await loadUserBscPrivateKey(userId)
  const result = await launchFourMemeToken(privateKey, params, { userId })
  return { ...result, walletAddress: address }
}

// ── Stale-launch sweeper ─────────────────────────────────────────────
// Pending rows that never advanced past `recordLaunchPending` (e.g. the
// process crashed mid-flow before recordLaunchResult ran) sit in the
// table forever and confuse users. Surface them as `stale` after a
// generous 10-minute window — well past the 180s on-chain timeout plus
// any reasonable upstream four.meme latency. Scoped per-user so we
// don't accidentally race with another in-flight launch belonging to a
// different user. Idempotent and silent on table-missing.
export async function markUserPendingStale(userId: string): Promise<number> {
  try {
    const n = await db.$executeRawUnsafe(
      `UPDATE "token_launches"
          SET "status" = 'stale',
              "error_message" = COALESCE("error_message", 'pending timeout — process likely crashed before completion')
        WHERE "user_id" = $1
          AND "status" = 'pending'
          AND "created_at" < now() - interval '10 minutes'`,
      userId,
    )
    return Number(n) || 0
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (!/relation .*token_launches.* does not exist/i.test(msg)) {
      console.warn('[fourMemeLaunch] markUserPendingStale failed:', msg)
    }
    return 0
  }
}

export class LaunchRetryError extends Error {
  code: string
  constructor(msg: string, code = 'LAUNCH_RETRY_INVALID') {
    super(msg)
    this.code = code
  }
}

// ── Task #64: HITL approval helpers ──────────────────────────────────
// A "frozen proposal" is the JSON the agent stored in
// token_launches.metadata when the row was first written with status
// 'pending_user_approval'. On approve we replay it verbatim so the
// launch the user reviewed is exactly the launch that fires.
export interface FrozenLaunchProposal {
  tokenName: string
  tokenSymbol: string
  tokenDescription: string
  initialBuyBnb: string
  conviction?: number
  reasoning?: string
}

export class LaunchApprovalError extends Error {
  code: string
  constructor(code: string, msg: string) {
    super(msg)
    this.code = code
  }
}

// Re-runs a previously-failed (or auto-marked stale) launch using the
// caller's own original tokenName / tokenSymbol / tokenDescription /
// initialBuyBnb / imageUrl row. The original row is left as-is for
// audit; the retry creates a fresh row. We refuse to retry rows that
// are still 'pending' (active) or already 'launched'.
export async function retryLaunchForUser(
  userId: string,
  launchId: string,
): Promise<LaunchResult & { walletAddress: string; previousLaunchId: string }> {
  if (!isFourMemeLaunchEnabled()) {
    throw new LaunchRetryError('four.meme launch is disabled', 'FOUR_MEME_LAUNCH_DISABLED')
  }
  if (!launchId || typeof launchId !== 'string') {
    throw new LaunchRetryError('launchId required')
  }
  // Opportunistically convert long-pending rows to stale so a stuck
  // pending row becomes retryable on the same call.
  await markUserPendingStale(userId)

  let rows: Array<{
    id: string
    user_id: string | null
    status: string
    token_name: string
    token_symbol: string
    token_description: string | null
    image_url: string | null
    initial_liquidity_bnb: string | null
  }> = []
  try {
    rows = await db.$queryRaw<typeof rows>`
      SELECT "id","user_id","status","token_name","token_symbol",
             "token_description","image_url","initial_liquidity_bnb"
        FROM "token_launches"
       WHERE "id" = ${launchId}
       LIMIT 1
    `
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (/relation .*token_launches.* does not exist/i.test(msg)) {
      throw new LaunchRetryError('launch not found', 'NOT_FOUND')
    }
    throw err
  }
  const row = rows[0]
  if (!row) throw new LaunchRetryError('launch not found', 'NOT_FOUND')
  if (row.user_id !== userId) {
    // Don't leak existence vs. ownership.
    throw new LaunchRetryError('launch not found', 'NOT_FOUND')
  }
  if (row.status !== 'failed' && row.status !== 'stale') {
    throw new LaunchRetryError(
      `cannot retry a launch in status "${row.status}" — only failed or stale rows are retryable`,
      'NOT_RETRYABLE',
    )
  }

  const result = await launchFourMemeTokenForUser(userId, {
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    tokenDescription: row.token_description ?? undefined,
    initialBuyBnb: row.initial_liquidity_bnb ?? '0',
    imageUrl: row.image_url ?? undefined,
  })
  return { ...result, previousLaunchId: row.id }
}

interface PendingApprovalRow {
  id: string
  user_id: string | null
  agent_id: string | null
  status: string
  metadata: string | null
  token_name: string
  token_symbol: string
}

async function loadPendingApprovalRow(launchId: string): Promise<PendingApprovalRow | null> {
  const rows = await db.$queryRawUnsafe<PendingApprovalRow[]>(
    `SELECT "id","user_id","agent_id","status","metadata","token_name","token_symbol"
       FROM "token_launches"
      WHERE "id" = $1
      LIMIT 1`,
    launchId,
  )
  return rows[0] ?? null
}

function parseFrozenProposal(metadata: string | null): FrozenLaunchProposal | null {
  if (!metadata) return null
  try {
    const obj = JSON.parse(metadata)
    if (!obj || typeof obj !== 'object') return null
    if (typeof obj.tokenName !== 'string' || typeof obj.tokenSymbol !== 'string') return null
    return {
      tokenName: String(obj.tokenName),
      tokenSymbol: String(obj.tokenSymbol),
      tokenDescription: typeof obj.tokenDescription === 'string' ? obj.tokenDescription : '',
      initialBuyBnb: typeof obj.initialBuyBnb === 'string' ? obj.initialBuyBnb : '0',
      conviction: typeof obj.conviction === 'number' ? obj.conviction : undefined,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
    }
  } catch {
    return null
  }
}

// Reject a pending approval. Idempotent — if the row is already in
// any non-pending_user_approval state we throw a typed error so the
// caller can show a clean "already handled" message instead of a 500.
export async function rejectPendingLaunch(opts: {
  launchId: string
  userId: string
}): Promise<void> {
  const row = await loadPendingApprovalRow(opts.launchId)
  if (!row) throw new LaunchApprovalError('NOT_FOUND', 'Launch proposal not found.')
  if (row.user_id !== opts.userId) {
    throw new LaunchApprovalError('FORBIDDEN', 'Not your launch proposal.')
  }
  if (row.status !== 'pending_user_approval') {
    throw new LaunchApprovalError('ALREADY_HANDLED', `Launch already ${row.status}.`)
  }
  await db.$executeRawUnsafe(
    `UPDATE "token_launches" SET "status" = 'rejected' WHERE "id" = $1`,
    opts.launchId,
  )
}

// Execute an approved launch. Replays the frozen proposal that was
// captured when the agent first proposed the launch. The same
// token_launches row is reused (existingLaunchId) so the audit trail
// is a single row that walks pending_user_approval → pending →
// launched/failed.
export async function executeApprovedLaunch(opts: {
  launchId: string
  userId: string
}): Promise<LaunchResult & { walletAddress: string }> {
  const row = await loadPendingApprovalRow(opts.launchId)
  if (!row) throw new LaunchApprovalError('NOT_FOUND', 'Launch proposal not found.')
  if (row.user_id !== opts.userId) {
    throw new LaunchApprovalError('FORBIDDEN', 'Not your launch proposal.')
  }
  if (row.status !== 'pending_user_approval') {
    throw new LaunchApprovalError('ALREADY_HANDLED', `Launch already ${row.status}.`)
  }
  const frozen = parseFrozenProposal(row.metadata)
  if (!frozen) {
    throw new LaunchApprovalError('INVALID_PROPOSAL', 'Stored proposal is unreadable.')
  }
  const { address, privateKey } = await loadUserBscPrivateKey(opts.userId)
  const result = await launchFourMemeToken(
    privateKey,
    {
      tokenName: frozen.tokenName,
      tokenSymbol: frozen.tokenSymbol,
      tokenDescription: frozen.tokenDescription,
      initialBuyBnb: frozen.initialBuyBnb,
    },
    { userId: opts.userId, agentId: row.agent_id, existingLaunchId: row.id },
  )
  return { ...result, walletAddress: address }
}
