import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouteTable, FOCUS_PATH, PENDING_PATH, STATE_PATH, OPENED_PATH } from '../lib/routes.mjs'

function makeHooks() {
  const calls = []
  return {
    calls,
    setViewing: (id, title) => calls.push(['viewing', id, title]),
    reportPending: (pending) => calls.push(['pending', pending]),
    ackOpen: () => calls.push(['ackOpen']),
    snapshot: () => ({ unread: { A: 'done' }, openRequest: null }),
  }
}

test('四条路由都注册了正确的 path 与 method', () => {
  const table = createRouteTable(makeHooks())
  assert.deepEqual(Object.keys(table).sort(), [FOCUS_PATH, OPENED_PATH, PENDING_PATH, STATE_PATH].sort())
  assert.deepEqual(table[FOCUS_PATH].methods, ['POST'])
  assert.deepEqual(table[PENDING_PATH].methods, ['POST'])
  assert.deepEqual(table[STATE_PATH].methods, ['GET'])
  assert.deepEqual(table[OPENED_PATH].methods, ['POST'])
})

test('pending 路由透传 {sessionId, kind, keys}', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  const res = await table[PENDING_PATH].fetch(new Request('http://x/', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-1', kind: 'approval', keys: '[agent]' }),
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(hooks.calls[0], ['pending', { sessionId: 'session-1', kind: 'approval', keys: '[agent]' }])
})

test('pending 路由：缺 sessionId 归 null、缺 kind 归 question、坏 JSON 得 400', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  await table[PENDING_PATH].fetch(new Request('http://x/', { method: 'POST', body: JSON.stringify({}) }))
  assert.deepEqual(hooks.calls[0], ['pending', { sessionId: null, kind: 'question', keys: '' }])
  const bad = await table[PENDING_PATH].fetch(new Request('http://x/', { method: 'POST', body: '{oops' }))
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { ok: false, code: 'BAD_JSON' })
})

test('focus 路由解析 sessionId=null（窗口失焦）并透传标题', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  const res = await table[FOCUS_PATH].fetch(new Request('http://x/', {
    method: 'POST',
    body: JSON.stringify({ sessionId: null }),
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(hooks.calls[0], ['viewing', null, ''])
})

test('focus 路由：sessionId 为字符串时原样透传，title 缺失回退空串', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  await table[FOCUS_PATH].fetch(new Request('http://x/', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'S1', title: '标题' }),
  }))
  assert.deepEqual(hooks.calls[0], ['viewing', 'S1', '标题'])
})

test('focus 路由：坏 JSON 返回 400 且不调用 hooks', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  const res = await table[FOCUS_PATH].fetch(new Request('http://x/', { method: 'POST', body: '{bad' }))
  assert.equal(res.status, 400)
  assert.equal(hooks.calls.length, 0)
})

test('state 路由返回 snapshot', async () => {
  const table = createRouteTable(makeHooks())
  const res = await table[STATE_PATH].fetch(new Request('http://x/'))
  assert.deepEqual(await res.json(), { unread: { A: 'done' }, openRequest: null })
})

test('opened 路由确认并清掉打开的请求', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  const res = await table[OPENED_PATH].fetch(new Request('http://x/', { method: 'POST', body: '{}' }))
  assert.equal(res.status, 200)
  assert.deepEqual(hooks.calls, [['ackOpen']])
})

test('三条路由都带 JSON content-type', async () => {
  const table = createRouteTable(makeHooks())
  for (const path of [FOCUS_PATH, STATE_PATH, OPENED_PATH]) {
    const req = path === STATE_PATH
      ? new Request('http://x/')
      : new Request('http://x/', { method: 'POST', body: '{}' })
    const res = await table[path].fetch(req)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  }
})

test('每条路由都声明了合法的 requestBody 与非空 methods（契约必需）', () => {
  const table = createRouteTable(makeHooks())
  for (const [path, route] of Object.entries(table)) {
    assert.ok(['buffered', 'streaming'].includes(route.requestBody), `${path} 的 requestBody 不合法`)
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `${path} 的 methods 为空`)
    assert.equal(typeof route.fetch, 'function', `${path} 缺 fetch`)
  }
})

test('pending 路由：kind 显式为 null 时原样透传（"已清除"语义），只有字段缺失才退化成 question', async () => {
  const hooks = makeHooks()
  const table = createRouteTable(hooks)
  await table[PENDING_PATH].fetch(new Request('http://x/', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-1', kind: null }),
  }))
  assert.deepEqual(hooks.calls[0], ['pending', { sessionId: 'session-1', kind: null, keys: '' }])
})
