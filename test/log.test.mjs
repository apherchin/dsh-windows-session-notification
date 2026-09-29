import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, MAX_LOG_BYTES } from '../lib/log.mjs'

test('写入一行并带 ISO 时间戳', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-log-'))
  const file = join(dir, 'attention.log')
  const log = createLogger(file)
  log('hello')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /hello/)
  assert.match(text, /^\d{4}-\d{2}-\d{2}T/)
})

test('超过上限时截断并保留较新的一半（丢旧留新）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-log-'))
  const file = join(dir, 'attention.log')
  const half = Math.floor(MAX_LOG_BYTES / 2)
  writeFileSync(file, 'A'.repeat(half) + 'B'.repeat(half + 10))   // 总计 > 上限，触发轮转
  createLogger(file)('after-rotation')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('B'), '必须保留较新的一半')
  assert.equal(text.includes('A'), false, '较旧的一半必须被丢掉')
  assert.ok(text.endsWith('after-rotation\n'))
})

test('写失败不抛异常（best-effort）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-log-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const target = join(blocker, 'a.log') // 父路径是文件 → 目录创建必失败
  const log = createLogger(target)
  assert.doesNotThrow(() => log('x'))
  assert.equal(existsSync(target), false)
})

test('恰好等于上限时不截断（仅在超过时轮转）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attn-log-'))
  const file = join(dir, 'attention.log')
  writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES))
  createLogger(file)('tail')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('x'.repeat(MAX_LOG_BYTES)))   // 原有的 x 一个都没被截掉
  assert.ok(text.endsWith('tail\n'))
})
