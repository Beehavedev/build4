# BUILD4 Brand Guidelines

## Color palette

Pulled from the live BUILD4 dapp (`web4/client/src/index.css`). All colors are HSL; hex equivalents below.

### Primary

| Token | HSL | Hex | Use |
|---|---|---|---|
| **Brand Green** | `152 60% 42%` | `#2BAB6A` | CTAs, agent activity, gains, primary buttons, brand accents |
| **Background** | `160 10% 4%` | `#090C0B` | Page background — near-black with green undertone |
| **Foreground** | `160 5% 82%` | `#CFD3D1` | Primary text on dark background |

### Surfaces

| Token | HSL | Hex | Use |
|---|---|---|---|
| **Card** | `160 8% 7%` | `#10130F` | Card / panel background |
| **Card Border** | `160 8% 12%` | `#1B201C` | Card outline |
| **Muted** | `160 6% 10%` | `#171A18` | Secondary surface |
| **Muted Foreground** | `160 5% 45%` | `#6E7572` | Secondary / placeholder text |

### Semantic

| Token | HSL | Hex | Use |
|---|---|---|---|
| **Destructive** | `0 62% 45%` | `#B92F2F` | Losses, errors, sells |
| **Success (= Brand Green)** | `152 60% 42%` | `#2BAB6A` | Wins, fills, confirmations |
| **Online** | `34 197 94 (rgb)` | `#22C55E` | Live agent indicator |
| **Away** | `245 158 11 (rgb)` | `#F59E0B` | Pending, warning |

### Co-branding rule

The brand green `#2BAB6A` is the only "active" color in the system. When co-branding, keep BUILD4's green as the dominant accent and let the partner's color sit alongside it (not behind it). Background should always be the near-black `#090C0B` or pure black — never a colored background.

## Typography

The dapp uses the **system font stack** by default — clean, readable, no licensed font dependency. For polished campaign assets we recommend:

- **Headlines:** Inter, Geist, or system sans (700 weight)
- **Body:** Inter, Geist, or system sans (400/500 weight)
- **Numerals (prices, P&L):** Tabular figures via `font-variant-numeric: tabular-nums` so digits don't jitter

## Logo usage

Files in `logos/`:
- `build4-logo.png` — primary mark
- `build4-favicon.png` — small / favicon use
- `build4-og.png` — Open Graph card (social previews)

### Do

- Place the logo on the brand background (`#090C0B`) or pure black
- Maintain clear space around the logo of at least the height of the "4"
- Keep the green channel intact — the green IS the brand

### Don't

- Don't place the logo on a busy photo background
- Don't recolor the logo
- Don't stretch, shear, or rotate
- Don't add drop shadows, glows, or effects
- Don't render below 32px tall (use the favicon instead)

## Voice & tone

- **Concise.** Short sentences. No marketing fluff.
- **Show, don't claim.** "Dominic took a 3% position on BNB long" beats "powerful AI trading".
- **Receipts.** When making performance claims, link the on-chain trade or screenshot the agent's reasoning.
- **Lowercase is fine for casual contexts** (Twitter, Telegram). Title Case for formal partnerships and PR.
