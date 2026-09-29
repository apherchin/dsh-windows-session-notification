import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveUnread, loadUnread } from '../lib/state-store.mjs'

test('保存后能读回未读映射', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'attn-store-')), 'state.json')
  saveUnread(file, new Map([['A', 'done'], ['B', 'pending']]))
  const back = loadUnread(file)
  assert.equal(back.get('A'), 'done')
  assert.equal(back.get('B'), 'pending')
})

test('文件不存在时返回空 Map', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'attn-store-')), 'missing.json')
  assert.equal(loadUnread(file).size, 0)
})

test('文件损坏时返回空 Map 且不抛', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'attn-store-')), 'bad.json')
  writeFileSync(file, '{not json')
  assert.equal(loadUnread(file).size, 0)
})

test('写入后不残留 .tmp，且内容是可解析的完整 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-store-'))
  const file = join(dir, 'state.json')
  saveUnread(file, new Map([['A', 'done']]))
  const text = readFileSync(file, 'utf8')
  assert.deepEqual(JSON.parse(text), { unread: { A: 'done' } })
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
})

test('非法理由值被丢弃', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'attn-store-')), 'state.json')
  writeFileSync(file, JSON.stringify({ unread: { A: 'bogus', B: 'done' } }))
  const back = loadUnread(file)
  assert.equal(back.has('A'), false)
  assert.equal(back.get('B'), 'done')
})

test('写入目标目录不存在时会自动创建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-store-'))
  const file = join(dir, 'nested', 'deep', 'state.json')
  saveUnread(file, new Map([['A', 'error']]))
  assert.equal(loadUnread(file).get('A'), 'error')
})

test('unread 结构不对（数组 / null / 数字）一律降级为空 Map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-store-'))
  const cases = [['done', 'error'], null, 42]
  for (const [index, bad] of cases.entries()) {
    const file = join(dir, `bad-${index}.json`)
    writeFileSync(file, JSON.stringify({ unread: bad }))
    assert.equal(loadUnread(file).size, 0)
  }
})

test('文件根节点不是对象时也降级为空 Map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-store-'))
  const cases = ['null', '42', '"hello"', '[1,2]']
  for (const [index, body] of cases.entries()) {
    const file = join(dir, `root-${index}.json`)
    writeFileSync(file, body)
    assert.equal(loadUnread(file).size, 0)
  }
})

test('saveUnread 遇到不可写目标时不抛异常（best-effort）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-store-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  assert.doesNotThrow(() => saveUnread(join(blocker, 'state.json'), new Map([['A', 'done']])))
})

test('saveUnread 传入非 Map 时不抛且不写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-store-'))
  const file = join(dir, 'state.json')
  assert.doesNotThrow(() => saveUnread(file, [['A', 'done']]))
  assert.equal(existsSync(file), false)
})
