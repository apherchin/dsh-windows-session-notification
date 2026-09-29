import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce, MERGE_THRESHOLD, PRUNE_GRACE_MS } from '../lib/attention-core.mjs'

const T0 = 1_000_000

test('初始状态为空', () => {
  const s = initialState()
  assert.equal(s.viewing, null)
  assert.equal(s.unread.size, 0)
})

test('非 viewing 会话跑完(running true->false) 计入未读 done 并请求 toast', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  const { state, actions } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 10 })
  s = state
  assert.equal(s.unread.get('A'), 'done')
  assert.equal(s.pendingDone.has('A'), true)          // 缓冲，等 tick 决定单发还是合并
  assert.equal(actions.filter((a) => a.kind === 'badge').length, 1)
})

test('viewing 的会话跑完不提醒、不计未读', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 + 5 }))
  const { state } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 10 })
  assert.equal(state.unread.get('A'), undefined)
  assert.equal(state.pendingDone.has('A'), false)
})

test('切走后再切回，未读被清零（打开即清零）', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 10 }))
  assert.equal(s.unread.get('A'), 'done')
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 + 20 }))
  assert.equal(s.unread.size, 0)
})

test('viewing 置 null（窗口失焦）后，同一会话跑完要提醒', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 }))
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: null, at: T0 + 1 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 + 2 }))
  const { state } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 3 })
  assert.equal(state.unread.get('A'), 'done')
})

test('出错：计入 error 未读，且不被 done 覆盖', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'A', message: 'boom', at: T0 }))
  assert.equal(s.unread.get('A'), 'error')
  assert.equal(s.pendingDone.has('A'), false)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 100 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast').map((a) => a.reason), ['error'])
})

test('待审批/提问：pending 不进入合并缓冲（要求动作，必须逐个可点）', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 }))
  assert.equal(s.unread.get('A'), 'pending')
  assert.equal(s.pendingDone.has('A'), false)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 100 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast').map((a) => a.reason), ['approval'])
})

test('pending-cleared 清掉 pending 与对应未读', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'question', at: T0 }))
  const { state } = reduce(s, { type: 'pending-cleared', sessionId: 'A', at: T0 + 1 })
  assert.equal(state.unread.get('A'), undefined)
})

test('tick：缓冲里 1~2 个完成 → 逐个单发', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 10 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'B', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'B', running: false, at: T0 + 20 }))
  const { state, actions } = reduce(s, { type: 'tick', at: T0 + 30 })
  const toasts = actions.filter((a) => a.kind === 'toast')
  assert.deepEqual(toasts.map((a) => a.sessionId).sort(), ['A', 'B'])
  assert.equal(state.pendingDone.size, 0)
})

test(`tick：窗口内达到 ${MERGE_THRESHOLD} 个完成 → 合并成一条`, () => {
  let s = initialState()
  for (const id of ['A', 'B', 'C']) {
    ;({ state: s } = reduce(s, { type: 'running', sessionId: id, running: true, at: T0 }))
    ;({ state: s } = reduce(s, { type: 'running', sessionId: id, running: false, at: T0 + 10 }))
  }
  const { state, actions } = reduce(s, { type: 'tick', at: T0 + 20 })
  const toasts = actions.filter((a) => a.kind === 'toast')
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].reason, 'done-merged')
  assert.equal(toasts[0].count, 3)
  assert.equal(state.unread.size, 3)      // 未读仍然 3 个，只是提醒合并
  assert.equal(state.pendingDone.size, 0)
})

test('tick：缓冲未满阈值 → 逐个单发', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 10 }))
  const { actions } = reduce(s, { type: 'tick', at: T0 + 30 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast').map((a) => a.sessionId), ['A'])
})

test('disposed 清掉会话与未读', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'A', message: 'x', at: T0 }))
  const { state } = reduce(s, { type: 'disposed', sessionId: 'A', at: T0 + 1 })
  assert.equal(state.unread.has('A'), false)
  assert.equal(state.sessions.has('A'), false)
})

test('badge 动作只给出 count', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 }))
  const { actions } = reduce(s, { type: 'error', sessionId: 'B', message: 'x', at: T0 + 1 })
  const badge = actions.filter((a) => a.kind === 'badge').at(-1)
  assert.equal(badge.count, 2)
  assert.deepEqual(Object.keys(badge).sort(), ['count', 'kind'])   // 契约收敛：不再有 pending/unread
})

test('未知 sessionId 的事件不炸', () => {
  const { state } = reduce(initialState(), { type: 'pending-cleared', sessionId: 'NOPE', at: T0 })
  assert.equal(state.unread.size, 0)
})

test('running:true（用户已应答）撤销已排队的交互提醒', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 }))
  assert.equal(s.queuedPending.get('A'), 'approval')
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 + 10 }))
  assert.equal(s.queuedPending.has('A'), false)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 100 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast' && a.reason === 'approval'), [])
})

test('error 排队不被 running:true 吞掉', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'A', message: 'boom', at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 + 10 }))
  assert.equal(s.queuedPending.get('A'), 'error')
  const { actions } = reduce(s, { type: 'tick', at: T0 + 100 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast').map((a) => a.reason), ['error'])
})

test('不可变性：reduce 不修改 prev', () => {
  let base = initialState()
  ;({ state: base } = reduce(base, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: base } = reduce(base, { type: 'error', sessionId: 'B', message: 'x', at: T0 + 1 }))
  ;({ state: base } = reduce(base, { type: 'pending', sessionId: 'C', kind: 'question', at: T0 + 2 }))

  const unread = [...base.unread.entries()].sort()
  const viewing = base.viewing
  const pendingDone = [...base.pendingDone].sort()
  const queuedPending = [...base.queuedPending.entries()].sort()
  const sessions = [...base.sessions.entries()].map(([id, v]) => [id, { ...v }]).sort()

  for (const entry of base.sessions.values()) Object.freeze(entry)
  Object.freeze(base)

  let s = base
  for (const event of [
    { type: 'running', sessionId: 'A', running: false, at: T0 + 10 },
    { type: 'error', sessionId: 'A', message: 'boom', at: T0 + 11 },
    { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 + 12 },
    { type: 'pending-cleared', sessionId: 'A', at: T0 + 13 },
    { type: 'viewing', sessionId: 'B', at: T0 + 14 },
    { type: 'disposed', sessionId: 'B', at: T0 + 15 },
    { type: 'tick', at: T0 + 16 },
  ]) {
    ;({ state: s } = reduce(s, event))
  }

  assert.deepEqual([...base.unread.entries()].sort(), unread)
  assert.equal(base.viewing, viewing)
  assert.deepEqual([...base.pendingDone].sort(), pendingDone)
  assert.deepEqual([...base.queuedPending.entries()].sort(), queuedPending)
  assert.deepEqual([...base.sessions.entries()].map(([id, v]) => [id, { ...v }]).sort(), sessions)
})

test('disposed 同时清掉两个缓冲', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 1 }))
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'A', message: 'boom', at: T0 + 2 }))
  assert.equal(s.pendingDone.size, 1)
  assert.equal(s.queuedPending.size, 1)
  const { state } = reduce(s, { type: 'disposed', sessionId: 'A', at: T0 + 3 })
  assert.equal(state.pendingDone.size, 0)
  assert.equal(state.queuedPending.size, 0)
})

test('viewing 清掉该会话已排队的交互提醒与完成缓冲', () => {
  let s = initialState()
  // pending(approval) 让 A 进 queuedPending；不经过 running:true，保证断言真正指向 R5-a
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 }))
  assert.equal(s.queuedPending.has('A'), true)
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 + 1 }))
  assert.equal(s.queuedPending.has('A'), false)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 2 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast'), [])
})

test('viewing 清掉该会话已缓冲的完成提醒', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 1 }))
  assert.equal(s.pendingDone.has('A'), true)
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 + 2 }))
  assert.equal(s.pendingDone.has('A'), false)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 3 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast'), [])
})

test('从“正在看”切走后，仍未处理的 pending 重新计入未读（且不重发提醒）', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 }))
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 + 1 }))
  assert.equal(s.unread.has('A'), false)                       // 看着它时不计未读
  const { state, actions } = reduce(s, { type: 'viewing', sessionId: 'B', at: T0 + 2 })
  s = state
  assert.equal(s.unread.get('A'), 'pending')                   // 切走后重新计入
  assert.deepEqual(actions.filter((a) => a.kind === 'toast'), [])  // 但不重发提醒
  assert.equal(s.sessions.get('A').pending, 'approval')        // pending 本身仍在（未处理）
})

// ——— R6-a：error 也受 viewing 守卫 ———
test('viewing(A) 时 error(A) 不计未读、不排队，下一 tick 无 toast', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 }))
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'A', message: 'boom', at: T0 + 1 }))
  assert.equal(s.unread.has('A'), false)          // 正看着它 ⇒ 角标不该被粘住
  assert.equal(s.queuedPending.has('A'), false)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 2 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast'), [])
})

// ——— R6-b：完成时作废 pending，防“切走重新计入”复活假 pending 未读 ———
test('viewing 期间完成也作废 pending，切走后不复活成假 pending 未读', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 + 1 }))
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'A', at: T0 + 2 }))
  assert.equal(s.unread.has('A'), false)
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 3 }))
  assert.equal(s.sessions.get('A').pending, null)  // 完成 ⇒ 该交互作废（不受 viewing 守卫影响）
  ;({ state: s } = reduce(s, { type: 'viewing', sessionId: 'B', at: T0 + 4 }))
  assert.equal(s.unread.has('A'), false)           // 不得复活成 pending 未读
})

// ——— 完成分支的队列清理（不经 viewing）———
test('完成（不经 viewing）撤掉该会话已排队的交互提醒', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'pending', sessionId: 'A', kind: 'approval', at: T0 + 1 }))
  assert.equal(s.queuedPending.get('A'), 'approval')
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 2 }))
  assert.equal(s.queuedPending.has('A'), false)
  assert.equal(s.sessions.get('A').pending, null)
  const { actions } = reduce(s, { type: 'tick', at: T0 + 3 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast' && a.reason === 'approval'), [])
})

// ——— R6-f：重新开跑丢弃过期的完成提醒 ———
test('running:true 清掉已缓冲的完成提醒', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 1 }))
  assert.equal(s.pendingDone.has('A'), true)
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 + 2 }))
  assert.equal(s.pendingDone.has('A'), false)
})

test('tick 空缓冲不产生 toast', () => {
  const { actions } = reduce(initialState(), { type: 'tick', at: T0 })
  assert.deepEqual(actions.filter((a) => a.kind === 'toast'), [])
})

test('连续两次 tick 幂等：第二次不产生 toast', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 1 }))
  const first = reduce(s, { type: 'tick', at: T0 + 2 })
  assert.equal(first.actions.filter((a) => a.kind === 'toast').length, 1)
  const second = reduce(first.state, { type: 'tick', at: T0 + 3 })
  assert.deepEqual(second.actions.filter((a) => a.kind === 'toast'), [])
})

test('未知事件类型不改状态', () => {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'A', message: 'x', at: T0 }))
  const { state } = reduce(s, { type: 'nope', at: T0 + 1 })
  assert.equal(state.unread.size, s.unread.size)
  assert.equal(state.sessions.size, s.sessions.size)
})

// ── prune：清掉"会话已经不存在"的幽灵未读（2026-09-26 实测：角标被已删除会话钉死在 1）

/** 造一个"会话 A 已完成但未读、且已存在一段时间"的状态。 */
function withStaleUnread() {
  let s = initialState()
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: true, at: T0 }))
  ;({ state: s } = reduce(s, { type: 'running', sessionId: 'A', running: false, at: T0 + 1 }))
  return s
}

test('prune 摘掉已消失会话的未读、缓冲与会话条目，并把角标数报成 0', () => {
  const before = withStaleUnread()
  assert.equal(before.unread.get('A'), 'done')
  const { state, actions } = reduce(before, { type: 'prune', sessionIds: ['A'], at: T0 + 10 * PRUNE_GRACE_MS })
  assert.equal(state.unread.has('A'), false)
  assert.equal(state.pendingDone.has('A'), false)
  assert.equal(state.queuedPending.has('A'), false)
  assert.equal(state.sessions.has('A'), false)
  const badges = actions.filter((a) => a.kind === 'badge')
  assert.equal(badges.length, 1, '未读数变了就要更新角标')
  assert.equal(badges[0].count, 0)
})

test('prune 不误伤其他会话的未读', () => {
  let s = withStaleUnread()
  ;({ state: s } = reduce(s, { type: 'error', sessionId: 'B', message: 'x', at: T0 + 2 }))
  const { state } = reduce(s, { type: 'prune', sessionIds: ['A'], at: T0 + 10 * PRUNE_GRACE_MS })
  assert.equal(state.unread.has('A'), false)
  assert.equal(state.unread.get('B'), 'error')
})

test('prune 对"刚动过"的会话有宽限期（新会话目录可能还没落地）', () => {
  const before = withStaleUnread()
  const { state, actions } = reduce(before, { type: 'prune', sessionIds: ['A'], at: T0 + 1 + PRUNE_GRACE_MS - 1 })
  assert.equal(state.unread.get('A'), 'done', '宽限期内不能剪')
  assert.deepEqual(actions, [])
})

test('prune 空名单/无变化时不产生动作（避免每秒刷动作）', () => {
  const before = withStaleUnread()
  assert.deepEqual(reduce(before, { type: 'prune', sessionIds: [], at: T0 + 10 * PRUNE_GRACE_MS }).actions, [])
  assert.deepEqual(reduce(before, { type: 'prune', at: T0 + 10 * PRUNE_GRACE_MS }).actions, [])
  const { state } = reduce(before, { type: 'prune', sessionIds: ['不存在'], at: T0 + 10 * PRUNE_GRACE_MS })
  assert.equal(state.unread.get('A'), 'done')
})

test('prune 不改动 prev（纯函数）', () => {
  const before = withStaleUnread()
  reduce(before, { type: 'prune', sessionIds: ['A'], at: T0 + 10 * PRUNE_GRACE_MS })
  assert.equal(before.unread.get('A'), 'done')
  assert.equal(before.sessions.has('A'), true)
})
