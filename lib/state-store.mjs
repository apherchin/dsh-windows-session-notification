/**
 * state-store —— 未读的落盘与恢复（spec §5.5 / D7）。
 * 只持久化未读映射；`running` / `lastError` 不恢复（重启后已失真）。
 * 写入走"临时文件 + rename"以保证原子性。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VALID = new Set(['done', 'error', 'pending'])

/**
 * 原子保存未读映射。
 * @param {string} file - 目标文件。
 * @param {Map<string, string>} unread - 未读映射。
 */
export function saveUnread(file, unread) {
  if (!(unread instanceof Map)) return
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ unread: Object.fromEntries(unread) }), 'utf8')
    renameSync(tmp, file)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort */
    }
  }
}

/**
 * 读取未读映射；缺失/损坏/非法值一律安全降级。
 * @param {string} file - 源文件。
 * @returns {Map<string, string>} 未读映射。
 */
export function loadUnread(file) {
  const out = new Map()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const raw = parsed?.unread
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
    for (const [id, reason] of Object.entries(raw)) {
      if (typeof reason === 'string' && VALID.has(reason)) out.set(id, reason)
    }
  } catch {
    /* 缺失或损坏 → 空表 */
  }
  return out
}
