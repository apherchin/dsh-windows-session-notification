// dsh-windows-session-notification 客户端半边（原 dsh-attention；npm 包名与目录名见 README）。
// 格式硬要求：手写的 __ModuleLoader__ 工厂（无构建步骤）；**id 必须等于 package.json 的 name**。
// ⚠️ 这条不是形式主义，2026-09-29 踩过真事故：改名后 id 没跟 ⇒ manifest 期望的模块 id（= 包名）
//    与 bundle 注册的 id 不一致 ⇒ loader 认为"该模块还没加载"⇒ **重新导入同一个 bundle** ⇒
//    第二次执行时 `dsh-attention` 已在注册表里 ⇒ `client-modules: duplicate factory registration`
//    ⇒ entry `failed` ⇒ 撞渲染端「每条 client entry 必须 active」的全有全无门禁 ⇒ **整机起不来**
//    （崩溃现场：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`，2026-09-29T15:20:36Z）。
// 职责只有三件：① 上报"我正在看哪个会话"（页面不可见/失焦时报 null）
//               ② 轮询宿主，收到"打开会话"请求时用 `ctx.get('uiWorkspace').openSession(id)` 切过去
//                 （**不是** `ctx.uiWorkspace`：服务访问要过门禁，直接属性访问在 client 侧拿不到）
//               ③ 把未读数转成任务栏角标（渲染进程的 Badging API）
window.__ModuleLoader__.load({
  id: 'dsh-windows-session-notification',
  factory(require) {
    const POLL_MS = 1000

    /**
     * 读当前主视图会话 id。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {string|null|undefined} 会话 id；null 表示"确实没有主视图会话"；undefined 表示"数据源不可用"。
     */
    function readMainViewSessionId(ctx) {
      try {
        const list = ctx.sessions?.list?.getSnapshot?.()
        if (list?.byId === undefined) return undefined
        for (const [id, row] of Object.entries(list.byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return id
        }
        return null
      } catch {
        return undefined
      }
    }

    /** 由 composer 槽位探针写入的"当前会话 id"。 */
    let slotSessionId

    /**
     * 槽位注册状态，只用于诊断上报（`viewing -> … [diag:unset-<state>]`）：
     * `pending` = 还没拿到 slots 服务；`ok` = 注册已成功但链还没求值过；`error:…` = 注册时抛错。
     * @type {string}
     */
    let slotState = 'pending'

    /**
     * 任务栏角标状态，只用于诊断上报（进 `[diag:…]`，不进被宿主缓存的标题）。
     * 取值：`badge:pending` / `badge:ok(<n>)` / `badge:unavailable` / `badge:err(<name>)`。
     * @type {string}
     */
    let badgeTagValue = 'badge:pending'

    /** 上一次已应用的角标数字（避免每个 tick 重复调 API）。 */
    let lastBadgeCount = null

    /** 上一次上报过的"每会话 pendingInteraction"（避免每秒重复上报同一个待审批）。 */
    const lastPendingReported = new Map()

    /**
     * 待审批/待回答上报状态，只用于诊断上报。
     * 取值：`pend:ok(<n>)` / `pend:no-store` / `pend:get-threw`。
     * @type {string}
     */
    let pendingTagValue = ''

    /**
     * 最近一次"点击横幅 → 打开会话"的结果，只用于诊断上报（进 `[diag:…]`，让宿主日志能看到成败）。
     * 取值：`open:ok` / `open:no-service` / `open:no-method` / `open:get-threw(…)` / `open:threw(…)`。
     * @type {string}
     */
    let openTagValue = ''

    /**
     * 判断这个请求属于哪个会话。
     *
     * ⚠️ 官方做法（`dsh-client-ui-user-questions` 的 `answerQuestion`）：`ctx.sessions.scopeOf(owner)`，
     * 其中 **owner 就是监听器被调用时的 `this`**（事件自带的作用域上下文）——
     * 所以监听器**必须写成 `function`**：箭头函数拿不到作用域 `this`，只能退化读载荷里的 `agent`，
     * 而实测那条路读不出 id（日志实证：`session=null 载荷=[questions,agent,signal]`）。
     * @param {object} ctx - 客户端插件上下文。
     * @param {*} owner - 监听器里的 `this`。
     * @param {object} request - 事件载荷（兜底用）。
     * @returns {string|null} 会话 id。
     */
    function resolveSessionId(ctx, owner, request) {
      let sessions
      try {
        sessions = ctx.get('sessions') ?? ctx.sessions
      } catch {
        sessions = undefined
      }
      try {
        const scoped = sessions?.scopeOf?.(owner)
        if (typeof scoped === 'string' && scoped !== '') return scoped
      } catch {
        /* scopeOf 拿不到就退到载荷 */
      }
      return sessionIdOfPayload(request)
    }

    /**
     * remote 总线订阅的状态，只用于诊断上报。
     * 取值：`remote:ok` / `remote:no-service` / `remote:inject-err(…)` / `remote:err(…)`。
     * @type {string}
     */
    let remoteTagValue = ''

    /** 安全读一个属性：读不动（作用域句柄在域外不可读）就返回 undefined，绝不抛。 */
    function readProp(object, key) {
      try {
        if (object === null || object === undefined) return undefined
        return object[key]
      } catch {
        return undefined
      }
    }

    /**
     * 从 remote 事件载荷里取会话 id（读不动就 null，绝不抛）。
     * @param {object} payload - 事件载荷。
     * @returns {string|null} 会话 id。
     */
    function sessionIdOfPayload(payload) {
      try {
        const agent = readProp(payload, 'agent')
        if (agent !== undefined && agent !== null) {
          const direct = readProp(agent, 'id')
          if (direct !== undefined && direct !== null && direct !== '') return String(direct)
          const nested = readProp(readProp(agent, 'session'), 'id')
          if (nested !== undefined && nested !== null && nested !== '') return String(nested)
          return null
        }
        const session = readProp(payload, 'session')
        if (session !== undefined && session !== null) {
          const id = readProp(session, 'id')
          if (id !== undefined && id !== null && id !== '') return String(id)
        }
        const own = readProp(payload, 'sessionId') ?? readProp(payload, 'id')
        return typeof own === 'string' && own !== '' ? own : null
      } catch {
        return null
      }
    }

    /**
     * 载荷顶层键（诊断用，进宿主的 attention.log —— 取不到 id 时靠它判断该读哪个字段）。
     * @param {object} payload - 事件载荷。
     * @returns {string} 形如 `[agent,questions]`。
     */
    function keysOfPayload(payload) {
      try {
        if (payload === null || payload === undefined) return String(payload)
        if (typeof payload !== 'object') return `(${typeof payload})`
        return `[${Object.keys(payload).slice(0, 12).join(',')}]`
      } catch (error) {
        return `[不可枚举: ${String(error)}]`
      }
    }

    /**
     * 判断是普通提问还是计划待审。
     * @param {object} payload - user-questions 载荷。
     * @param {string} fallback - 兜底种类。
     * @returns {string} `plan-review` 或 fallback。
     */
    function kindOfPayload(payload, fallback) {
      try {
        const first = readProp(readProp(payload, 'questions'), 0)
        return readProp(readProp(first, 'intent'), 'kind') === 'plan-review' ? 'plan-review' : fallback
      } catch {
        return fallback
      }
    }

    /**
     * 零渲染探针组件：只为从槽位 props 里读出当前会话 id。
     * @param {{ sessionId?: string }} props - 槽位属性。
     * @returns {null} 永不渲染内容。
     */
    function SessionProbe(props) {
      slotSessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      return null
    }

    /**
     * 读取某会话的标题（拿不到就回空串）。
     * @param {object} ctx - 客户端插件上下文。
     * @param {string|null} id - 会话 id。
     * @returns {string} 标题。
     */
    function readTitleFor(ctx, id) {
      if (id === null || id === undefined) return ''
      try {
        const list = ctx.sessions?.list?.getSnapshot?.()
        return String(list?.byId?.[id]?.title ?? '')
      } catch {
        return ''
      }
    }

    return {
      apply(ctx) {
        // 槽位探针：`conversation.composer` 是 **chain** 槽位（ui-conversation 的 children 表原文：
        // `"conversation.composer": { kind: "chain", scope: "session" }`）。chain 的注册**必须**给
        // `select`；用 list 槽位那套（`id`）会被 `SlotCore.register` 抛
        // `chain slot "conversation.composer" requires options.select`。
        // ⚠️ 这个错误曾经直接抛穿 apply → client entry 变 failed → 撞上渲染端「每个 entry 都必须
        // active」的启动门禁 → **整个应用启动中止（表现为"崩溃"）**。详见
        // reports\dsh-attention-启动崩溃-根因-20260926.md。
        // select 收到的是 renderSlotChain 的 owner props（该调用点传 `{ sessionId, session,
        // pendingInteraction }`）；一律 return null = 弃权，回落到官方 fallback，本插件不渲染任何东西。
        // ⚠️ 拿 slots 服务要用**嵌套** `ctx.inject(['slots'], scope => …)`，而不是插件级硬门禁
        // `inject: ['slots']`：后者在服务缺失/未就绪时会让 entry 停在 `pending`，而 DSH 的
        // web boot 守卫对 `pending` 与 `failed` **一视同仁**（任何一条非 active ⇒ 整个应用起不来）。
        // 嵌套写法下外层 entry 立刻 active，最坏只是"探针不生效"。
        // 直接 `ctx.slots`（不声明）在本机实测拿不到服务：client 插件的服务访问受 inject 门禁管辖。
        try {
          ctx.inject(['slots'], (scope) => {
            try {
              scope.slots.inject('conversation.composer', () => scope.slots.register({
                name: 'conversation.composer',
                select: (owner) => {
                  slotSessionId = typeof owner?.sessionId === 'string' ? owner.sessionId : null
                  return null
                },
              }, SessionProbe))
              slotState = 'ok'
            } catch (error) {
              // 兜底：apply 抛错会升级成**整个应用启动失败**（web boot 门禁全有全无），必须自己吃掉。
              slotState = `error:${(error?.message ?? String(error)).slice(0, 120)}`
              console.error('[dsh-attention] 槽位注册失败，已降级为"不跟踪当前会话"：', error)
            }
          })
        } catch (error) {
          slotState = `error:${(error?.message ?? String(error)).slice(0, 120)}`
          console.error('[dsh-attention] 注入 slots 服务失败，已降级为"不跟踪当前会话"：', error)
        }

        // 待审批/待回答的**主通道**：`ctx.remote.$on(事件名)`。
        //
        // ⚠️ 为什么不用宿主侧事件：`approval/request` / `user-questions/request` 是 scope-filtered 的
        // waterfall 事件，**宿主插件实测收不到**（2026-09-26 实测：边界探针在总线上看得见
        // `user-questions/request`，而宿主处理器一次都没被调用，连 `{ global: true }` 也不行）。
        // 而客户端这条总线是**官方审批/提问 UI 用的同一条**（用户屏幕上确实渲染出了问题）
        // ⇒ 客户端拿得到，就由客户端上报给宿主，宿主再做 D2 抑制 + 出横幅/角标。
        try {
          ctx.inject(['remote'], (scope) => {
            try {
              const remote = scope.get('remote') ?? scope.remote
              if (remote === undefined || remote === null || typeof remote.$on !== 'function') {
                remoteTagValue = 'remote:no-service'
                return
              }
              // ⚠️ 必须是 `function`（不是箭头函数）：会话 id 要从作用域 `this` 上取
              // （官方 `answerQuestion` 就是 `ctx.sessions.scopeOf(owner)`，owner === this）。
              const report = (baseKind) => function reportPending(request, next) {
                try {
                  void fetch('/api/attention/pending', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      sessionId: resolveSessionId(ctx, this, request),
                      kind: kindOfPayload(request, baseKind),
                      keys: keysOfPayload(request),
                    }),
                  }).catch(() => {})
                } catch {
                  /* 上报失败绝不能影响官方链路 */
                }
                // ⚠️ 必须把 next() 交回 waterfall：截断它，官方审批/提问 UI 就渲染不出来了。
                return next()
              }
              remote.$on('user-questions/request', report('question'))
              remote.$on('approval/request', report('approval'))
              remoteTagValue = 'remote:ok'
            } catch (error) {
              remoteTagValue = `remote:err(${error?.name ?? 'unknown'})`
              console.error('[dsh-attention] remote 订阅失败，已降级为"待审批/待回答不提醒"：', error)
            }
          })
        } catch (error) {
          remoteTagValue = `remote:inject-err(${error?.name ?? 'unknown'})`
          console.error('[dsh-attention] 注入 remote 服务失败：', error)
        }

        let timer = null
        let stopped = false
        let lastSent = ''

        /**
         * 只有"页面可见且聚焦"时才认为在看；否则一律 null。
         * ⚠️ 若最小化时仍上报最后那个会话，它自己跑完了反而不会提醒（违背 D2）。
         * @returns {{ sessionId: string|null, title: string, diag: string, badge: string }} 当前视图。
         */
        function viewingNow() {
          const badge = badgeTagValue
          const visible = typeof document !== 'undefined' && document.visibilityState === 'visible'
          const focused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()
          if (!visible || !focused) return { sessionId: null, title: '', diag: 'hidden', badge }
          // 1) 槽位 props 是已核实的可用来源（conversation.composer 收到 { sessionId, ... }）
          if (slotSessionId !== undefined) {
            const title = readTitleFor(ctx, slotSessionId)
            return { sessionId: slotSessionId ?? null, title, diag: 'slot', badge }
          }
          // 2) 兜底：直接读 sessions store（client 的服务访问受 inject 门禁管辖，多数上下文拿不到）
          const id = readMainViewSessionId(ctx)
          if (id === undefined) return { sessionId: null, title: '', diag: `unset-${slotState}`, badge }
          return { sessionId: id, title: readTitleFor(ctx, id), diag: 'store', badge }
        }

        async function reportFocus() {
          if (stopped) return
          const { sessionId, title, diag, badge } = viewingNow()
          const tags = [badge, openTagValue, pendingTagValue, remoteTagValue].filter((t) => t !== '').join(' ')
          const diagText = tags === '' ? diag : `${diag} ${tags}`
          const key = `${sessionId ?? ''}|${title}|${diagText}`
          if (key === lastSent) return
          lastSent = key
          try {
            await fetch('/api/attention/focus', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, title: diag === 'slot' || diag === 'store' ? title : `[diag:${diagText}]` }),
            })
          } catch {
            lastSent = ''
          }
        }

        /**
         * 读 `uiSession.sessionStatus` 快照，把**全部会话**的待审批/待回答上报给宿主。
         *
         * 为什么用这个源（另两条都试过、都不行）：
         *   ① 宿主侧 `approval/request` / `user-questions/request` 是 scope-filtered waterfall 事件，
         *      宿主插件实测**收不到**（2026-09-26：边界探针在总线上看得见、宿主处理器一次都没被调用，
         *      连 `{ global: true }` 也不行）；
         *   ② 客户端 `ctx.remote.$on` 能收到事件，但那是 cordis waterfall，而官方处理器正常路径
         *      **不调用 `next()`** ⇒ 排在它后面的监听器永远不会被调用（`$on` 也不支持 prepend）。
         * 而 `uiSession.sessionStatus` 正是**官方侧栏「待回答/待审批」标签的数据源**
         * （`dsh-client-ui-session` 的 `publishStatus()` 发布 `{running, pendingInteraction, completionUnread}`），
         * 且覆盖**全部会话**（不是只有正在看的那一个）⇒ 读它最可靠。
         * @returns {void}
         */
        function reportPendingInteractions() {
          let snapshot
          try {
            const uiSession = ctx.get('uiSession')
            snapshot = uiSession?.sessionStatus?.getSnapshot?.()
          } catch {
            pendingTagValue = 'pend:get-threw'
            return
          }
          if (snapshot === null || snapshot === undefined || typeof snapshot.forEach !== 'function') {
            pendingTagValue = 'pend:no-store'
            return
          }
          const seen = new Set()
          let count = 0
          snapshot.forEach((row, sessionId) => {
            // ⚠️ 快照里的 `pendingInteraction` 是**对象**（`PendingApproval` / `PendingQuestion` 实例），
            // 种类在它的 `.kind` 上 —— 侧栏就是这么取的（ui-workspace 的 sessionNode：
            // `visiblePendingKind(status?.pendingInteraction?.kind)`）。
            // 我最初把它当字符串比较 ⇒ 永远不匹配 ⇒ 日志永远是 `pend:ok(0)`（快照读到了却识别不出），
            // 这就是"审批为什么不弹"的直接原因（2026-09-26 实测）。
            const pending = readProp(row, 'pendingInteraction')
            const kind = readProp(pending, 'kind') ?? (typeof pending === 'string' ? pending : undefined)
            if (kind !== 'approval' && kind !== 'question' && kind !== 'plan-review') return
            seen.add(sessionId)
            count += 1
            if (lastPendingReported.get(sessionId) === kind) return   // 同一个待办只上报一次
            lastPendingReported.set(sessionId, kind)
            reportPending(sessionId, kind)
          })
          // 之前报过、这次快照里**没有了** ⇒ 回报"已清除"（kind=null）。
          // 为什么必须报：① 宿主的未读/角标不该继续挂着；② 宿主按"同一会话同一类待办已提醒过"去重，
          // 不报清除的话，**同一会话的下一次待办会被误吞**（2026-09-27 修）。
          for (const sessionId of [...lastPendingReported.keys()]) {
            if (seen.has(sessionId)) continue
            lastPendingReported.delete(sessionId)
            reportPending(sessionId, null)
          }
          pendingTagValue = `pend:ok(${count})`
        }

        /**
         * 上报一条待办（`kind === null` 表示"已清除"）。失败只降级，绝不影响官方 UI。
         * @param {string} sessionId - 会话 id。
         * @param {string|null} kind - 待办种类，或 null 表示已清除。
         * @returns {void}
         */
        function reportPending(sessionId, kind) {
          try {
            void fetch('/api/attention/pending', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, kind, keys: '[uiSession.sessionStatus]' }),
            }).catch(() => {})
          } catch {
            /* 上报失败不影响官方 UI */
          }
        }

        /**
         * 打开某个会话（Toast 点击 → protocol 处理器 → 宿主轮询 clicks.log → 这里）。
         *
         * ⚠️ 必须用 `ctx.get('uiWorkspace')` 取服务：`uiWorkspace` 是 cordis **服务**
         * （`dsh-client-ui-workspace` 里 `super(ctx, 'uiWorkspace')`），而直接写 `ctx.uiWorkspace`
         * 受服务门禁管辖、在 client 侧拿不到 —— 2026-09-26 实测：点横幅后宿主确实收到了
         * `click -> open session-…`，但这一行静默抛错、被我自己的 `catch {}` 吃掉，于是什么都没发生
         * （用户反馈"点击横幅切不回来"）。官方插件（ui-sidebar / ui-conversation）用的就是 `ctx.get(...)`，
         * 它做的是"不需要声明的查找"，不需要挂 inject。
         * @param {string} sessionId - 目标会话 id。
         * @returns {string} 诊断串（进 `[diag:…]`，好让宿主日志能看到成败）。
         */
        function openSession(sessionId) {
          let workspace
          try {
            workspace = ctx.get('uiWorkspace')
          } catch (error) {
            return `open:get-threw(${error?.name ?? 'unknown'})`
          }
          if (workspace === undefined || workspace === null) return 'open:no-service'
          if (typeof workspace.openSession !== 'function') return 'open:no-method'
          try {
            workspace.openSession(sessionId)
            // 顺带把窗口提到前台。为什么在这里做：Win32 侧（宿主 spawn 的 focus.ps1）在
            // "别的应用占着前台"时会被 Windows 前台锁拒绝（日志实证：`attempt=4 attached=False
            // set=False final=False`，只有窗口被最小化时靠 ShowWindow(SW_RESTORE) 侥幸成功），
            // 而**渲染进程 focus() 自己的窗口**是 Chromium 允许的操作 ⇒ 这条更可靠。
            try {
              window.focus()
            } catch {
              /* 拿不到焦点不影响切会话 */
            }
            return 'open:ok'
          } catch (error) {
            return `open:threw(${error?.name ?? 'unknown'})`
          }
        }

        /**
         * 任务栏角标：走 Electron 渲染进程的 Badging API（`navigator.setAppBadge`）。
         *
         * ⚠️ 为什么不用 Win32 的 ITaskbarList3.SetOverlayIcon：2026-09-26 实测**跨进程必然失败**
         * （对 DSH / foobar2000 / 微信三个窗口都返回 E_FAIL，同进程才行）——角标只能由"拥有那个
         * 窗口的进程"设置，而那个进程是 Electron 主进程，不是插件所在的 host 子进程。
         * 渲染进程的 Badging API 由主进程侧实现，因此这里能真正做到任务栏角标。
         * @param {number|null} count - 未读会话数；null 表示本轮拿不到（不动角标）。
         */
        function applyBadge(count) {
          if (count === null || count === lastBadgeCount) return
          lastBadgeCount = count
          if (typeof navigator === 'undefined' || typeof navigator.setAppBadge !== 'function') {
            badgeTagValue = 'badge:unavailable'
            return
          }
          try {
            const result = count > 0
              ? navigator.setAppBadge(count)
              : (typeof navigator.clearAppBadge === 'function' ? navigator.clearAppBadge() : undefined)
            if (result !== undefined && typeof result.then === 'function') {
              result.then(
                () => { badgeTagValue = `badge:ok(${count})` },
                (error) => { badgeTagValue = `badge:err(${error?.name ?? 'unknown'})` },
              )
            } else {
              badgeTagValue = `badge:ok(${count})`
            }
          } catch (error) {
            badgeTagValue = `badge:err(${error?.name ?? 'unknown'})`
          }
        }

        async function poll() {
          if (stopped) return
          try {
            const res = await fetch('/api/attention/state')
            if (!res.ok) return
            const snap = await res.json()
            // 任务栏角标：宿主把未读数放进快照，这里转成 Electron 的 Badging API 调用。
            applyBadge(Number.isFinite(snap?.unreadCount) ? snap.unreadCount : null)
            // 待审批/待回答：从 uiSession 的状态快照里读**全部会话**（两侧栏标签同源）。
            reportPendingInteractions()
            if (snap?.openRequest?.sessionId) {
              // 打开会话（点横幅/点通知中心条目的落点）。结果写进诊断串，别再静默吞错。
              openTagValue = openSession(snap.openRequest.sessionId)
              await fetch('/api/attention/opened', { method: 'POST', body: '{}' })
            }
          } catch { }
        }

        try {
          ctx.effect(() => {
            const onFocusOrBlur = () => { lastSent = ''; void reportFocus() }
            const onVisibility = () => { lastSent = ''; void reportFocus() }
            window.addEventListener('focus', onFocusOrBlur)
            window.addEventListener('blur', onFocusOrBlur)
            document.addEventListener('visibilitychange', onVisibility)
            void reportFocus()
            timer = setInterval(() => { void reportFocus(); void poll() }, POLL_MS)
            return () => {
              stopped = true
              if (timer !== null) clearInterval(timer)
              window.removeEventListener('focus', onFocusOrBlur)
              window.removeEventListener('blur', onFocusOrBlur)
              document.removeEventListener('visibilitychange', onVisibility)
            }
          }, 'attention: client focus reporter')
        } catch (error) {
          // 同上：apply 里任何漏出的异常都会升级成整个应用启动失败，这里一并吃掉。
          console.error('[dsh-attention] 焦点上报器注册失败，已降级为"只报 null"：', error)
        }
      },
    }
  },
})
