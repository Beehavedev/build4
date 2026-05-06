"""Generate the BUILD4 Media Kit PDF.

Pure-python (reportlab) renderer that produces a polished, on-brand PDF
suitable for sending directly to partners and press.

Brand: green #2BAB6A on near-black #090C0B (pulled from web4/client/src/index.css).
"""
from __future__ import annotations

import os
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT_PATH = "build4-media-kit.pdf"
LOGO_PATH = "media-kit/logos/build4-logo.png"

GREEN = HexColor("#2BAB6A")
BLACK = HexColor("#090C0B")
CARD = HexColor("#10130F")
BORDER = HexColor("#1B201C")
TEXT = HexColor("#CFD3D1")
MUTED = HexColor("#6E7572")
DESTRUCTIVE = HexColor("#B92F2F")
WHITE = HexColor("#FFFFFF")


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle(
            "h1", parent=base["Heading1"], fontName="Helvetica-Bold",
            fontSize=36, leading=42, textColor=GREEN, spaceBefore=0, spaceAfter=12,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=20, leading=26, textColor=GREEN, spaceBefore=18, spaceAfter=8,
        ),
        "h3": ParagraphStyle(
            "h3", parent=base["Heading3"], fontName="Helvetica-Bold",
            fontSize=13, leading=17, textColor=TEXT, spaceBefore=12, spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "body", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10.5, leading=15.5, textColor=TEXT, spaceAfter=8,
        ),
        "muted": ParagraphStyle(
            "muted", parent=base["BodyText"], fontName="Helvetica",
            fontSize=9, leading=13, textColor=MUTED, spaceAfter=6,
        ),
        "tagline": ParagraphStyle(
            "tagline", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=14, leading=20, textColor=TEXT, spaceAfter=18,
        ),
        "quote": ParagraphStyle(
            "quote", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=11.5, leading=18, textColor=TEXT, leftIndent=14,
            spaceBefore=4, spaceAfter=10, borderPadding=0,
        ),
        "bullet": ParagraphStyle(
            "bullet", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10.5, leading=15.5, textColor=TEXT, leftIndent=14,
            bulletIndent=2, spaceAfter=4,
        ),
        "footer": ParagraphStyle(
            "footer", parent=base["BodyText"], fontName="Helvetica",
            fontSize=8.5, leading=11, textColor=MUTED, alignment=1,
        ),
    }


def page_decoration(canvas, doc):
    """Solid dark background + green accent bar + page number."""
    w, h = LETTER
    canvas.saveState()
    # Background
    canvas.setFillColor(BLACK)
    canvas.rect(0, 0, w, h, fill=1, stroke=0)
    # Top green accent bar
    canvas.setFillColor(GREEN)
    canvas.rect(0, h - 6, w, 6, fill=1, stroke=0)
    # Footer
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.6 * inch, 0.4 * inch, "BUILD4 — Media Kit")
    canvas.drawRightString(w - 0.6 * inch, 0.4 * inch, f"{doc.page}")
    canvas.restoreState()


def kv_table(rows: list[tuple[str, str]], col_widths=(1.6 * inch, 4.4 * inch)) -> Table:
    data = [[Paragraph(f"<font color='#6E7572'>{k}</font>", make_styles()["body"]),
             Paragraph(f"<font color='#CFD3D1'>{v}</font>", make_styles()["body"])]
            for k, v in rows]
    t = Table(data, colWidths=col_widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CARD),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def color_swatch_row(name: str, hex_code: str, usage: str) -> Table:
    swatch = Table([[""]], colWidths=[0.55 * inch], rowHeights=[0.4 * inch])
    swatch.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), HexColor(hex_code)),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
    ]))
    s = make_styles()
    label = Paragraph(
        f"<b><font color='#CFD3D1' size='11'>{name}</font></b><br/>"
        f"<font color='#2BAB6A' face='Courier' size='9.5'>{hex_code}</font><br/>"
        f"<font color='#6E7572' size='9'>{usage}</font>",
        s["body"],
    )
    t = Table([[swatch, label]], colWidths=[0.7 * inch, 5.3 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def venue_table() -> Table:
    s = make_styles()
    head_style = ParagraphStyle("th", parent=s["body"], textColor=GREEN, fontName="Helvetica-Bold")
    rows = [
        [Paragraph("Venue", head_style), Paragraph("Type", head_style),
         Paragraph("Chain", head_style), Paragraph("Status", head_style)],
        [Paragraph("Aster DEX", s["body"]), Paragraph("Perpetual futures", s["body"]),
         Paragraph("BSC", s["body"]), Paragraph("<font color='#2BAB6A'>● Live</font>", s["body"])],
        [Paragraph("Hyperliquid", s["body"]), Paragraph("Perpetual futures", s["body"]),
         Paragraph("HL L1", s["body"]), Paragraph("<font color='#2BAB6A'>● Live</font>", s["body"])],
        [Paragraph("42.space", s["body"]), Paragraph("Prediction markets", s["body"]),
         Paragraph("BSC", s["body"]), Paragraph("<font color='#2BAB6A'>● Live</font>", s["body"])],
        [Paragraph("Polymarket", s["body"]), Paragraph("Prediction markets (gasless)", s["body"]),
         Paragraph("Polygon", s["body"]), Paragraph("<font color='#2BAB6A'>● Live</font>", s["body"])],
    ]
    t = Table(rows, colWidths=[1.4 * inch, 2.4 * inch, 1.0 * inch, 1.2 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#0E1411")),
        ("BACKGROUND", (0, 1), (-1, -1), CARD),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("LINEBELOW", (0, 0), (-1, 0), 1, GREEN),
        ("INNERGRID", (0, 1), (-1, -1), 0.25, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def build():
    s = make_styles()
    doc = SimpleDocTemplate(
        OUT_PATH, pagesize=LETTER,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.85 * inch, bottomMargin=0.6 * inch,
        title="BUILD4 Media Kit", author="BUILD4",
    )
    story = []

    # ---------- COVER ----------
    if os.path.exists(LOGO_PATH):
        try:
            logo = Image(LOGO_PATH, width=1.6 * inch, height=1.6 * inch, kind="proportional")
            story.append(Spacer(1, 0.6 * inch))
            story.append(logo)
        except Exception:
            story.append(Spacer(1, 0.6 * inch))
    else:
        story.append(Spacer(1, 0.6 * inch))

    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph("BUILD4", s["h1"]))
    story.append(Paragraph("Media Kit", ParagraphStyle(
        "subtitle", parent=s["h2"], fontSize=18, textColor=TEXT, spaceAfter=8,
    )))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph(
        "AI agents that trade crypto perps and prediction markets autonomously, "
        "across four venues, from your Telegram.", s["tagline"]))
    story.append(Spacer(1, 0.5 * inch))
    story.append(Paragraph("Inside", s["h3"]))
    for item in [
        "About BUILD4",
        "Supported venues",
        "Boilerplate copy (1-line → 2-paragraph)",
        "Founder quote",
        "Brand: colors, typography, logo rules",
        "Fact sheet & contact",
    ]:
        story.append(Paragraph(f"•  {item}", s["bullet"]))

    story.append(PageBreak())

    # ---------- ABOUT ----------
    story.append(Paragraph("About BUILD4", s["h2"]))
    story.append(Paragraph(
        "BUILD4 is an AI-powered trading platform that lets users delegate execution to autonomous "
        "agents across crypto perpetual futures and prediction markets — Aster DEX, Hyperliquid, "
        "42.space, and Polymarket — all from a single Telegram chat or web dApp.", s["body"]))
    story.append(Paragraph(
        "Each agent is a named persona with its own strategy, memory, and risk profile. Users "
        "deposit USDT or USDC into their custodial wallet, pick an agent, and the agent trades "
        "24/7 on their behalf, reporting every decision in plain English before the trade fires.",
        s["body"]))
    story.append(Paragraph(
        "Unlike most “AI trading” products that are signal bots in a chat — push a notification, "
        "pray the user acts in time — BUILD4 is execution-native. The agent has the wallet, makes "
        "the call, and takes the trade end-to-end. Users wake up to fills the agent took at 3am, "
        "with the reasoning posted before every one.", s["body"]))

    story.append(Paragraph("What makes it different", s["h3"]))
    for line in [
        "<b>Four-venue agent</b> — single agent persona trades perps and prediction markets in parallel.",
        "<b>Gasless prediction markets</b> — Polymarket via Gnosis Safe + relayer; users never need MATIC.",
        "<b>Multi-LLM swarm voting</b> — opt-in mode where multiple language models vote on each decision; quorum required to act.",
        "<b>Reasoning-first UX</b> — every trade is preceded by the agent's plain-English rationale in chat.",
        "<b>Real custody, real execution</b> — not a paper-trade demo, not a signal bot.",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(Paragraph("Supported venues", s["h3"]))
    story.append(venue_table())

    story.append(Paragraph("How it works (user flow)", s["h3"]))
    flow = [
        "User opens BUILD4 in Telegram or on the web dApp.",
        "Picks an agent persona — each has a stated strategy and risk profile.",
        "Deposits USDT (BSC) or USDC (Polygon, gasless via Safe).",
        "Agent runs every 60 seconds — scans, decides, trades, reports.",
        "User can deposit, withdraw, pause, or fully take over at any time.",
    ]
    for i, step in enumerate(flow, 1):
        story.append(Paragraph(
            f"<font color='#2BAB6A'><b>{i}.</b></font>  {step}", s["bullet"]))

    story.append(PageBreak())

    # ---------- BOILERPLATE ----------
    story.append(Paragraph("Boilerplate Copy", s["h2"]))
    story.append(Paragraph(
        "Drop-in descriptions for tweets, partnership posts, press, and bios. Pick the length you need.",
        s["muted"]))

    story.append(Paragraph("One-liner (15 words)", s["h3"]))
    story.append(Paragraph(
        "BUILD4 is an AI agent that trades crypto perps and prediction markets autonomously, "
        "across four venues, from your Telegram.", s["quote"]))

    story.append(Paragraph("Tagline options", s["h3"]))
    for line in [
        "AI agents that trade for you.",
        "Delegate execution. Keep the keys.",
        "An agent for every market.",
        "Built for the four venues that matter.",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(Paragraph("One paragraph (~70 words)", s["h3"]))
    story.append(Paragraph(
        "BUILD4 is an AI-powered trading bot for crypto perpetual futures and prediction markets. "
        "Users deposit funds, pick an agent persona, and the agent trades 24/7 on their behalf — "
        "across Aster DEX, Hyperliquid, 42.space, and Polymarket. Every trade is preceded by the "
        "agent's plain-English reasoning, posted in the user's Telegram chat. Multi-LLM swarm voting, "
        "daily loss circuit breakers, and encrypted custodial wallets keep execution accountable. "
        "Live on Telegram and at build4.io.", s["quote"]))

    story.append(Paragraph("Two paragraphs (~150 words)", s["h3"]))
    story.append(Paragraph(
        "BUILD4 is an AI-powered trading platform that lets users delegate execution to autonomous "
        "agents across four crypto venues — Aster DEX perps, Hyperliquid perps, 42.space prediction "
        "markets, and Polymarket — all from a single Telegram chat or web dApp. Each agent is a named "
        "persona with its own strategy, memory, and risk profile. Users deposit USDT or USDC into "
        "their custodial wallet, pick an agent, and the agent trades 24/7 on their behalf, reporting "
        "every decision in plain English.", s["quote"]))
    story.append(Paragraph(
        "Unlike most “AI trading” tools, BUILD4 is execution-native: the agent holds the wallet, "
        "makes the call, and takes the trade end-to-end. Polymarket trades are fully gasless via "
        "Gnosis Safe and a relayer (no MATIC ever required). Optional multi-LLM swarm voting requires "
        "quorum across multiple language models before any action. Daily loss circuit breakers, "
        "AES-256-encrypted private keys, and per-agent risk caps keep the system accountable.",
        s["quote"]))

    story.append(Paragraph("Founder quote", s["h3"]))
    story.append(Paragraph(
        "“We built BUILD4 because every other ‘AI trading’ product was a signal bot in a chat — "
        "push a notification, pray the user acts in time. The interesting question is: what happens "
        "when the agent has the wallet? Now we know. Our users wake up to trades the agent took at "
        "3am, with the reasoning posted before every fill.”", s["quote"]))
    story.append(Paragraph("— [Founder Name], Founder, BUILD4", s["muted"]))

    story.append(PageBreak())

    # ---------- BRAND ----------
    story.append(Paragraph("Brand", s["h2"]))

    story.append(Paragraph("Color palette", s["h3"]))
    story.append(Paragraph(
        "Pulled directly from the live BUILD4 dApp. Use the Brand Green as the dominant accent and "
        "let everything else sit on near-black. Backgrounds should always be near-black or pure black "
        "— never a colored background.", s["body"]))
    story.append(Spacer(1, 0.1 * inch))
    for name, hex_code, usage in [
        ("Brand Green", "#2BAB6A", "CTAs, agent activity, gains, primary buttons, brand accents"),
        ("Background",  "#090C0B", "Page background — near-black with green undertone"),
        ("Foreground",  "#CFD3D1", "Primary text on dark background"),
        ("Card",        "#10130F", "Card / panel background"),
        ("Muted Text",  "#6E7572", "Secondary / placeholder text"),
        ("Destructive", "#B92F2F", "Losses, errors, sells"),
    ]:
        story.append(color_swatch_row(name, hex_code, usage))
        story.append(Spacer(1, 0.06 * inch))

    story.append(Paragraph("Typography", s["h3"]))
    story.append(Paragraph(
        "BUILD4 ships with the system font stack. For polished campaign assets we recommend Inter or "
        "Geist — sans-serif, 700 for headlines, 400/500 for body. Use tabular numerals "
        "(<font face='Courier'>font-variant-numeric: tabular-nums</font>) for prices and P&L so digits "
        "don't jitter.", s["body"]))

    story.append(Paragraph("Logo usage", s["h3"]))
    story.append(Paragraph(
        "Place the logo on the brand background (#090C0B) or pure black. Maintain clear space around "
        "the logo equal to at least the height of the “4”. Keep the green channel intact — the green "
        "<i>is</i> the brand.", s["body"]))
    story.append(Paragraph("Don't:", s["body"]))
    for line in [
        "Don't recolor the logo.",
        "Don't place it on a busy photo background.",
        "Don't stretch, shear, or rotate.",
        "Don't add drop shadows, glows, or effects.",
        "Don't render below 32 px tall (use the favicon instead).",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(Paragraph("Voice & tone", s["h3"]))
    for line in [
        "<b>Concise.</b> Short sentences. No marketing fluff.",
        "<b>Show, don't claim.</b> A specific trade beats a generic adjective.",
        "<b>Receipts.</b> When making performance claims, link the on-chain trade.",
        "<b>Lowercase is fine for casual contexts</b> (Twitter, Telegram). Title Case for formal partnerships and PR.",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(PageBreak())

    # ---------- FACT SHEET ----------
    story.append(Paragraph("Fact Sheet", s["h2"]))
    story.append(Paragraph(
        "Replace the bracketed placeholders with your own details before sending externally.",
        s["muted"]))
    story.append(Spacer(1, 0.1 * inch))
    story.append(kv_table([
        ("Project",       "BUILD4"),
        ("Category",      "AI trading agent / execution platform"),
        ("Founded",       "[year]"),
        ("Founder(s)",    "[names]"),
        ("HQ / region",   "[location]"),
        ("Website",       "https://build4.io"),
        ("Telegram bot",  "[@build4_bot]"),
        ("Twitter / X",   "[@handle]"),
        ("Mini-app",      "Inside Telegram via the bot"),
        ("Web dApp",      "https://build4.io/app  (WalletConnect)"),
    ]))

    story.append(Paragraph("Tech stack (high level)", s["h3"]))
    for line in [
        "<b>Backend:</b> Node.js + TypeScript, Express",
        "<b>Bot framework:</b> grammY (Telegram)",
        "<b>Database:</b> PostgreSQL (Prisma ORM)",
        "<b>AI:</b> Anthropic Claude, xAI Grok, Hyperbolic, Akash (multi-LLM router)",
        "<b>Wallets:</b> ethers.js v6, AES-256 encrypted custody",
        "<b>Polymarket:</b> Gnosis Safe + Polymarket relayer (gasless)",
        "<b>Frontend:</b> Vite + React 18 (mini-app and web dApp)",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(Paragraph("Security posture", s["h3"]))
    for line in [
        "AES-256 encryption for all custodial private keys.",
        "Daily loss circuit breaker per agent.",
        "Builder-attribution fail-closed on Polymarket — no orders placed if attribution config missing.",
        "SIWE-authenticated web sessions with origin pinning and nonce one-time-use.",
        "Encrypted wallet seeds at rest; never logged.",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(Paragraph("Available for", s["h3"]))
    for line in [
        "Partnership integrations (DEXs, prediction markets, oracle providers).",
        "Press, podcast appearances, KOL demos, co-marketing.",
        "Hackathon judging and grant program collaborations.",
    ]:
        story.append(Paragraph(f"•  {line}", s["bullet"]))

    story.append(Paragraph("Press contact", s["h3"]))
    story.append(kv_table([
        ("Name",     "[your name]"),
        ("Email",    "[your email]"),
        ("Telegram", "[@yourhandle]"),
    ]))

    story.append(Spacer(1, 0.4 * inch))
    story.append(Paragraph(
        "© BUILD4. All trademarks property of their respective owners.", s["footer"]))

    doc.build(story, onFirstPage=page_decoration, onLaterPages=page_decoration)
    print(f"wrote {OUT_PATH} — {os.path.getsize(OUT_PATH)/1024:.1f} KB")


if __name__ == "__main__":
    build()
