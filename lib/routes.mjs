/**
 * routes —— 同源路由表（纯协议转换，不持有状态）。
 *  - POST /api/attention/focus      client 上报"我在看哪个会话"（窗口失焦时 sessionId=null）
 *  - POST /api/attention/pending    client 上报"某个会话在等审批/等回答"（**主通道**，见下）
 *  - GET  /api/attention/state      client 轮询：未读快照 + 待执行的"打开会话"请求
 *  - POST /api/attention/opened     client 已执行打开动作，确认清除
 *
 * 为什么用"client 轮询"而不是宿主推送：本插件不需要发明推送通道，1 秒轮询在本机开销可忽略，
 * 且让协议面保持最小。
 *
 * ⚠️ 为什么 pending 由**客户端**上报：宿主侧的 `approval/request` / `user-questions/request` 是
 * scope-filtered waterfall 事件，实测连 `{ global: true }` 都收不到（2026-09-26：边界探针在总线上
 * 看得见 `user-questions/request`，而宿主处理器一次都没被调用）。而 client 半边的
 * `ctx.remote.$on(同名事件)` 拿得到 —— **官方审批/提问 UI 用的就是同一条总线**（当时的待回答问题
 * 确实渲染出来了）⇒ 客户端上报是可靠通道。
 */

/** focus 路由路径。 */
export const FOCUS_PATH = '/api/attention/focus'
/** pending 路由路径（client 上报待审批/待回答）。 */
export const PENDING_PATH = '/api/attention/pending'
/** state 路由路径。 */
export const STATE_PATH = '/api/attention/state'
/** opened 路由路径。 */
export const OPENED_PATH = '/api/attention/opened'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/**
 * 构造路由表。
 * @param {{ setViewing: (id: string|null, title: string) => void, reportPending: (pending: {sessionId: string|null, kind: string, keys: string}) => void, snapshot: () => object, ackOpen: () => void }} hooks - 宿主注入的回调。
 * @returns {Record<string, { methods: string[], requestBody: string, fetch: (request: Request) => Promise<Response> }>} 路由表。
 */
export function createRouteTable(hooks) {
  return {
    [FOCUS_PATH]: {
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return new Response(JSON.stringify({ ok: false, code: 'BAD_JSON' }), { status: 400, headers: JSON_HEADERS })
        }
        const sessionId = body?.sessionId === null || body?.sessionId === undefined ? null : String(body.sessionId)
        const title = typeof body?.title === 'string' ? body.title : ''
        hooks.setViewing(sessionId, title)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS })
      },
    },
    [PENDING_PATH]: {
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return new Response(JSON.stringify({ ok: false, code: 'BAD_JSON' }), { status: 400, headers: JSON_HEADERS })
        }
        hooks.reportPending({
          sessionId: typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null,
          // ⚠️ `kind === null` 是**明确语义**（"这个待办已经没了"），不能与"字段缺失"混为一谈：
          // 缺失退化成 'question' 会让每一次"已清除"回报都被当成一个新的提问 ✗。
          kind: body?.kind === null
            ? null
            : typeof body?.kind === 'string' && body.kind !== '' ? body.kind : 'question',
          keys: typeof body?.keys === 'string' ? body.keys : '',
        })
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS })
      },
    },
    [STATE_PATH]: {
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response(JSON.stringify(hooks.snapshot()), { status: 200, headers: JSON_HEADERS }),
    },
    [OPENED_PATH]: {
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        hooks.ackOpen()
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS })
      },
    },
  }
}
