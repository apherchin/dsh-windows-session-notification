/**
 * session-title —— 从会话投影缓存里读"用户认得出的会话标题"（**宿主侧**来源）。
 *
 * 为什么需要它：toast 原来只能退化成 id 片段（`session-` / `a52e5e8e`），用户根本认不出是哪个会话
 * （2026-09-26 用户截图实证："新的提醒只有一串数字，这个哪有看得懂的"）。client 上报标题那条路
 * 依赖槽位探针（还没跑通），不能作为唯一来源。
 *
 * 数据位置（本机 2026-09-26 实测）：`$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`
 *
 *   { "version": 7, "record": { "identity": {...},
 *       "rows": { "title": { "ver": 1, "seq": 1109, "val": "DSH提醒" }, ... } } }
 *
 * 实测：文件 0.02–0.11 MB，`title` 行位于 `rows` 最前面 ⇒ 只读**文件头**再用正则取，
 * 避免整份 JSON.parse（长会话的投影可能很大）。
 *
 * ⚠️ 这是**应用私有布局**，版本升级可能变 ⇒ 全程 try/catch，形状不符就回空串，
 * 由调用方回退到别处（client 上报 / id 片段）。
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** 读文件头多少字节（标题行在最前面，64KB 足够）。 */
const HEAD_BYTES = 65536

/**
 * 投影里 title 行的形状：`"title":{"ver":1,"seq":1109,"val":"…"}`。
 * 用 `ver/seq/val` 三件套锚定，避免误命中别处的 `"title"`（例如 titleInput 里的正文）。
 */
const TITLE_ROW = /"title"\s*:\s*\{\s*"ver"\s*:\s*\d+\s*,\s*"seq"\s*:\s*\d+\s*,\s*"val"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * 从投影文本里取标题（纯函数，便于测试）。
 * @param {string} text - 投影 JSON 的文本（允许是被截断的文件头）。
 * @returns {string} 标题；取不到回空串。
 */
export function pickTitleFromProjection(text) {
  const match = String(text ?? '').match(TITLE_ROW)
  if (match === null) return ''
  try {
    const value = JSON.parse(`"${match[1]}"`)
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 读某个会话的标题。
 * @param {string} homeDir - `$DSH_HOME`（形如 `C:\Users\x\.dsh`）。
 * @param {string} sessionId - 会话 id（形如 `session-<uuid>` 或裸 `<uuid>`）。
 * @returns {string} 标题；取不到回空串。
 */
export function readSessionTitle(homeDir, sessionId) {
  if (typeof homeDir !== 'string' || homeDir === '') return ''
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const file = join(homeDir, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  let handle
  try {
    if (!existsSync(file)) return ''
    handle = openSync(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(handle, buffer, 0, HEAD_BYTES, 0)
    return pickTitleFromProjection(buffer.subarray(0, read).toString('utf8'))
  } catch {
    return ''
  } finally {
    if (handle !== undefined) {
      try { closeSync(handle) } catch { /* 关不掉也不影响结果 */ }
    }
  }
}
