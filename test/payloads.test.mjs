import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { buildToastPayload, buildBadgeState, SOUNDS, XML_ESCAPES, escapeXml } from '../lib/payloads.mjs'

test('三档音效都指向系统自带 wav（不依赖自制资产）', () => {
  for (const kind of ['pending', 'done', 'error']) {
    assert.match(SOUNDS[kind], /^[A-Za-z]:\\Windows\\Media\\/i)
    assert.match(SOUNDS[kind], /\.wav$/i)
  }
  for (const kind of ['pending', 'done', 'error']) {
    assert.equal(existsSync(SOUNDS[kind]), true, `${kind} 的音效文件必须真实存在`)
  }
})

test('toast 载荷携带 launch / 标题 / 音效 / 会话 id（交互类 reason）', () => {
  const p = buildToastPayload({
    reason: 'approval', sessionId: 'S1', title: '修 bug', detail: '',
    logFile: 'C:\\Users\\x\\.dsh\\dsh-attention\\attention.log',
  })
  assert.equal(p.launch, 'dsh-attention:open/S1')
  assert.equal(p.sound, SOUNDS.pending)
  assert.match(p.line1, /审批/)
  assert.ok(p.line2.includes('修 bug'))
  assert.equal(p.logFile.endsWith('attention.log'), true)
})

test('错误档用 error 音效与对应标题', () => {
  const p = buildToastPayload({ reason: 'error', sessionId: 'S1', title: 't', logFile: 'C:\\x\\attention.log' })
  assert.equal(p.sound, SOUNDS.error)
  assert.match(p.line1, /出错/)
})

test('合并载荷不带 sessionId，launch 指向前台', () => {
  const p = buildToastPayload({ reason: 'done-merged', count: 3, logFile: 'C:\\x\\attention.log' })
  assert.equal(p.launch, 'dsh-attention:focus')
  assert.match(p.line1, /3/)
})

test('done-merged 缺少 count 时不出现 undefined', () => {
  const p = buildToastPayload({ reason: 'done-merged', logFile: 'C:\\x\\attention.log' })
  assert.equal(p.line1.includes('undefined'), false)
  assert.match(p.line1, /0 个会话已完成/)
})

test('标题缺失时回退到会话 id 前缀，不出现 undefined', () => {
  const p = buildToastPayload({ reason: 'done', sessionId: 'abcdef123456', title: '', logFile: 'C:\\x\\attention.log' })
  assert.equal(p.line2.includes('undefined'), false)
  assert.equal(p.line2.includes('abcdef12'), true)
})

test('回退显示不能退化成 "session-"（真实 id 形状，2026-09-26 用户实测的 bug）', () => {
  const p = buildToastPayload({
    reason: 'done',
    sessionId: 'session-e28cc635-b153-4c83-8a42-009c323d3477',
    title: '',
    logFile: 'C:\\x\\attention.log',
  })
  assert.equal(p.line2.includes('e28cc635'), true, '应当取 `session-` 之后那段有区分度的 id')
  assert.equal(p.line2.startsWith('session-'), false, '整行只有一个 "session-" 前缀等于没有信息')
  assert.equal(p.line2.includes('undefined'), false)
})

test('标题为空字符串/只有空白时也走回退，不显示空行', () => {
  const p = buildToastPayload({ reason: 'done', sessionId: 'session-9b09fa88-4cb6-4692-8dbb-9ad4579ca5d5', title: '   ', logFile: 'x' })
  assert.equal(p.line2.includes('9b09fa88'), true)
})

test('没有标题也没有 id 时给出兜底文案', () => {
  const p = buildToastPayload({ reason: 'done', logFile: 'x' })
  assert.equal(p.line2.trim().length > 0, true)
  assert.equal(p.line2.includes('undefined'), false)
})

test('badge 状态只落 count（R6 契约）', () => {
  const b = buildBadgeState({ kind: 'badge', count: 4 })
  assert.deepEqual(Object.keys(b).sort(), ['count', 'updatedAt'])
  assert.equal(b.count, 4)
})

test('buildBadgeState 缺少 count 时兜底为 0 且键仍在', () => {
  const b = buildBadgeState({ kind: 'badge' })
  assert.equal(b.count, 0)
  assert.deepEqual(Object.keys(b).sort(), ['count', 'updatedAt'])
})

test('escapeXml 覆盖五个必需实体', () => {
  assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;')
  assert.equal(XML_ESCAPES.length, 5)
})

test('escapeXml 先转义 & 再转义其它，避免二次转义', () => {
  assert.equal(escapeXml('&lt;'), '&amp;lt;')
})

test('载荷与角标状态都能无损往返 JSON', () => {
  const p = buildToastPayload({ reason: 'error', sessionId: 'S', title: 't', detail: 'd', logFile: 'C:\\x\\attention.log' })
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
  const b = buildBadgeState({ kind: 'badge', count: 2 })
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b)
  assert.equal(typeof b.updatedAt, 'number')
})

test('完成类 reason 用 done 档音效，且 line3 为空', () => {
  const single = buildToastPayload({ reason: 'done', sessionId: 'S1', title: 't', logFile: 'C:\\x\\attention.log' })
  assert.equal(single.sound, SOUNDS.done)
  assert.equal(single.line3, '')
  assert.match(single.line1, /完成/)
  const merged = buildToastPayload({ reason: 'done-merged', count: 3, logFile: 'C:\\x\\attention.log' })
  assert.equal(merged.sound, SOUNDS.done)
  assert.equal(merged.line3, '')
})

test('交互类 reason 给出对应短标签，detail 非空时以 · 追加', () => {
  const labels = { approval: '等待审批', question: '等待回答', 'plan-review': '计划待审' }
  for (const [reason, label] of Object.entries(labels)) {
    const p = buildToastPayload({ reason, sessionId: 'S1', title: '标题', detail: '补充', logFile: 'C:\\x\\attention.log' })
    assert.equal(p.line3, label)
    assert.ok(p.line2.includes('标题'))
    assert.ok(p.line2.includes(' · 补充'))
    assert.ok(p.line1.length > 0)
    assert.notEqual(p.line1, 'DSH 提醒')
  }
})
