/**
 * payloads —— 纯函数：把"要提醒什么"变成 PowerShell 出口能吃的载荷。
 * 不做任何 IO；spawn 在 win-notify.mjs 里（后续 Task）。
 *
 * 音效用 Windows 自带 wav（本机实测存在），因此插件**不需要自带音频资产**。
 */

/** 三档音效 → 系统自带 wav。 */
export const SOUNDS = Object.freeze({
  pending: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  done: 'C:\\Windows\\Media\\notify.wav',
  error: 'C:\\Windows\\Media\\Windows Critical Stop.wav',
})

/** XML 需要转义的五个实体。 */
export const XML_ESCAPES = Object.freeze([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
])

/**
 * 转义 XML 文本。
 * @param {unknown} value - 任意值。
 * @returns {string} 转义后的文本。
 */
export function escapeXml(value) {
  let out = String(value ?? '')
  for (const [from, to] of XML_ESCAPES) out = out.split(from).join(to)
  return out
}

// ⚠️ 取值域必须与 attention-core 实际发出的 reason 严格一致：
// R1/R4 之后交互类发的是**具体 kind**（approval / question / plan-review），不存在笼统的 'pending'。
const TITLES = Object.freeze({
  approval: 'DSH 等待审批',
  question: 'DSH 等待回答',
  'plan-review': 'DSH 计划待审',
  done: 'DSH 任务完成',
  error: 'DSH 出错了',
})

/** 交互类 reason → 第三行短标签。 */
const REASON_LABEL = Object.freeze({
  approval: '等待审批',
  question: '等待回答',
  'plan-review': '计划待审',
})

/**
 * 会话标题的回退显示：优先用标题；没有标题时用"去掉 `session-` 前缀后的前 8 位"。
 *
 * ⚠️ 不能直接 `slice(0, 8)`：本机会话 id 形如 `session-e28cc635-b153-4c83-8a42-…`，
 * 前 8 位恰好就是 `session-` —— 2026-09-26 用户实测 toast 第二行只显示 `session-`，
 * 等于什么信息都没有。去掉前缀后再取，才拿到那段有区分度的 id。
 * @param {string} sessionId - 会话 id。
 * @param {string} title - 会话标题（可能为空）。
 * @returns {string} 显示用名称。
 */
function displayName(sessionId, title) {
  const t = String(title ?? '').trim()
  if (t !== '') return t
  const raw = String(sessionId ?? '').trim()
  if (raw === '') return '会话'
  const stripped = raw.replace(/^session-/i, '')
  return `${(stripped === '' ? raw : stripped).slice(0, 8)}…`
}

/**
 * 构造 toast 载荷（字段约定见后续 Task 的 scripts/toast.ps1）。
 * @param {{ reason: string, sessionId?: string, title?: string, detail?: string, count?: number, logFile: string }} input - 提醒内容。
 * @returns {object} 载荷对象。
 */
export function buildToastPayload(input) {
  const { reason, sessionId, title = '', detail = '', count, logFile } = input
  const merged = reason === 'done-merged'
  const total = Number.isFinite(count) ? count : 0
  const launch = merged ? 'dsh-attention:focus' : `dsh-attention:open/${sessionId}`
  const soundKey = reason === 'error' ? 'error' : reason === 'done' || merged ? 'done' : 'pending'
  const line1 = merged ? `${total} 个会话已完成` : (Object.hasOwn(TITLES, reason) ? TITLES[reason] : 'DSH 提醒')
  const line2 = merged
    ? '点击回到 DSH'
    : `${displayName(sessionId, title)}${detail === '' ? '' : ` · ${detail}`}`
  const line3 = merged ? '' : (Object.hasOwn(REASON_LABEL, reason) ? REASON_LABEL[reason] : '')
  return { line1, line2, line3, sound: SOUNDS[soundKey], launch, logFile }
}

/**
 * 构造角标状态文件的内容（badge.ps1 轮询它）。
 * 契约（R6 收敛）：角标动作只有 `{ kind:'badge', count }` 一个数字。
 * @param {{ count: number }} badge - 角标动作。
 * @returns {{ count: number, updatedAt: number }} 落盘对象。
 */
export function buildBadgeState(badge) {
  return { count: Number.isFinite(badge.count) ? badge.count : 0, updatedAt: Date.now() }
}
