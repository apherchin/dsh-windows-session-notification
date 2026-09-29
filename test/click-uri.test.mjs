import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClickLine } from '../lib/click-uri.mjs'

test('正常 UUID 形态', () => {
  const r = parseClickLine('2026/09/26 周六 12:00:00.00 "dsh-attention:open/session-7a87d682-0631-4781-94c6-73ceccb6f111"')
  assert.deepEqual(r, { verb: 'open', sessionId: 'session-7a87d682-0631-4781-94c6-73ceccb6f111' })
})

test('尾随引号必须被剥掉（实测 bug）', () => {
  const r = parseClickLine('2026/09/26 周六 12:00:00.00 "dsh-attention:open/SELFTEST"')
  assert.deepEqual(r, { verb: 'open', sessionId: 'SELFTEST' })
})

test('focus 无 id', () => {
  assert.deepEqual(parseClickLine('dsh-attention:focus'), { verb: 'focus', sessionId: undefined })
})

test('dismiss 带 id', () => {
  assert.deepEqual(parseClickLine('dsh-attention:dismiss/abc'), { verb: 'dismiss', sessionId: 'abc' })
})

test('空 id 视为无 id', () => {
  assert.deepEqual(parseClickLine('dsh-attention:open/'), { verb: 'open', sessionId: undefined })
})

test('无关行返回 null', () => {
  assert.equal(parseClickLine('hello world'), null)
  assert.equal(parseClickLine(''), null)
  assert.equal(parseClickLine(undefined), null)
})

test('id 遇空白即止（不会被空格污染）', () => {
  assert.deepEqual(parseClickLine('dsh-attention:open/abc def'), { verb: 'open', sessionId: 'abc' })
})
