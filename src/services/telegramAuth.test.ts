import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { db } from '../db'
import {
  getAdminTelegramIds,
  isAdminTelegramId,
  requireAdmin,
  requireTgUser,
} from './telegramAuth'

// ── Env save / restore ────────────────────────────────────────────────────
// requireAdmin reads ADMIN_TOKEN, ADMIN_TELEGRAM_IDS, ADMIN_CHAT_ID and (via
// requireTgUser) TELEGRAM_BOT_TOKEN. requireTgUser's first-touch path also
// runs generateAndSaveWallet, which reads MASTER_ENCRYPTION_KEY /
// WALLET_ENCRYPTION_KEY (it throws under a leaked default). Snapshot +
// restore all of them so tests can't leak into each other or into
// neighbouring test files.
const ENV_KEYS = [
  'ADMIN_TOKEN',
  'ADMIN_TELEGRAM_IDS',
  'ADMIN_CHAT_ID',
  'TELEGRAM_BOT_TOKEN',
  'MASTER_ENCRYPTION_KEY',
  'WALLET_ENCRYPTION_KEY',
] as const
const ORIG: Record<string, string | undefined> = {}

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

// ── Telegram initData forging ─────────────────────────────────────────────
// parseInitData verifies an HMAC over the sorted data-check string keyed by
// the bot token (Telegram WebApp scheme). To exercise the allowlist path we
// build a *valid* initData blob the same way a real WebApp would.
function buildInitData(botToken: string, user: object): string {
  const params = new URLSearchParams()
  params.set('auth_date', '1700000000')
  params.set('user', JSON.stringify(user))
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

// ── Minimal Express req/res/next doubles ──────────────────────────────────
function makeReq(opts: { headers?: Record<string, string>; query?: Record<string, string> }): Request {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v
  return {
    headers,
    query: opts.query ?? {},
    header(name: string) {
      return headers[name.toLowerCase()]
    },
  } as unknown as Request
}

type Captured = { statusCode?: number; body?: any }
function makeRes(captured: Captured, onDone?: () => void): Response {
  const res = {
    status(code: number) {
      captured.statusCode = code
      return res
    },
    json(payload: any) {
      captured.body = payload
      onDone?.()
      return res
    },
  }
  return res as unknown as Response
}

// db.user.findUnique is the only db touch on the Telegram allowlist path
// (when the user already exists). Swap it with a spy so tests stay offline
// and the wallet-provisioning branch never runs.
type UserStore = { findUnique: Function }
const userStore = (db as unknown as { user: UserStore }).user

describe('telegramAuth', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) ORIG[k] = process.env[k]
    clearEnv()
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (ORIG[k] != null) process.env[k] = ORIG[k]
      else delete process.env[k]
    }
  })

  describe('getAdminTelegramIds', () => {
    it('is empty when nothing configured', () => {
      assert.equal(getAdminTelegramIds().size, 0)
    })
    it('parses comma-separated ADMIN_TELEGRAM_IDS, trimming blanks', () => {
      process.env.ADMIN_TELEGRAM_IDS = ' 111 , 222 ,, 333 '
      const ids = getAdminTelegramIds()
      assert.deepEqual([...ids].sort(), ['111', '222', '333'])
    })
    it('merges legacy ADMIN_CHAT_ID alias', () => {
      process.env.ADMIN_TELEGRAM_IDS = '111'
      process.env.ADMIN_CHAT_ID = '999'
      assert.deepEqual([...getAdminTelegramIds()].sort(), ['111', '999'])
    })
  })

  describe('isAdminTelegramId', () => {
    it('matches across bigint / number / string forms', () => {
      process.env.ADMIN_TELEGRAM_IDS = '12345'
      assert.equal(isAdminTelegramId(12345), true)
      assert.equal(isAdminTelegramId('12345'), true)
      assert.equal(isAdminTelegramId(12345n), true)
      assert.equal(isAdminTelegramId(54321), false)
    })
  })

  describe('requireAdmin', () => {
    it('rejects with 401 when neither ADMIN_TOKEN nor ADMIN_TELEGRAM_IDS is set', () => {
      const captured: Captured = {}
      let nextCalled = false
      requireAdmin(makeReq({}), makeRes(captured), (() => { nextCalled = true }) as NextFunction)
      assert.equal(nextCalled, false)
      assert.equal(captured.statusCode, 401)
      assert.deepEqual(captured.body, { error: 'Admin access required' })
    })

    it('accepts a request with the correct x-admin-token header', () => {
      process.env.ADMIN_TOKEN = 's3cret'
      const captured: Captured = {}
      let nextCalled = false
      requireAdmin(
        makeReq({ headers: { 'x-admin-token': 's3cret' } }),
        makeRes(captured),
        (() => { nextCalled = true }) as NextFunction,
      )
      assert.equal(nextCalled, true)
      assert.equal(captured.statusCode, undefined)
    })

    it('accepts a request with the correct ?token= query param', () => {
      process.env.ADMIN_TOKEN = 's3cret'
      const captured: Captured = {}
      let nextCalled = false
      requireAdmin(
        makeReq({ query: { token: 's3cret' } }),
        makeRes(captured),
        (() => { nextCalled = true }) as NextFunction,
      )
      assert.equal(nextCalled, true)
      assert.equal(captured.statusCode, undefined)
    })

    it('rejects a wrong token with 401 (no Telegram fallback creds)', () => {
      process.env.ADMIN_TOKEN = 's3cret'
      const captured: Captured = {}
      let nextCalled = false
      requireAdmin(
        makeReq({ headers: { 'x-admin-token': 'nope' } }),
        makeRes(captured),
        (() => { nextCalled = true }) as NextFunction,
      )
      assert.equal(nextCalled, false)
      assert.equal(captured.statusCode, 401)
      assert.deepEqual(captured.body, { error: 'Admin access required' })
    })

    it('rejects a missing token with 401 when ADMIN_TOKEN is set', () => {
      process.env.ADMIN_TOKEN = 's3cret'
      const captured: Captured = {}
      let nextCalled = false
      requireAdmin(makeReq({}), makeRes(captured), (() => { nextCalled = true }) as NextFunction)
      assert.equal(nextCalled, false)
      assert.equal(captured.statusCode, 401)
    })

    it('accepts a Telegram user whose ID is in ADMIN_TELEGRAM_IDS', async () => {
      const BOT_TOKEN = 'test-bot-token'
      process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN
      process.env.ADMIN_TELEGRAM_IDS = '777'
      const initData = buildInitData(BOT_TOKEN, { id: 777, username: 'admin' })

      const orig = userStore.findUnique
      userStore.findUnique = async () => ({ id: 'u-admin', telegramId: 777n })
      try {
        const captured: Captured = {}
        let nextCalled = false
        await new Promise<void>((resolve) => {
          requireAdmin(
            makeReq({ headers: { 'x-telegram-init-data': initData } }),
            makeRes(captured, resolve),
            (() => { nextCalled = true; resolve() }) as NextFunction,
          )
        })
        assert.equal(nextCalled, true)
        assert.equal(captured.statusCode, undefined)
      } finally {
        userStore.findUnique = orig
      }
    })

    it('rejects a Telegram user whose ID is NOT in ADMIN_TELEGRAM_IDS with 403', async () => {
      const BOT_TOKEN = 'test-bot-token'
      process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN
      process.env.ADMIN_TELEGRAM_IDS = '777'
      const initData = buildInitData(BOT_TOKEN, { id: 555, username: 'rando' })

      const orig = userStore.findUnique
      userStore.findUnique = async () => ({ id: 'u-rando', telegramId: 555n })
      try {
        const captured: Captured = {}
        let nextCalled = false
        await new Promise<void>((resolve) => {
          requireAdmin(
            makeReq({ headers: { 'x-telegram-init-data': initData } }),
            makeRes(captured, resolve),
            (() => { nextCalled = true; resolve() }) as NextFunction,
          )
        })
        assert.equal(nextCalled, false)
        assert.equal(captured.statusCode, 403)
        assert.deepEqual(captured.body, { error: 'Admin access required' })
      } finally {
        userStore.findUnique = orig
      }
    })

    it('rejects with 401 when ADMIN_TELEGRAM_IDS is set but no auth is supplied', () => {
      process.env.ADMIN_TELEGRAM_IDS = '777'
      const captured: Captured = {}
      let nextCalled = false
      requireAdmin(makeReq({}), makeRes(captured), (() => { nextCalled = true }) as NextFunction)
      assert.equal(nextCalled, false)
      assert.equal(captured.statusCode, 401)
    })
  })

  // ── requireTgUser ─────────────────────────────────────────────────────────
  // The gate every mini-app request passes through. We exercise it against the
  // shared `db` singleton by swapping the exact methods each path touches.
  //
  // The first-touch (new-user) branch calls generateAndSaveWallet(), which is
  // a static import inside telegramAuth and so cannot be reassigned from a
  // test. Instead we neutralise it the same way the rest of this file mocks
  // the db: generateAndSaveWallet only touches db.wallet.* + encryptPrivateKey
  // (offline: ethers random keypair + CryptoJS, no network), so mocking
  // db.wallet.* keeps the whole provisioning path offline. A valid
  // MASTER_ENCRYPTION_KEY is set so encryptPrivateKey doesn't fail-closed on a
  // leaked default. To force a *provisioning failure* we make the first db
  // write inside provisioning throw.

  type AnyStore = Record<string, Function>
  const stores = db as unknown as {
    user: AnyStore
    wallet: AnyStore
    portfolio: AnyStore
    quest: AnyStore
    userQuest: AnyStore
  }

  // Install method overrides on the db singleton, returning a restore fn that
  // puts the originals back. Only the named methods are touched.
  function patchDb(overrides: {
    user?: Partial<AnyStore>
    wallet?: Partial<AnyStore>
    portfolio?: Partial<AnyStore>
    quest?: Partial<AnyStore>
    userQuest?: Partial<AnyStore>
  }): () => void {
    const saved: Array<[AnyStore, string, Function]> = []
    for (const [model, methods] of Object.entries(overrides)) {
      const store = (stores as any)[model] as AnyStore
      for (const [name, fn] of Object.entries(methods as AnyStore)) {
        saved.push([store, name, store[name]])
        store[name] = fn
      }
    }
    return () => {
      for (const [store, name, fn] of saved) store[name] = fn
    }
  }

  // Quiet + capture console during first-touch (it logs success/failure).
  function silenceConsole(): { logs: any[][]; errors: any[][]; restore: () => void } {
    const logs: any[][] = []
    const errors: any[][] = []
    const origLog = console.log
    const origErr = console.error
    console.log = (...a: any[]) => { logs.push(a) }
    console.error = (...a: any[]) => { errors.push(a) }
    return { logs, errors, restore: () => { console.log = origLog; console.error = origErr } }
  }

  function runTgUser(req: Request): Promise<{ captured: Captured; nextCalled: boolean; nextErr: any }> {
    const captured: Captured = {}
    let nextCalled = false
    let nextErr: any
    return new Promise((resolve) => {
      const res = makeRes(captured, () => resolve({ captured, nextCalled, nextErr }))
      requireTgUser(req, res, ((err?: any) => {
        nextCalled = true
        nextErr = err
        resolve({ captured, nextCalled, nextErr })
      }) as NextFunction)
    })
  }

  describe('requireTgUser', () => {
    it('returns 500 when TELEGRAM_BOT_TOKEN is unset (operator misconfig)', async () => {
      // beforeEach already cleared TELEGRAM_BOT_TOKEN.
      const con = silenceConsole()
      try {
        const { captured, nextCalled } = await runTgUser(
          makeReq({ headers: { 'x-telegram-init-data': 'whatever' } }),
        )
        assert.equal(nextCalled, false)
        assert.equal(captured.statusCode, 500)
        assert.match(captured.body.error, /TELEGRAM_BOT_TOKEN/)
        // Loud server log so operators can grep for the misconfig.
        assert.equal(con.errors.length >= 1, true)
      } finally {
        con.restore()
      }
    })

    it('returns 401 "Missing Telegram auth" when no init-data header is supplied', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token'
      const { captured, nextCalled } = await runTgUser(makeReq({}))
      assert.equal(nextCalled, false)
      assert.equal(captured.statusCode, 401)
      assert.deepEqual(captured.body, { error: 'Missing Telegram auth' })
    })

    it('returns 401 "Invalid Telegram auth" when the HMAC hash does not verify', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token'
      // initData built with the WRONG token → computed hash mismatches.
      const forged = buildInitData('a-different-token', { id: 42, username: 'mallory' })
      const { captured, nextCalled } = await runTgUser(
        makeReq({ headers: { 'x-telegram-init-data': forged } }),
      )
      assert.equal(nextCalled, false)
      assert.equal(captured.statusCode, 401)
      assert.deepEqual(captured.body, { error: 'Invalid Telegram auth' })
    })

    it('attaches the existing user and calls next() for valid init-data', async () => {
      const BOT_TOKEN = 'test-bot-token'
      process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN
      const initData = buildInitData(BOT_TOKEN, { id: 123, username: 'alice' })
      const existing = { id: 'u-alice', telegramId: 123n, username: 'alice' }

      let createCalled = false
      const restore = patchDb({
        user: {
          findUnique: async () => existing,
          create: async () => { createCalled = true; return existing },
        },
      })
      try {
        const req = makeReq({ headers: { 'x-telegram-init-data': initData } })
        const { captured, nextCalled, nextErr } = await runTgUser(req)
        assert.equal(nextCalled, true)
        assert.equal(nextErr, undefined)
        assert.equal(captured.statusCode, undefined)
        assert.deepEqual((req as any).user, existing)
        // Existing user → provisioning branch must NOT run.
        assert.equal(createCalled, false)
      } finally {
        restore()
      }
    })

    it('first-touch: creates the user and provisions wallet/portfolio/quests', async () => {
      const BOT_TOKEN = 'test-bot-token'
      process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN
      // Real (non-default) key so generateAndSaveWallet's encryptPrivateKey
      // doesn't fail-closed.
      process.env.MASTER_ENCRYPTION_KEY = 'unit-test-master-key-32-chars-min!!'
      const initData = buildInitData(BOT_TOKEN, { id: 999, username: 'newbie', first_name: 'New' })
      const created = { id: 'u-new', telegramId: 999n, username: 'newbie' }

      const calls: Record<string, number> = {
        userCreate: 0, walletCreate: 0, portfolioCreate: 0, questUpsert: 0,
      }
      const restore = patchDb({
        user: {
          findUnique: async () => null,
          create: async (args: any) => {
            calls.userCreate++
            assert.equal(args.data.telegramId, 999n)
            return created
          },
        },
        wallet: {
          updateMany: async () => ({ count: 0 }),
          count: async () => 0,
          create: async () => { calls.walletCreate++; return { address: '0xabc', chain: 'BSC' } },
        },
        portfolio: { create: async () => { calls.portfolioCreate++; return {} } },
        quest: { findMany: async () => [{ id: 'q1' }, { id: 'q2' }] },
        userQuest: { upsert: async () => { calls.questUpsert++; return {} } },
      })
      const con = silenceConsole()
      try {
        const req = makeReq({ headers: { 'x-telegram-init-data': initData } })
        const { captured, nextCalled, nextErr } = await runTgUser(req)
        assert.equal(nextCalled, true)
        assert.equal(nextErr, undefined)
        assert.equal(captured.statusCode, undefined)
        assert.deepEqual((req as any).user, created)
        assert.equal(calls.userCreate, 1)
        assert.equal(calls.walletCreate, 1)
        assert.equal(calls.portfolioCreate, 1)
        assert.equal(calls.questUpsert, 2) // one per active quest
      } finally {
        con.restore()
        restore()
      }
    })

    it('first-touch: a provisioning failure is non-fatal — still attaches user and next()', async () => {
      const BOT_TOKEN = 'test-bot-token'
      process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN
      process.env.MASTER_ENCRYPTION_KEY = 'unit-test-master-key-32-chars-min!!'
      const initData = buildInitData(BOT_TOKEN, { id: 1000, username: 'flaky' })
      const created = { id: 'u-flaky', telegramId: 1000n, username: 'flaky' }

      let portfolioCalled = false
      const restore = patchDb({
        user: {
          findUnique: async () => null,
          create: async () => created,
        },
        wallet: {
          // First write inside provisioning throws → generateAndSaveWallet
          // rejects → caught as non-fatal in requireTgUser.
          updateMany: async () => { throw new Error('db down') },
          count: async () => 0,
          create: async () => ({ address: '0xabc', chain: 'BSC' }),
        },
        portfolio: { create: async () => { portfolioCalled = true; return {} } },
        quest: { findMany: async () => [] },
        userQuest: { upsert: async () => ({}) },
      })
      const con = silenceConsole()
      try {
        const req = makeReq({ headers: { 'x-telegram-init-data': initData } })
        const { captured, nextCalled, nextErr } = await runTgUser(req)
        // Request still succeeds: user attached, next() called, no error status.
        assert.equal(nextCalled, true)
        assert.equal(nextErr, undefined)
        assert.equal(captured.statusCode, undefined)
        assert.deepEqual((req as any).user, created)
        // Provisioning aborted at the failing step — later steps never ran.
        assert.equal(portfolioCalled, false)
        // Failure was logged, not swallowed silently.
        assert.equal(con.errors.some((a) => String(a[0]).includes('provisioning failed')), true)
      } finally {
        con.restore()
        restore()
      }
    })
  })
})
