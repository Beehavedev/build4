import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectIntent, isGroupChat } from './llm'
import type { Context } from 'grammy'

// ── detectIntent: positive matches ─────────────────────────────────────────

test('detectIntent → wallet for "what is my balance"', () => {
  assert.equal(detectIntent("what's my balance"), 'wallet')
  assert.equal(detectIntent('what is my balance'), 'wallet')
  assert.equal(detectIntent('my balance'), 'wallet')
  assert.equal(detectIntent('show me my wallet'), 'wallet')
  assert.equal(detectIntent('show my balance'), 'wallet')
  assert.equal(detectIntent('how much do i have'), 'wallet')
  assert.equal(detectIntent('how much usdt do i have'), 'wallet')
  assert.equal(detectIntent('my funds'), 'wallet')
  assert.equal(detectIntent('my deposit address'), 'wallet')
})

test('detectIntent → positions for open-trade queries', () => {
  assert.equal(detectIntent('my positions'), 'positions')
  assert.equal(detectIntent('my open positions'), 'positions')
  assert.equal(detectIntent('open positions'), 'positions')
  assert.equal(detectIntent('open trades'), 'positions')
  assert.equal(detectIntent('any open positions'), 'positions')
  assert.equal(detectIntent('current trades'), 'positions')
  assert.equal(detectIntent('what am i in'), 'positions')
  assert.equal(detectIntent('what am i holding'), 'positions')
  assert.equal(detectIntent("what's open"), 'positions')
  assert.equal(detectIntent('show me my positions'), 'positions')
  assert.equal(detectIntent('show my trades'), 'positions')
})

test('detectIntent → portfolio for performance / pnl queries', () => {
  assert.equal(detectIntent('my portfolio'), 'portfolio')
  assert.equal(detectIntent('my pnl'), 'portfolio')
  assert.equal(detectIntent('my p&l'), 'portfolio')
  assert.equal(detectIntent('my p & l'), 'portfolio')
  assert.equal(detectIntent('my profit and loss'), 'portfolio')
  assert.equal(detectIntent('my performance'), 'portfolio')
  assert.equal(detectIntent('my trade history'), 'portfolio')
  assert.equal(detectIntent('my history'), 'portfolio')
  assert.equal(detectIntent('my win rate'), 'portfolio')
  assert.equal(detectIntent('my results'), 'portfolio')
  assert.equal(detectIntent('how am i doing'), 'portfolio')
  assert.equal(detectIntent('how am i trading'), 'portfolio')
  assert.equal(detectIntent("how's my portfolio"), 'portfolio')
  assert.equal(detectIntent("how's my week"), 'portfolio')
  assert.equal(detectIntent('how is my trading'), 'portfolio')
})

// ── detectIntent: negative cases (the architect's flagged false positives) ─

test('detectIntent rejects "your position" style market questions', () => {
  // Was a confirmed false positive in the first version of the regex.
  assert.equal(detectIntent("what's your position on this token"), null)
  assert.equal(detectIntent('what is your position on bitcoin'), null)
  assert.equal(detectIntent('your position is interesting'), null)
})

test('detectIntent rejects "what trades should I take" / "trade ideas"', () => {
  // "what trades" was over-matching to /tradestatus.
  assert.equal(detectIntent('what trades should i take'), null)
  assert.equal(detectIntent('any good trade ideas'), null)
  assert.equal(detectIntent('trade ideas for today'), null)
})

test('detectIntent rejects "open a position" (action verb, not data query)', () => {
  // "open" followed by "a/on/for/in" is an instruction, not a question
  // about existing data.
  assert.equal(detectIntent('open a position on btc'), null)
  assert.equal(detectIntent('open positions on bitcoin'), null)
  assert.equal(detectIntent('open trades for me'), null)
  assert.equal(detectIntent('open trades in altcoins'), null)
})

test('detectIntent rejects market history / performance questions about other assets', () => {
  // Was a confirmed false positive in the first version of the regex.
  assert.equal(detectIntent('trade history of btc'), null)
  assert.equal(detectIntent('performance of solana'), null)
  assert.equal(detectIntent('history of doge'), null)
  assert.equal(detectIntent('results of the airdrop'), null)
})

test('detectIntent rejects price / chart / general market chatter', () => {
  assert.equal(detectIntent('what is the price of bitcoin'), null)
  assert.equal(detectIntent('show me a chart of eth'), null)
  assert.equal(detectIntent('how is the market today'), null)
  assert.equal(detectIntent('balance sheet of company x'), null)
  assert.equal(detectIntent('wallet integration with metamask'), null)
  assert.equal(detectIntent('how much is btc'), null)
})

test('detectIntent rejects empty, whitespace, and overly long inputs', () => {
  assert.equal(detectIntent(''), null)
  assert.equal(detectIntent('   '), null)
  // Cap at 200 chars: paragraph that happens to contain "my balance".
  const longText = 'a'.repeat(195) + ' my balance'
  assert.equal(detectIntent(longText), null)
})

test('detectIntent is case-insensitive', () => {
  assert.equal(detectIntent('WHAT IS MY BALANCE'), 'wallet')
  assert.equal(detectIntent('My Positions'), 'positions')
  assert.equal(detectIntent('How Am I Doing'), 'portfolio')
})

// ── isGroupChat: privacy guard ─────────────────────────────────────────────

test('isGroupChat returns true only for group / supergroup', () => {
  const mk = (type: string) => ({ chat: { type } } as unknown as Context)
  assert.equal(isGroupChat(mk('group')), true)
  assert.equal(isGroupChat(mk('supergroup')), true)
  assert.equal(isGroupChat(mk('private')), false)
  assert.equal(isGroupChat(mk('channel')), false)
  // No chat at all (e.g. inline query) should not count as group.
  assert.equal(isGroupChat({} as Context), false)
})
