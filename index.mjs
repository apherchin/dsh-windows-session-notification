/**
 * dsh-attention —— host 半边：唯一决策点 + 唯一出口。
 *
 * 数据流：cordis 事件 → 归一化 → attention-core.reduce → 动作（toast / badge / focus）
 * 焦点：client 半边经 POST /api/attention/focus 上报 viewing（窗口失焦时为 null）
 * 点击：Toast 的 protocol 回调写 clicks.log → 本插件轮询 → 转成 openRequest → client 执行 openSession
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initialState, reduce } from './lib/attention-core.mjs'
import { parseClickLine } from './lib/click-uri.mjs'
import { createLogger } from './lib/log.mjs'
import { buildBadgeState, buildToastPayload } from './lib/payloads.mjs'
import { createRouteTable } from './lib/routes.mjs'
import { readSessionTitle } from './lib/session-title.mjs'
import { loadUnread, saveUnread } from './lib/state-store.mjs'
import { createWinNotify } from './lib/win-notify.mjs'

export const name = 'attention'
export const inject = ['connection']

/** 探针路由（装配验证用）。 */
export const PING_PATH = '/api/attention/ping'

/** tick 周期（毫秒）：驱动合并窗口与 clicks.log 轮询。 */
const TICK_MS = 1000

/**
 * 解析 DSH_HOME。
 * @returns {string} 绝对路径。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** 每多少个 tick 检查一轮"未读会话是否已被删除"（tick 周期 1s ⇒ 约 15 秒一轮）。 */
const PRUNE_EVERY_TICKS = 15

/**
 * 造一个"会话是否仍然存在"的判据，用来清**幽灵未读**。
 *
 * 为什么需要：未读集合是**持久化**的，而摘除只发生在 `session/disposed` 事件里；会话在插件没跑的时候
 * 被删掉（或删除走的是别的路径）就会留下**永远清不掉的幽灵未读** —— 2026-09-26 实测：任务栏角标被
 * 一条已删除会话钉死在 "1"，用户点遍所有会话都不变。
 *
 * 判据：`<DSH_HOME>/sessions/<项目>/<sessionId>` 任一存在即算存在。
 * 目录枚举失败时一律视为"存在"（宁可保守，不要误剪真实未读）。
 * @returns {(sessionId: string) => boolean} 判据。
 */
function createSessionExistsProbe() {
  const roots = []
  try {
    const base = join(dshHome(), 'sessions')
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(base, entry.name))
    }
  } catch {
    /* 拿不到就保守处理 */
  }
  if (roots.length === 0) return () => true
  return (sessionId) => roots.some((root) => existsSync(join(root, sessionId)))
}

/**
 * 取显示用的会话标题。优先级：client 上报的缓存 → **会话投影缓存里的真名** → `ctx.sessions`。
 * 全拿不到就回空串（payloads 会退回 id 片段）。
 * @param {object} ctx - Host 上下文。
 * @param {Map<string, string>} cache - client 上报过的标题缓存。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 标题。
 */
function resolveTitle(ctx, cache, sessionId) {
  const cached = cache.get(sessionId)
  if (typeof cached === 'string' && cached !== '') return cached
  // 宿主侧权威来源：`$DSH_HOME/storages/session_projcache/sessions/<id>.json` 的 title 行。
  // 这是"用户认得出的会话名"，不依赖 client 上报（见 lib/session-title.mjs 的说明）。
  const fromProjection = readSessionTitle(dshHome(), sessionId)
  if (fromProjection !== '') return fromProjection
  try {
    const sessions = Reflect.get(ctx, 'sessions')
    const raw = sessions?.list?.()
    if (Array.isArray(raw)) {
      const hit = raw.find((s) => (s?.id ?? s?.sessionId) === sessionId)
      if (typeof hit?.title === 'string') return hit.title
    }
    const snap = sessions?.list?.getSnapshot?.()
    const title = snap?.byId?.[sessionId]?.title
    if (typeof title === 'string') return title
  } catch {
    /* 形状不符就回退 */
  }
  return ''
}

/**
 * 安全读一个属性：读不动（含作用域句柄在域外不可读）就返回 undefined，**绝不抛**。
 * @param {object} object - 目标对象。
 * @param {string} key - 属性名。
 * @returns {*} 属性值或 undefined。
 */
export function safeGet(object, key) {
  try {
    if (object === null || object === undefined) return undefined
    return object[key]
  } catch {
    return undefined
  }
}

/**
 * 列出载荷的顶层键（诊断用；读不动时给出说明而不是抛错）。
 * 为什么要它：只有一个事件名和一行日志时，看不出"载荷长什么样"，也就无从判断该读哪个字段。
 * @param {*} value - 任意载荷。
 * @returns {string} 形如 `[agent,questions]` 的简短描述。
 */
export function keysOf(value) {
  try {
    if (value === null || value === undefined) return String(value)
    if (typeof value !== 'object') return `(${typeof value})`
    const keys = Object.keys(value)
    return `[${keys.slice(0, 12).join(',')}]`
  } catch (error) {
    return `[不可枚举: ${String(error)}]`
  }
}

/**
 * 从事件对象里取出会话 id。
 * 依据：`api-session/status` 的广播用的是 `agent.id`，因此 root agent 的 id 即会话 id；
 * waterfall 的请求体带 `agent`。
 *
 * ⚠️ 为什么每一步都要 safeGet：作用域事件（approval/request、user-questions/request）的载荷里
 * `agent` 可能是"域外不可读"的句柄，**读它的属性会抛错**；而发射方（`dsh-user-approval` /
 * `dsh-user-questions`）的 Promise 链把异常吞掉当成 `unavailable` ⇒ **抛错是完全无声的**。
 * 2026-09-26 实测：探针在总线上看得见 `user-questions/request`（同一事件服务、同样 global 钩子），
 * 而我们的处理器一行日志都没有 —— 就是在写日志之前抛在这里。
 * @param {object} payload - 事件载荷。
 * @returns {string|null} 会话 id。
 */
export function sessionIdOf(payload) {
  const agent = safeGet(payload, 'agent')
  if (agent !== undefined && agent !== null) {
    const direct = safeGet(agent, 'id')
    if (direct !== undefined && direct !== null && direct !== '') return String(direct)
    const nested = safeGet(safeGet(agent, 'session'), 'id')
    if (nested !== undefined && nested !== null && nested !== '') return String(nested)
    return null
  }
  const session = safeGet(payload, 'session')
  if (session !== undefined && session !== null) {
    const id = safeGet(session, 'id')
    if (id !== undefined && id !== null && id !== '') return String(id)
  }
  const own = safeGet(payload, 'sessionId') ?? safeGet(payload, 'id')
  if (typeof own === 'string' && own !== '') return own
  return null
}

/**
 * 插件入口。
 * @param {object} ctx - Host 上下文。
 */
export function apply(ctx) {
  const home = join(dshHome(), 'dsh-attention')
  const paths = {
    log: join(home, 'attention.log'),
    state: join(home, 'state.json'),
    badge: join(home, 'badge.json'),
    lock: join(home, 'badge.lock'),
    clicks: join(home, 'clicks.log'),
  }
  const log = createLogger(paths.log)
  const connection = Reflect.get(ctx, 'connection')
  const scriptsDir = join(import.meta.dirname, 'scripts')
  const powershellPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const win = createWinNotify({ scriptsDir, powershellPath, log })

  let state = initialState()
  state.unread = loadUnread(paths.state)
  /** client 上报过的会话标题（宿主侧标题来源不可靠时的兜底）。 */
  const titles = new Map()
  /** 待 client 执行的"打开会话"请求。 */
  let openRequest = null

  /**
   * 写角标状态文件（badge.ps1 轮询它）。
   * @param {{ count: number }} badge - 角标动作。
   */
  function writeBadge(badge) {
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(paths.badge, JSON.stringify(buildBadgeState(badge)), 'utf8')
    } catch (error) {
      log(`badge 状态写入失败 ${String(error)}`)
    }
  }

  /**
   * 把当前未读数写成角标动作。
   * @returns {{ kind: 'badge', count: number }} 角标动作。
   */
  function currentBadge() {
    return { kind: 'badge', count: state.unread.size }
  }

  /**
   * 执行一批动作。
   * @param {object[]} actions - attention-core 产出的动作。
   */
  function runActions(actions) {
    for (const action of actions) {
      if (action.kind === 'badge') {
        writeBadge(action)
      } else if (action.kind === 'toast') {
        const payload = buildToastPayload({
          reason: action.reason,
          sessionId: action.sessionId,
          title: action.sessionId === undefined ? '' : resolveTitle(ctx, titles, action.sessionId),
          detail: '',
          count: action.count,
          logFile: paths.log,
        })
        log(`toast -> ${action.reason}${action.sessionId === undefined ? '' : ` ${action.sessionId}`}`)
        win.toast(payload)
      }
    }
    saveUnread(paths.state, state.unread)
  }

  /**
   * 归约一个事件并执行动作。
   * @param {object} event - 归一化事件。
   */
  function dispatch(event) {
    const result = reduce(state, event)
    state = result.state
    runActions(result.actions)
  }

  /**
   * 清掉"会话已经不存在"的未读/待处理记录（幽灵未读）。
   * @returns {number} 被清掉的会话数。
   */
  function pruneStaleUnread() {
    if (state.unread.size === 0 && state.sessions.size === 0) return 0
    const exists = createSessionExistsProbe()
    const candidates = [...new Set([...state.unread.keys(), ...state.sessions.keys()])]
    const stale = candidates.filter((sessionId) => !exists(sessionId))
    if (stale.length === 0) return 0
    log(`prune: 会话已不存在，清掉 ${stale.length} 个：${stale.join(', ')}`)
    dispatch({ type: 'prune', sessionIds: stale, at: Date.now() })
    return stale.length
  }

  /**
   * 读 clicks.log（协议回调写入），转成 openRequest 或立即动作。
   */
  function pollClicks() {
    try {
      if (!existsSync(paths.clicks)) return
      const raw = readFileSync(paths.clicks, 'utf8')
      rmSync(paths.clicks, { force: true })
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseClickLine(line)
        if (parsed === null) continue
        const { verb, sessionId } = parsed
        log(`click -> ${verb} ${sessionId ?? ''}`)
        if (verb === 'open' && sessionId !== undefined) {
          openRequest = { sessionId, at: Date.now() }
          // 同时把窗口端到前台。为什么必须做：protocol 激活只是「后台起一个 handler」，
          // session 切换发生在应用**内部**；不抢焦点的话窗口还被别的程序压着（或最小化），
          // 用户会以为"点了没反应"——2026-09-26 实测：日志里 open:ok、会话也切了，
          // 但用户看到的是"什么都没发生"。
          win.focus({ logFile: paths.log })
        } else if (verb === 'dismiss' && sessionId !== undefined) {
          dispatch({ type: 'viewing', sessionId, at: Date.now() })
        } else if (verb === 'focus') {
          win.focus({ logFile: paths.log })
        }
      }
    } catch (error) {
      log(`clicks 轮询失败 ${String(error)}`)
    }
  }

  // ---- 探针路由 ----
  ctx.effect(() => connection.fetch.register({
    path: PING_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json({ ok: true, plugin: 'dsh-attention', task: 11 }),
  }), 'attention: ping route')

  // ---- 业务路由 ----
  const table = createRouteTable({
    setViewing: (sessionId, title) => {
      if (sessionId !== null && title !== '' && !title.startsWith('[diag:')) titles.set(sessionId, title)
      log(`viewing -> ${sessionId ?? 'null'}${title === '' ? '' : ` (${title})`}`)
      dispatch({ type: 'viewing', sessionId, at: Date.now() })
    },
    snapshot: () => ({
      unread: Object.fromEntries(state.unread),
      // client 半边用这个数字做任务栏角标（Electron 渲染进程的 Badging API，见 client.js）。
      unreadCount: state.unread.size,
      openRequest,
    }),
    ackOpen: () => { openRequest = null },
    // 待审批/待回答的**主通道**：client 半边经 `ctx.remote.$on` 收到后上报（宿主侧同名事件是
    // scope-filtered waterfall，实测连 {global:true} 都收不到，见 lib/routes.mjs 的说明）。
    reportPending: ({ sessionId, kind, keys }) => {
      // `kind === null` = 客户端发现"这个已报过的待办没了"（用户已答复/已取消）⇒ 清干净。
      // 为什么必须收这条：① 未读/角标不该继续挂着；② 否则同一会话的**下一次**待办会被去重逻辑误吞。
      if (kind === null) {
        if (sessionId === null) return
        log(`pending-cleared（客户端上报）session=${sessionId}`)
        dispatch({ type: 'pending-cleared', sessionId, at: Date.now() })
        return
      }
      // 去重：客户端有两条上报通道（uiSession 快照 / remote 总线），同一个待办不许弹两次。
      // ⚠️ 判据必须用 **core 自己的语义** `sessions.get(id).pending`（core 把未读标记写成 `'pending'`，
      // 拿上报的 kind 去比 `unread` 永远不相等 —— 2026-09-27 实测就是这么弹了两条横幅）。
      const already = sessionId !== null && state.sessions.get(sessionId)?.pending === kind
      const suppressed = sessionId !== null && state.viewing === sessionId
      log(`${kind}（客户端上报）session=${sessionId ?? 'null'} viewing=${state.viewing ?? 'null'} 载荷=${keys || '?'} -> ${already ? '去重（同一待办已提醒过）' : suppressed ? '不提醒（正在看它）' : '已提醒'}`)
      if (sessionId === null || already) return
      dispatch({ type: 'pending', sessionId, kind, at: Date.now() })
    },
  })
  for (const [path, route] of Object.entries(table)) {
    ctx.effect(() => connection.fetch.register({ path, ...route }), `attention: route ${path}`)
  }

  // ---- 边界探针：证明"哪些事件真的流过了总线" ----
  // 为什么需要它：审批不提醒时，**无法区分"事件没发生"和"事件发生了但没到我们"**——2026-09-26 就卡在这。
  // cordis 每次分发事件都会先发一个 `internal/dispatch`（参数里带事件名），而 `{global:true}` 的监听器
  // 能看见**所有**分发，包括被作用域过滤掉的。每类事件只记第一行，不刷屏。
  const WATCHED_EVENTS = ['approval/request', 'user-questions/request', 'agent/status', 'agent/error', 'session/disposed']
  const eventSeen = new Set()
  try {
    ctx.on('internal/dispatch', (_mode, eventName) => {
      if (!WATCHED_EVENTS.includes(eventName) || eventSeen.has(eventName)) return
      eventSeen.add(eventName)
      log(`event-seen: ${eventName}（总线首次出现）`)
    }, { global: true })
  } catch (error) {
    log(`event-seen 探针注册失败（不影响主功能）：${String(error)}`)
  }

  // ---- 事件订阅 ----
  // ⚠️ 三条铁律（每条都是 2026-09-26 实打实踩出来的）：
  //   ① 必须带 `{ global: true }`：dsh-scope 对一批事件做作用域过滤（cordis `dispatch()` 里
  //      `hook.global || !filter || filter(...)`），`approval/request` / `user-questions/request`
  //      的载体基座是 **agent 自己**，不带 global 会被 agent 自带的过滤器挡在外面。
  //      （官方 `dsh-scope` 自己的不变量监听器就是这么写的。）
  //   ② **处理器体内绝不能抛错**：这两个事件是 waterfall，发射方把异常吞掉当成 `unavailable`
  //      ⇒ 抛错完全无声。所以每处都 try/catch，且**先写日志再 dispatch**。
  //   ③ 载荷字段一律用 `safeGet`：作用域句柄在域外读属性会抛（见 sessionIdOf 的注释）。
  const GLOBAL = { global: true }
  ctx.on('agent/status', (payload) => {
    try {
      const sessionId = sessionIdOf(payload)
      if (sessionId === null) return
      const running = payload.status === 'running'
      const wasRunning = state.sessions.get(sessionId)?.running === true
      // 完成时把判定依据落进日志：以后"这条为什么没提醒"可以直接从 attention.log 读出来
      // （正在看它 ⇒ 按 D2 不提醒；这就是"看着的会话跑完不弹横幅"的正常表现）。
      if (wasRunning && !running) {
        const viewed = state.viewing === sessionId
        log(`done session=${sessionId} viewing=${state.viewing ?? 'null'} -> ${viewed ? '不提醒（正在看它）' : '已提醒'}`)
      }
      dispatch({ type: 'running', sessionId, running, at: Date.now() })
    } catch (error) {
      log(`agent/status 处理失败（已忽略，绝不外抛）：${String(error)}`)
    }
  }, GLOBAL)
  ctx.on('agent/error', (payload) => {
    try {
      const sessionId = sessionIdOf(payload)
      if (sessionId !== null) dispatch({ type: 'error', sessionId, message: String(safeGet(payload, 'error')?.message ?? safeGet(payload, 'error') ?? ''), at: Date.now() })
    } catch (error) {
      log(`agent/error 处理失败（已忽略，绝不外抛）：${String(error)}`)
    }
  }, GLOBAL)
  ctx.on('approval/request', (request, next) => {
    try {
      const sessionId = sessionIdOf(request)
      // 先写日志再 dispatch：dispatch 抛错时也必须留下痕迹（本插件反复"静默失败"的根源就在这）。
      log(`approval session=${sessionId ?? 'null'} viewing=${state.viewing ?? 'null'} 载荷=${keysOf(request)} -> ${sessionId !== null && state.viewing === sessionId ? '不提醒（正在看它）' : '已提醒'}`)
      if (sessionId !== null) dispatch({ type: 'pending', sessionId, kind: 'approval', at: Date.now() })
    } catch (error) {
      log(`approval 处理失败（已忽略，绝不外抛）：${String(error)}`)
    }
    return next()
  }, GLOBAL)
  ctx.on('user-questions/request', (request, next) => {
    try {
      const sessionId = sessionIdOf(request)
      const first = safeGet(safeGet(request, 'questions'), 0)
      const kind = safeGet(safeGet(first, 'intent'), 'kind') === 'plan-review' ? 'plan-review' : 'question'
      log(`${kind} session=${sessionId ?? 'null'} viewing=${state.viewing ?? 'null'} 载荷=${keysOf(request)} -> ${sessionId !== null && state.viewing === sessionId ? '不提醒（正在看它）' : '已提醒'}`)
      if (sessionId !== null) dispatch({ type: 'pending', sessionId, kind, at: Date.now() })
    } catch (error) {
      log(`user-questions 处理失败（已忽略，绝不外抛）：${String(error)}`)
    }
    return next()
  }, GLOBAL)
  ctx.on('session/disposed', (payload) => {
    try {
      const sessionId = sessionIdOf(payload)
      if (sessionId !== null) dispatch({ type: 'disposed', sessionId, at: Date.now() })
    } catch (error) {
      log(`session/disposed 处理失败（已忽略，绝不外抛）：${String(error)}`)
    }
  }, GLOBAL)

  // ---- 启动：先落一次角标（恢复的未读要立刻反映），再起 tick 循环与常驻角标 ----
  ctx.effect(() => {
    // ⚠️ host 半边的 apply/effect 抛错同样会让插件 entry 进不了 active，而 DSH 的 web boot 门禁
    // 是**全有全无**的（任何 entry 非 active ⇒ 整个应用启动中止）。启动这套出口要写盘、起
    // PowerShell、摸 COM，失败时只应降级，绝不能把异常抛给启动门禁。
    try {
      // 自证"当前跑的是哪一版代码"：以前从日志里判断不出重启后到底加载了哪份文件（2026-09-26 卡过一轮）。
      try {
        const selfPath = fileURLToPath(import.meta.url)
        log(`boot: ${selfPath} mtime=${new Date(statSync(selfPath).mtimeMs).toISOString()} 订阅=${WATCHED_EVENTS.join(',')}(global)`)
      } catch { /* 自证失败不影响启动 */ }
      // 先清幽灵未读：否则角标一开局就显示错的数字（历史 state.json 里可能有已删除会话的未读）。
      pruneStaleUnread()
      writeBadge(currentBadge())
      win.registerProtocol()
      // AUMID 注册：没有它，通知横幅顶部会显示 "Windows PowerShell"（未打包应用的进程名兜底）。
      win.registerAppId()
      // ⛔ 不再启动 badge.ps1（2026-09-26 退役）：跨进程 SetOverlayIcon 必失败，
      // 任务栏角标现在由渲染进程的 Badging API 负责，见 lib/win-notify.mjs 的说明。
    } catch (error) {
      log(`启动出口失败，已降级（toast/角标可能不可用）：${String(error)}`)
    }
    let ticks = 0
    const timer = setInterval(() => {
      pollClicks()
      dispatch({ type: 'tick', at: Date.now() })
      ticks += 1
      // 定期复查：会话被删掉后（可能发生在本插件没跑的时候）及时把角标降下来。
      if (ticks % PRUNE_EVERY_TICKS === 0) {
        try {
          pruneStaleUnread()
        } catch (error) {
          log(`prune 失败：${String(error)}`)
        }
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  }, 'attention: tick loop + badge')
}
