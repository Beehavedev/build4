import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAsterFeeOverMaxError } from './asterReapprove'

function asterErr(code: number, msg: string) {
  const e: any = new Error('Request failed with status code 400')
  e.response = { data: { code, msg } }
  return e
}

test('isAsterFeeOverMaxError: -4400 with fee/max wording → true', () => {
  assert.equal(isAsterFeeOverMaxError(asterErr(-4400, 'feeRate exceeds builder approved maxFeeRate')), true)
  assert.equal(isAsterFeeOverMaxError(asterErr(-4400, 'builder fee rate over max')), true)
})

test('isAsterFeeOverMaxError: -4400 without fee/max wording → false', () => {
  assert.equal(isAsterFeeOverMaxError(asterErr(-4400, 'something unrelated')), false)
})

test('isAsterFeeOverMaxError: text-fallback requires both token AND exceed verb', () => {
  // token only (no exceed verb) → false
  assert.equal(isAsterFeeOverMaxError(asterErr(-9999, 'maxFeeRate is set')), false)
  // exceed verb only (no token) → false
  assert.equal(isAsterFeeOverMaxError(asterErr(-9999, 'order exceeds something')), false)
  // both → true
  assert.equal(isAsterFeeOverMaxError(asterErr(-9999, 'maxFeeRate exceed approved')), true)
  assert.equal(isAsterFeeOverMaxError(asterErr(-9999, 'fee rate max exceeded')), true)
})

test('isAsterFeeOverMaxError: unrelated rejects → false', () => {
  assert.equal(isAsterFeeOverMaxError(asterErr(-2010, 'Account has insufficient balance')), false)
  assert.equal(isAsterFeeOverMaxError(asterErr(-1000, 'No agent found')), false)
  assert.equal(isAsterFeeOverMaxError(asterErr(-1111, 'Precision is over the maximum')), false)
})

test('isAsterFeeOverMaxError: string-body fallback', () => {
  const e: any = new Error('Request failed')
  e.response = { data: 'maxFeeRate exceeds approved' }
  assert.equal(isAsterFeeOverMaxError(e), true)
})

test('isAsterFeeOverMaxError: null/undefined/empty → false (defensive)', () => {
  assert.equal(isAsterFeeOverMaxError(null), false)
  assert.equal(isAsterFeeOverMaxError(undefined), false)
  assert.equal(isAsterFeeOverMaxError({}), false)
  assert.equal(isAsterFeeOverMaxError(new Error('plain')), false)
})
