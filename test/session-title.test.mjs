// session-title：从会话投影缓存里读"用户认得出的会话标题"的单元测试。
// 由来（2026-09-26 用户截图）：toast 第二行只剩 id 片段（`session-` / `a52e5e8e`），用户认不出是哪个会话。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pickTitleFromProjection, readSessionTitle } from '../lib/session-title.mjs'

/** 真实投影文件的头部形状（取自本机 session-e28cc635-…，2026-09-26）。 */
const REAL_HEAD = '{"version":7,"record":{"identity":{"formatVersion":4,"createdAt":1790340519215,'
  + '"cwd":"D:\\\\DSH\\\\Day1","isSeeded":false,"inheritedEventCount":0},"rows":{"title":{"ver":1,'
  + '"seq":1109,"val":"DSH提醒"},"titleInput":{"ver":3,"seq":1109,"val":{"first":{"seq":9,'
  + '"text":"DSH能不能打开侧边聊天？"}},"llmRetry":{"ver":1,"seq":1109,"val":{}}}}'

/** 写一个假的投影文件。 */
function fixture(title, id = 'session-abc') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attn-title-'))
  const root = path.join(dir, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(root, { recursive: true })
  const row = title === null ? '' : `"title":${JSON.stringify({ ver: 1, seq: 3, val: title })},`
  const body = `{"version":7,"record":{"identity":{},"rows":{${row}"llmRetry":{"ver":1,"seq":3,"val":{}}}}}`
  fs.writeFileSync(path.join(root, `${id}.json`), body)
  return { dir, file: path.join(root, `${id}.json`) }
}

test('从真实投影头部取出标题', () => {
  assert.equal(pickTitleFromProjection(REAL_HEAD), 'DSH提醒')
})

test('标题里的转义字符被正确还原', () => {
  const text = '{"rows":{"title":{"ver":1,"seq":2,"val":"带\\"引号\\"和\\\\反斜杠的标题"},}}'
  assert.equal(pickTitleFromProjection(text), '带"引号"和\\反斜杠的标题')
})

test('没有 title 行时回空串（不抛错）', () => {
  assert.equal(pickTitleFromProjection('{"rows":{"goal":{"ver":1,"seq":2,"val":{}}}}'), '')
  assert.equal(pickTitleFromProjection(''), '')
  assert.equal(pickTitleFromProjection(undefined), '')
})

test('别处出现的 "title" 不会被误当成会话标题', () => {
  // titleInput 的正文里出现 title 字样，但它没有 {ver,seq,val} 三件套
  const text = '{"rows":{"titleInput":{"ver":3,"seq":9,"val":{"text":"帮我改一下 title 字段"}}}}'
  assert.equal(pickTitleFromProjection(text), '')
})

test('val 不是合法 JSON 字符串时不抛错、回空串', () => {
  assert.equal(pickTitleFromProjection('{"title":{"ver":1,"seq":1,"val":"未闭合},}'), '')
})

test('readSessionTitle 从磁盘读标题', () => {
  const { dir } = fixture('会话删除功能')
  assert.equal(readSessionTitle(dir, 'session-abc'), '会话删除功能')
})

test('readSessionTitle 文件不存在时回空串', () => {
  const { dir } = fixture('x')
  assert.equal(readSessionTitle(dir, 'session-does-not-exist'), '')
})

test('readSessionTitle 内容不合法时回空串（不抛错）', () => {
  const { dir, file } = fixture(null)
  fs.writeFileSync(file, 'not json at all')
  assert.equal(readSessionTitle(dir, 'session-abc'), '')
})

test('readSessionTitle 只用文件头：后面跟大段内容也不受影响', () => {
  const { dir, file } = fixture('前面就有标题')
  fs.appendFileSync(file, `\n${'x'.repeat(200_000)}`)
  assert.equal(readSessionTitle(dir, 'session-abc'), '前面就有标题')
})

test('readSessionTitle 对空参数回空串', () => {
  assert.equal(readSessionTitle('', 'session-abc'), '')
  assert.equal(readSessionTitle('C:\\nope', ''), '')
  assert.equal(readSessionTitle(undefined, 'session-abc'), '')
})
