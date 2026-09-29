/**
 * 事件载荷解析的回归测试。
 *
 * 为什么单独有这个文件：2026-09-26 的线上故障是「处理器在写日志之前抛错，而发射方把异常吞掉
 * 当成 unavailable」⇒ 审批/待回答事件到了总线（探针能看见）却什么都没发生、日志也一片空白。
 * 根因就是 `sessionIdOf` 直接读作用域句柄的属性会抛。这里把"读不动也不许抛"钉成断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { keysOf, safeGet, sessionIdOf } from '../index.mjs'

const HOST = new URL('../index.mjs', import.meta.url)

test('正常载荷：agent.id 就是会话 id', () => {
  assert.equal(sessionIdOf({ agent: { id: 'session-abc' } }), 'session-abc')
})

test('agent 没有 id 时退到 agent.session.id', () => {
  assert.equal(sessionIdOf({ agent: { session: { id: 'session-nested' } } }), 'session-nested')
})

test('没有 agent 时退到 session.id / sessionId / id', () => {
  assert.equal(sessionIdOf({ session: { id: 'session-s' } }), 'session-s')
  assert.equal(sessionIdOf({ sessionId: 'session-sid' }), 'session-sid')
  assert.equal(sessionIdOf({ id: 'session-id' }), 'session-id')
})

test('取不到就是 null（不是空串、不抛）', () => {
  assert.equal(sessionIdOf({}), null)
  assert.equal(sessionIdOf(null), null)
  assert.equal(sessionIdOf(undefined), null)
  assert.equal(sessionIdOf({ agent: { id: '' } }), null)
})

test('作用域句柄读属性会抛 —— 必须被吞掉并返回 null（线上就是这里把处理器打成静默）', () => {
  const hostile = new Proxy({}, { get() { throw new Error('revoked: out of scope') } })
  assert.doesNotThrow(() => sessionIdOf({ agent: hostile }))
  assert.equal(sessionIdOf({ agent: hostile }), null)
})

test('载荷本身是不可读代理也不许抛', () => {
  const hostile = new Proxy({}, { get() { throw new Error('revoked') } })
  assert.doesNotThrow(() => sessionIdOf(hostile))
  assert.equal(sessionIdOf(hostile), null)
})

test('safeGet：读不动返回 undefined，不抛', () => {
  const hostile = new Proxy({}, { get() { throw new Error('revoked') } })
  assert.equal(safeGet(hostile, 'anything'), undefined)
  assert.equal(safeGet(null, 'x'), undefined)
  assert.equal(safeGet({ a: 1 }, 'a'), 1)
})

test('keysOf：给出可读的顶层键，不可枚举时不抛', () => {
  assert.equal(keysOf({ agent: 1, questions: [] }), '[agent,questions]')
  assert.equal(keysOf(null), 'null')
  assert.equal(keysOf('x'), '(string)')
  const hostileKeys = new Proxy({}, { ownKeys() { throw new Error('revoked') } })
  assert.match(keysOf(hostileKeys), /不可枚举/)
})

test('宿主 5 个事件订阅都必须带 { global: true }（不带就被作用域过滤挡掉）', () => {
  const source = readFileSync(HOST, 'utf8')
  for (const eventName of ['agent/status', 'agent/error', 'approval/request', 'user-questions/request', 'session/disposed']) {
    const escaped = eventName.replace(/[/.]/g, '\\$&')
    const re = new RegExp(`ctx\\.on\\('${escaped}'[\\s\\S]{0,2600}?\\}, GLOBAL\\)`)
    assert.equal(re.test(source), true, `${eventName} 必须以 }, GLOBAL) 结尾`)
  }
})

test('每个处理器都必须有 try/catch（waterfall 里抛错会被发射方吞掉、彻底无声）', () => {
  const source = readFileSync(HOST, 'utf8')
  const guards = source.match(/绝不外抛/g) ?? []
  assert.equal(guards.length >= 5, true, `应当有 5 处兜底（每类事件一处），实际 ${guards.length} 处`)
})

test('先写日志再 dispatch：两个 waterfall 事件的日志必须在 dispatch 之前', () => {
  const source = readFileSync(HOST, 'utf8')
  for (const [eventName, logLine] of [['approval/request', 'approval session='], ['user-questions/request', 'user-questions 处理失败']]) {
    const handlerStart = source.indexOf(`ctx.on('${eventName}'`)
    assert.notEqual(handlerStart, -1, `${eventName} 订阅应当存在`)
    const body = source.slice(handlerStart, handlerStart + 2600)
    const logAt = body.indexOf(eventName === 'approval/request' ? logLine : '${kind} session=')
    const dispatchAt = body.indexOf("type: 'pending'")
    assert.notEqual(logAt, -1, `${eventName} 应当有日志行`)
    assert.notEqual(dispatchAt, -1, `${eventName} 应当 dispatch pending`)
    assert.equal(logAt < dispatchAt, true, `${eventName} 的日志必须在 dispatch 之前（dispatch 抛错也要留痕）`)
  }
})
