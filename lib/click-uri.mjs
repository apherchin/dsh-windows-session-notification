/**
 * click-uri —— 解析协议回调写进 clicks.log 的行。
 * 独立成纯函数是为了可单测：协议 handler 的 %1 展开可能带引号，
 * 而真实 sessionId 是 UUID，带引号会让 openSession 失败。
 */

/** 允许的动词。 */
const VERBS = new Set(['open', 'dismiss', 'focus'])

/**
 * 从一行日志里解析出点击意图。
 * @param {string} line - clicks.log 的一行。
 * @returns {{ verb: 'open'|'dismiss'|'focus', sessionId: string|undefined }|null} 解析结果；无法识别则 null。
 */
export function parseClickLine(line) {
  // 协议 handler 的 %1 展开后可能带引号，故 id 遇到空白或引号即止；再统一清洗尾随引号。
  const match = /dsh-attention:(open|dismiss|focus)(?:\/([^\s"']+))?/.exec(String(line ?? ''))
  if (match === null) return null
  const verb = match[1]
  if (!VERBS.has(verb)) return null
  const rawId = match[2]
  const sessionId = rawId === undefined ? undefined : rawId.replace(/["']+$/, '')
  if (sessionId !== undefined && sessionId === '') return { verb, sessionId: undefined }
  return { verb, sessionId }
}
