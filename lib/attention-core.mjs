/**
 * attention-core —— 本插件的**全部判断逻辑**，纯函数、无 IO、无定时器。
 *
 * 设计要点（对应 spec §5，2026-09-26 修订）：
 *  - 唯一决策点：宿主侧算一次，"该不该提醒 / 角标显示几"都出自这里。
 *  - `viewing` 由 client 上报；**窗口不可见/失焦时必须上报 null**，否则最小化时最后一个会话
 *    跑完了反而不会提醒（spec 自检抓出的缺陷）。
 *  - 未读 = 「你还没看到」：正看着该会话时不计入；切走后若仍 pending 会重新计入。
 *  - 完成提醒**按 tick 粒度合并**：宿主每秒 tick 一次，tick 时把缓冲取空——
 *    ≥ MERGE_THRESHOLD 个完成合并成一条汇总，否则逐个单发（**不等待**，保证提醒及时）。
 *    `pending` 永不合并（它要求动作，必须逐个可点）。
 */

/** tick 缓冲里达到这个数量的完成数就合并成一条。 */
export const MERGE_THRESHOLD = 3

/**
 * 幽灵未读的宽限期：会话条目 `updatedAt` 在这个时间内的，即使宿主判定"目录不存在"也不剪
 * （新会话的日志目录可能还没落地，宁可晚一轮也不要误剪）。
 */
export const PRUNE_GRACE_MS = 30_000

/** 要求用户动作的交互类未读；这些提醒在"用户已应答/交互作废"时必须撤销。 */
const INTERACTION_REASONS = new Set(['approval', 'question', 'plan-review'])

/**
 * 撤销某会话已排队的**交互类**提醒（approval / question / plan-review）。
 * 刻意**不**撤销 `'error'`：错误提醒不应被"agent 重新开跑"吞掉。
 * @param {ReturnType<typeof initialState>} state - 状态。
 * @param {string} sessionId - 会话 id。
 */
function clearQueuedInteraction(state, sessionId) {
  const reason = state.queuedPending.get(sessionId)
  if (reason !== undefined && INTERACTION_REASONS.has(reason)) state.queuedPending.delete(sessionId)
}

/**
 * 把"仍未处理的交互"重新计入未读（D5：切走后若仍未处理，要重新计入）。
 * 只看 `sessions` 里 `pending !== null` 的条目；**跳过当前正在查看的会话**；
 * 只补未读计数，**不重新排队提醒**——用户看着它时提示框已经看到了，重复弹是噪音。
 * @param {ReturnType<typeof initialState>} state - 状态。
 */
function rearmPendingUnread(state) {
  for (const [sessionId, entry] of state.sessions) {
    if (sessionId === state.viewing) continue
    if (entry.pending !== null && !state.unread.has(sessionId)) state.unread.set(sessionId, 'pending')
  }
}

/**
 * @returns 一份全新的空状态。
 */
export function initialState() {
  return {
    /**
     * 会话条目形状固定为这四个字段（没有 `title`：core 从不读写它）。
     * @type {Map<string, { running: boolean, pending: string|null, lastError: string|null, updatedAt: number }>}
     */
    sessions: new Map(),
    /** 当前正在被查看的会话；null 表示没在看任何会话（窗口不可见/失焦）。 */
    viewing: null,
    /** @type {Map<string, 'done'|'error'|'pending'>} 未读原因。 */
    unread: new Map(),
    /** @type {Set<string>} 等待下一个 tick 取走的"完成"缓冲（只收完成，合并判定见 tick）。 */
    pendingDone: new Set(),
    /**
     * 已在排队、等待下一个 tick 逐个发出的即时提醒（交互类与 error）。
     * 值域是**交互 kind 白名单**（`'approval'` / `'question'` / `'plan-review'`）或字面量 `'error'`；
     * **宿主不得把交互 kind 发成 `'error'`**，否则该交互提醒将永不被"用户已应答"撤销
     * （`clearQueuedInteraction` 刻意不撤销 `'error'`）。
     * @type {Map<string, string>}
     */
    queuedPending: new Map(),
  }
}

/**
 * 深一层复制状态（Map/Set 重建、会话条目逐条浅拷贝），保证 `reduce` 不改 `prev`。
 * @param {ReturnType<typeof initialState>} prev - 旧状态。
 * @returns {ReturnType<typeof initialState>} 新状态。
 */
function cloneState(prev) {
  return {
    sessions: new Map([...prev.sessions].map(([id, v]) => [id, { ...v }])),
    viewing: prev.viewing,
    unread: new Map(prev.unread),
    pendingDone: new Set(prev.pendingDone),
    queuedPending: new Map(prev.queuedPending),
  }
}

/**
 * 取会话条目，不存在则原地创建。
 * @param {ReturnType<typeof initialState>} state - 状态。
 * @param {string} sessionId - 会话 id。
 * @returns 会话条目。
 */
function sessionOf(state, sessionId) {
  let entry = state.sessions.get(sessionId)
  if (entry === undefined) {
    entry = { running: false, pending: null, lastError: null, updatedAt: 0 }
    state.sessions.set(sessionId, entry)
  }
  return entry
}

/**
 * 产生角标动作：新契约只有 `count`（= 未读会话数）。
 * @param {ReturnType<typeof initialState>} state - 状态。
 * @returns {{ kind: 'badge', count: number }} 角标动作。
 */
function badgeAction(state) {
  return { kind: 'badge', count: state.unread.size }
}

/**
 * 归约一个事件。
 * @param {ReturnType<typeof initialState>} prev - 旧状态（不会被修改）。
 * @param {{ type: string, sessionId?: string|null, at: number, [key: string]: unknown }} event - 归一化事件。
 * @returns {{ state: ReturnType<typeof initialState>, actions: object[] }} 新状态与要执行的动作。
 */
export function reduce(prev, event) {
  const state = cloneState(prev)

  const actions = []
  const at = event.at

  switch (event.type) {
    case 'running': {
      const s = sessionOf(state, event.sessionId)
      const wasRunning = s.running
      s.running = event.running === true
      s.updatedAt = at
      if (wasRunning && !s.running) {
        // 完成 ⇒ 该会话此前的待处理交互一律作废（无论当时是否在查看它）
        s.pending = null
        clearQueuedInteraction(state, event.sessionId)
        if (event.sessionId !== state.viewing) {
          state.unread.set(event.sessionId, state.unread.get(event.sessionId) === 'error' ? 'error' : 'done')
          state.pendingDone.add(event.sessionId)
        }
        actions.push(badgeAction(state))
      } else if (s.running) {
        s.pending = null
        clearQueuedInteraction(state, event.sessionId)
        if (state.unread.get(event.sessionId) === 'pending') state.unread.delete(event.sessionId)
        // agent 又跑起来了 ⇒ 之前缓冲的"完成"提醒已过期，丢掉
        state.pendingDone.delete(event.sessionId)
        actions.push(badgeAction(state))
      }
      break
    }
    case 'error': {
      const s = sessionOf(state, event.sessionId)
      s.lastError = String(event.message ?? '')
      s.updatedAt = at
      // 正看着它 ⇒ 不计未读、不排队（D2）；spec §5.2 的 error 映射同样以 ≠viewing 为前提。
      if (event.sessionId !== state.viewing) {
        state.unread.set(event.sessionId, 'error')
        state.queuedPending.set(event.sessionId, 'error')
      }
      actions.push(badgeAction(state))
      break
    }
    case 'pending': {
      const s = sessionOf(state, event.sessionId)
      s.pending = String(event.kind)
      s.updatedAt = at
      if (event.sessionId !== state.viewing) {
        state.unread.set(event.sessionId, 'pending')
        state.queuedPending.set(event.sessionId, String(event.kind))
      }
      actions.push(badgeAction(state))
      break
    }
    case 'pending-cleared': {
      const s = state.sessions.get(event.sessionId)
      if (s !== undefined) s.pending = null
      if (state.unread.get(event.sessionId) === 'pending') state.unread.delete(event.sessionId)
      state.queuedPending.delete(event.sessionId)
      actions.push(badgeAction(state))
      break
    }
    case 'viewing': {
      const next = event.sessionId ?? null
      state.viewing = next
      if (next !== null) {
        // 正在看它 ⇒ 不该再弹它的提醒（D2）：未读与两个队列一并清掉。
        state.unread.delete(next)
        state.queuedPending.delete(next)
        state.pendingDone.delete(next)
      }
      // 无论切到别的会话还是切到 null，被留下的会话若仍 pending 就重新计入未读（D5）。
      // rearmPendingUnread 内部跳过 state.viewing，所以 next 自己不会被补回。
      rearmPendingUnread(state)
      actions.push(badgeAction(state))
      break
    }
    case 'disposed': {
      state.sessions.delete(event.sessionId)
      state.unread.delete(event.sessionId)
      state.pendingDone.delete(event.sessionId)
      state.queuedPending.delete(event.sessionId)
      actions.push(badgeAction(state))
      break
    }
    case 'prune': {
      // 会话已经不存在了（被删除/被清理）：把它的痕迹全部摘掉。
      // 为什么必须有这条：未读集合是**持久化**的，而摘除只发生在 `disposed` 事件里；会话在插件没跑的时候
      // 被删掉（或删除走的是别的路径）就会留下**永远清不掉的幽灵未读** —— 2026-09-26 实测：任务栏角标
      // 被一条已删除会话钉死在 "1"，用户点遍所有会话都不变。宿主定期检查存在性后派发本事件。
      const stale = Array.isArray(event.sessionIds) ? event.sessionIds : []
      let changed = false
      for (const sessionId of stale) {
        const known = state.sessions.get(sessionId)
        // 宽限：刚动过的会话先不动（目录可能还没落地）。
        if (known !== undefined && Number.isFinite(known.updatedAt) && at - known.updatedAt < PRUNE_GRACE_MS) continue
        if (state.sessions.delete(sessionId)) changed = true
        if (state.unread.delete(sessionId)) changed = true
        if (state.pendingDone.delete(sessionId)) changed = true
        if (state.queuedPending.delete(sessionId)) changed = true
      }
      if (changed) actions.push(badgeAction(state))
      break
    }
    case 'tick': {
      // 先发所有 queued 的 pending（永不合并）
      for (const [sessionId, reason] of state.queuedPending) {
        actions.push({ kind: 'toast', reason, sessionId })
      }
      state.queuedPending.clear()

      // tick 一到就把缓冲取空：≥ 阈值合并成一条，否则逐个单发（不等待）。
      // 攒批粒度 = tick 粒度（宿主 tick 周期 1s），状态机不认识定时器。
      const buffered = [...state.pendingDone.entries()]
      if (buffered.length > 0) {
        if (buffered.length >= MERGE_THRESHOLD) {
          actions.push({ kind: 'toast', reason: 'done-merged', count: buffered.length })
        } else {
          for (const [sessionId] of buffered) actions.push({ kind: 'toast', reason: 'done', sessionId })
        }
        state.pendingDone.clear()
      }
      break
    }
    default:
      break
  }

  return { state, actions }
}
