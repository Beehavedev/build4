// dalleLogo — OpenAI DALL·E 3 logo generation for autonomous launches.
//
// The four.meme launch agent calls this ONLY on the LAUNCH branch
// (after conviction + cap + balance gates pass). On success we get a
// 1024×1024 PNG Buffer that fourMemeLaunch.ts uploads to four.meme's
// CDN as the token logo. On any failure we return null and the
// downstream launcher synthesizes a deterministic SVG fallback —
// the launch is never blocked by image gen.
//
// Cost: dall-e-3 standard 1024×1024 = ~$0.04/image. Launches are
// rare (≤ a few per agent per day) so the budget impact is low.
//
// Fail-closed on missing OPENAI_API_KEY: returns null, agent falls
// back to the SVG generator. We never crash the tick.

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations'
const FETCH_TIMEOUT_MS = 60_000  // DALL·E can take 20–40s

export interface LogoResult {
  buffer: Buffer
  mimeType: 'image/png'
  promptUsed: string
}

// Generate a square crypto-meme logo for the given token. Returns null
// on any failure (missing key, OpenAI 4xx/5xx, network blip, parse).
export async function generateTokenLogo(
  tokenName: string,
  tokenSymbol: string,
  description?: string,
  opts: { fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<LogoResult | null> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('[dalleLogo] OPENAI_API_KEY missing — falling back to SVG synth')
    return null
  }
  const fetchImpl = opts.fetchImpl ?? fetch

  const cleanName = (tokenName ?? '').trim().slice(0, 60) || 'Meme Token'
  const cleanSymbol = (tokenSymbol ?? '').trim().toUpperCase().slice(0, 10) || 'MEME'
  const cleanDesc = (description ?? '').trim().slice(0, 200)

  const prompt = buildLogoPrompt(cleanName, cleanSymbol, cleanDesc)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetchImpl(OPENAI_IMAGES_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'b64_json',
      }),
      signal: controller.signal,
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      console.warn(`[dalleLogo] OpenAI HTTP ${r.status}: ${txt.slice(0, 240)}`)
      return null
    }
    const j: any = await r.json().catch(() => null)
    const b64 = j?.data?.[0]?.b64_json
    if (typeof b64 !== 'string' || b64.length < 100) {
      console.warn('[dalleLogo] OpenAI response missing b64_json')
      return null
    }
    const buffer = Buffer.from(b64, 'base64')
    if (buffer.length < 1000) {
      console.warn(`[dalleLogo] suspiciously small image (${buffer.length}b) — discarding`)
      return null
    }
    return { buffer, mimeType: 'image/png', promptUsed: prompt }
  } catch (err) {
    console.warn('[dalleLogo] fetch failed:', (err as Error).message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Logo prompt is tuned for crypto memecoin aesthetics: bold, centered,
// high-contrast, no text/letters (DALL·E renders text poorly and the
// ticker is overlaid by four.meme's UI separately). Square framing so
// the 512×512 four.meme thumbnail crop doesn't clip anything important.
function buildLogoPrompt(name: string, symbol: string, description: string): string {
  const themeHint = description ? ` Theme: ${description}.` : ''
  return [
    `A bold, high-contrast crypto memecoin logo mascot for a token called "${name}" (ticker $${symbol}).`,
    themeHint.trim(),
    'Style: vibrant flat illustration with thick outlines, centered subject on a clean colorful gradient background, square 1:1 framing, suitable for a circular avatar crop.',
    'No text, no letters, no numbers, no watermarks. Subject should be a single clear iconic character or object.',
    'Energetic, fun, slightly absurd — meme-coin energy, not corporate.',
  ].filter(Boolean).join(' ')
}
