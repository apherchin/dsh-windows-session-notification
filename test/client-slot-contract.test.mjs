// dsh-attention 客户端半边的**槽位注册契约**测试。
//
// 由来（2026-09-26 启动崩溃，根因见 reports\dsh-attention-启动崩溃-根因-20260926.md）：
// client.js 往 `conversation.composer` 注册时用了 **list 槽位的写法**（`id`）而该槽位是
// **chain**（ui-conversation 的 children 表：`{ kind: "chain", scope: "session" }`）⇒
// SlotCore.register 抛 `chain slot "conversation.composer" requires options.select` ⇒
// apply 抛错 ⇒ client entry 变 failed ⇒ 撞上渲染端「每个 client entry 都必须 active」的
// **全有全无**启动门禁 ⇒ 整个应用启动中止（用户侧表现＝"重启后崩溃"）。
//
// 本文件既做**离线契约断言**（不需要 app.asar），也在 app.asar 可读时把捕获到的注册参数
// 直接喂给**真的 SlotCore** 做对照。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PENDING_PATH } from '../lib/routes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_JS = path.join(HERE, '..', 'client.js')

/** app.asar 内 client-ui-slots 的路径（真 SlotCore 就在这个文件里）。 */
const SLOTS_INNER = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'

/** 本机桌面 App 的安装位置候选；取不到就跳过"真 SlotCore"那部分。 */
const ASAR_CANDIDATES = [
  process.env.DSH_ASAR,
  'C:\\Users\\chin\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar',
].filter(Boolean)

/**
 * 按 **4 字节对齐**从 app.asar 里取一个文件（与 tools\asar\asar-extract-aligned.mjs 同源公式：
 * `dataStart = 16 + headerSize` 再对齐；等价于 `8 + payloadSize`）。
 * @param {string} asarPath - app.asar 绝对路径。
 * @param {string} inner - asar 内的正斜杠路径。
 * @returns {Buffer} 文件内容。
 */
function readAsarFile(asarPath, inner) {
  const buf = fs.readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
  const rawBase = 16 + headerSize
  const dataStart = rawBase + ((4 - (rawBase % 4)) % 4)
  assert.equal(dataStart % 4, 0, '数据区起点必须 4 字节对齐')
  let node = header
  for (const part of inner.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) throw new Error(`app.asar 内找不到 ${inner}`)
  }
  return buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + Number(node.size))
}

/** 找一个能读的 app.asar；没有就返回 null（测试降级）。 */
function findAsar() {
  for (const candidate of ASAR_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch { /* 下一个候选 */ }
  }
  return null
}

/**
 * 把 client.js 当成模块加载器 bundle 求值，取出它返回的插件对象。
 * @param {{ fetch?: Function }} [options] - 可注入一个记录用的 fetch（bundle 里的 `fetch` 是注入参数）。
 * @returns {{ plugin: object, id: string }} 插件对象与其声明的模块 id。
 */
function loadClientPlugin(options = {}) {
  const source = fs.readFileSync(CLIENT_JS, 'utf8')
  assert.equal(source.charCodeAt(0) === 0xfeff, false, 'client.js 绝不能带 UTF-8 BOM（硬要求）')
  let loaded
  const intervals = []
  const fakeWindow = {
    __ModuleLoader__: { load: (spec) => { loaded = spec } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const fakeDocument = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    hasFocus: () => true,
  }
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'console', source)(
    fakeWindow,
    fakeDocument,
    options.fetch ?? (async () => ({ ok: false })),
    (callback) => { intervals.push(callback); return intervals.length },
    () => {},
    console,
  )
  assert.ok(loaded !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')
  // ⚠️ 必须与 package.json 的 name **动态比对**，不能在断言里写死字面量：
  //    2026-09-29 的真事故就是"改名后 client id 没跟"，而当时这里写死的是旧名 ⇒ 测试照样全绿。
  const pkgName = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).name
  assert.equal(loaded.id, pkgName,
    `模块 id 必须等于 package.json 的 name（当前 id=${loaded.id}，name=${pkgName}）`)
  const plugin = loaded.factory(() => { throw new Error('本插件的 client 半边不应 require 任何模块') })
  assert.equal(typeof plugin?.apply, 'function', '工厂必须返回带 apply 的插件')
  return { plugin, id: loaded.id, intervals }
}

/**
 * 用最小假 ctx 跑一次 apply，捕获槽位注册参数。
 *
 * 假 ctx 复刻客户端的真实形状：插件**不**用硬门禁 `inject: ['slots']`，而是嵌套
 * `ctx.inject(['slots'], scope => …)` —— 服务到了才用带 `slots` 的 scope 回调。
 * @param {object} plugin - 插件对象。
 * @param {{ registerThrows?: Error, noSlots?: boolean }} [options] - 让假 register 抛错 / 模拟服务没到。
 * @returns {{ registers: object[], injects: string[], serviceInjects: string[], effectLabels: string[], remoteHandlers: Record<string, Function> }} 捕获结果。
 */
function captureRegistration(plugin, options = {}) {
  const registers = []
  const injects = []
  const serviceInjects = []
  const effectLabels = []
  const remoteHandlers = {}
  const slots = {
    inject: (name, callback) => { injects.push(name); callback() },
    register: (regOptions, component) => {
      if (options.registerThrows !== undefined) throw options.registerThrows
      registers.push({ options: regOptions, component })
      return () => {}
    },
  }
  const remote = { $on: (name, handler) => { remoteHandlers[name] = handler; return () => {} } }
  const scope = {
    slots,
    remote,
    get: (name) => (name === 'remote' ? remote : name === 'slots' ? slots : undefined),
    effect: (callback, label) => { effectLabels.push(label); try { return callback() ?? (() => {}) } catch { return () => {} } },
  }
  const ctx = {
    get: (name) => {
      if (name === 'uiSession') return options.uiSession
      if (name === 'sessions') return options.sessions
      return undefined
    },
    inject: (names, callback) => {
      serviceInjects.push(names.join(','))
      if (options.noSlots === true) return // 服务始终没到：不回调，插件应保持 active
      callback(scope)
    },
    effect: (callback, label) => { effectLabels.push(label); try { return callback() ?? (() => {}) } catch { return () => {} } },
  }
  plugin.apply(ctx)
  return { registers, injects, serviceInjects, effectLabels, remoteHandlers }
}

test('client.js 以合法模块加载器 bundle 形式交付（id = 包名、无 BOM）', () => {
  const { plugin } = loadClientPlugin()
  assert.equal(typeof plugin.apply, 'function')
})

test('slots 服务走嵌套 ctx.inject(["slots"])，不用插件级硬门禁', () => {
  const { plugin } = loadClientPlugin()
  const { serviceInjects, registers } = captureRegistration(plugin)
  assert.deepEqual(
    serviceInjects.sort(),
    ['remote', 'slots'],
    'slots 与 remote 都必须用嵌套注入拿（硬门禁会让未就绪的 entry 变 pending ⇒ 整个应用起不来）',
  )
  assert.equal(registers.length, 1, '服务到了就应当完成注册')
})

test('注册 conversation.composer 用 chain 写法：有 select、没有 list 的 id', () => {
  const { plugin } = loadClientPlugin()
  const { registers, injects } = captureRegistration(plugin)
  assert.deepEqual(injects, ['conversation.composer'], '应当只 inject 这一个槽位')
  assert.equal(registers.length, 1, '应当只注册一个条目')
  const { options } = registers[0]
  assert.equal(options.name, 'conversation.composer')
  assert.equal(typeof options.select, 'function', 'chain 槽位必须给 select（否则 SlotCore 抛错）')
  assert.equal('id' in options, false, 'chain 槽位不能用 list 的 id 写法')
  assert.equal('key' in options, false, 'chain 槽位不能用 keyed 的 key 写法')
})

test('select 收到 owner props 后弃权（return null）且记下 sessionId', () => {
  const { plugin } = loadClientPlugin()
  const { registers } = captureRegistration(plugin)
  const { select } = registers[0].options
  assert.equal(select({ sessionId: 'session-abc', session: {}, pendingInteraction: null }), null, '必须弃权，让官方 fallback 渲染')
  assert.equal(select({}), null, 'owner props 缺失时也必须弃权而不是抛错')
  assert.equal(select(undefined), null, 'owner props 为 undefined 时也必须弃权而不是抛错')
})

test('槽位注册抛错时 apply 不抛（否则会升级成整个应用启动失败）', () => {
  const { plugin } = loadClientPlugin()
  assert.doesNotThrow(() => {
    captureRegistration(plugin, { registerThrows: new Error('chain slot "conversation.composer" requires options.select') })
  }, 'apply 必须自己吃掉槽位错误——DSH 的 web boot 门禁是全有全无的')
})

test('slots 服务始终没到时：apply 不抛、不注册，但焦点上报器照常挂上', () => {
  const { plugin } = loadClientPlugin()
  let captured
  assert.doesNotThrow(() => {
    captured = captureRegistration(plugin, { noSlots: true })
  }, '服务缺失时只能降级，不能抛错（pending/failed 都会让整个应用起不来）')
  assert.equal(captured.registers.length, 0, '服务没到就不该注册任何槽位')
  assert.equal(captured.effectLabels.includes('attention: client focus reporter'), true, '焦点上报器仍应挂上')
})


test('真 SlotCore 对照：chain 槽位拒绝旧的 list 写法、接受现在的写法', async (t) => {
  const asar = findAsar()
  if (asar === null) {
    t.skip('本机没有可读的 app.asar，跳过真 SlotCore 对照（离线契约断言仍已执行）')
    return
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attention-slots-'))
  const tmpFile = path.join(tmpDir, 'ui-slots.mjs')
  fs.writeFileSync(tmpFile, readAsarFile(asar, SLOTS_INNER))
  const { SlotCore } = await import(pathToFileURL(tmpFile).href)

  /** 复刻 ui-conversation 对 conversation.composer 的声明：chain / session。 */
  const core = () => {
    const instance = new SlotCore()
    const record = instance.record('conversation.composer')
    record.spec = { kind: 'chain', scope: 'session' }
    record.declaredBy = 'an entry in "conversation.session"（测试复刻）'
    return instance
  }

  // 1) 回归本体：旧写法必须抛错——这条断言一旦失败，说明本测试的前提变了，要去复核源码。
  assert.throws(
    () => core().register({ name: 'conversation.composer', id: 'dsh-attention.session-probe' }, () => null),
    /chain slot "conversation\.composer" requires options\.select/,
    '旧写法（list 的 id）本就该被 SlotCore 拒绝',
  )

  // 2) 现在的写法必须被真 SlotCore 接受。
  const { plugin } = loadClientPlugin()
  const { registers } = captureRegistration(plugin)
  assert.doesNotThrow(
    () => core().register(registers[0].options, registers[0].component),
    '现在捕获到的注册参数必须能被真 SlotCore 接受',
  )
})

test('打开会话必须用 ctx.get("uiWorkspace")：直接 ctx.uiWorkspace 拿不到服务（点击横幅无反应的根因）', () => {
  const source = fs.readFileSync(CLIENT_JS, 'utf8')
  assert.equal(
    source.includes("ctx.get('uiWorkspace')"),
    true,
    'uiWorkspace 是 cordis 服务，client 侧要用 ctx.get(...) 取（官方 ui-sidebar / ui-conversation 就是这么写的）',
  )
  assert.equal(
    /ctx\.uiWorkspace\s*[.?]/.test(source),
    false,
    '不要再写 ctx.uiWorkspace（属性访问）：它受服务门禁管辖，2026-09-26 实测"点横幅切不回来"就是它静默抛错',
  )
})

test('点击回调不再静默吞错：open 的成败要进诊断串', () => {
  const source = fs.readFileSync(CLIENT_JS, 'utf8')
  assert.equal(/openTagValue\s*=\s*openSession\(/.test(source), true, 'open 结果要记下来并上报')
  assert.equal(source.includes('open:no-service'), true, '至少要有"服务拿不到"这一类可观测的降级串')
})

test('remote 总线订阅审批与提问两个事件，且上报路径与 lib/routes.mjs 一致', () => {
  const { plugin } = loadClientPlugin()
  const { remoteHandlers } = captureRegistration(plugin)
  assert.deepEqual(Object.keys(remoteHandlers).sort(), ['approval/request', 'user-questions/request'])
  const source = fs.readFileSync(CLIENT_JS, 'utf8')
  assert.equal(source.includes(`'${PENDING_PATH}'`), true, '上报路径必须与 lib/routes.mjs 的 PENDING_PATH 逐字一致')
})

test('提问事件：用作用域 this 定位会话并上报，且必须把 next() 交回 waterfall', () => {
  const reported = []
  const { plugin } = loadClientPlugin({ fetch: async (url, init) => { reported.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body) }); return { ok: true } } })
  // 官方做法：ctx.sessions.scopeOf(监听器里的 this) ⇒ 必须用 .call(owner) 调用
  const { remoteHandlers } = captureRegistration(plugin, { sessions: { scopeOf: (owner) => (owner === undefined ? undefined : 'session-from-scope') } })
  let nextCalls = 0
  const returned = remoteHandlers['user-questions/request'].call(
    { scoped: true },
    { agent: { id: undefined }, questions: [{ intent: { kind: 'plan-review' } }] },
    () => { nextCalls += 1; return 'OUTCOME' },
  )
  assert.equal(nextCalls, 1, '必须调用 next()')
  assert.equal(returned, 'OUTCOME', '必须原样返回 next() 的结果')
  const pending = reported.filter((call) => call.url === PENDING_PATH)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].body.sessionId, 'session-from-scope', '会话 id 必须来自 ctx.sessions.scopeOf(this)')
  assert.deepEqual(pending[0].body.kind, 'plan-review')
  assert.equal(pending[0].body.keys, '[agent,questions]')
})

test('作用域 this 拿不到时会话 id 退到载荷；载荷也读不动就 null（都不抛、都交回 next）', () => {
  const reported = []
  const { plugin } = loadClientPlugin({ fetch: async (url, init) => { reported.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body) }); return { ok: true } } })
  const hostile = new Proxy({}, { get() { throw new Error('revoked: out of scope') } })
  const { remoteHandlers } = captureRegistration(plugin, { sessions: { scopeOf: () => undefined } })
  let nextCalls = 0
  assert.doesNotThrow(() => remoteHandlers['approval/request'].call(undefined, hostile, () => { nextCalls += 1; return 'OK' }))
  assert.equal(nextCalls, 1)
  const pending = reported.filter((call) => call.url === PENDING_PATH)
  assert.equal(pending[0].body.sessionId, null)
})

test('监听器必须是 function（箭头函数拿不到作用域 this ⇒ 会话 id 永远为 null）', () => {
  const source = fs.readFileSync(CLIENT_JS, 'utf8')
  assert.equal(source.includes('function reportPending('), true, '官方 answerQuestion 同样依赖 this')
  assert.equal(/const report = \(baseKind\) => \(request, next\) =>/.test(source), false, '不要再写回箭头函数')
})

test('上报用的 fetch 抛错也不影响官方链路', () => {
  const { plugin } = loadClientPlugin({ fetch: () => { throw new Error('offline') } })
  const { remoteHandlers } = captureRegistration(plugin)
  let nextCalls = 0
  assert.doesNotThrow(() => remoteHandlers['approval/request']({ agent: { id: 's' } }, () => { nextCalls += 1 }))
  assert.equal(nextCalls, 1)
})

test('remote 服务缺失时只降级、不外抛（启动门禁是全有全无的）', () => {
  const { plugin } = loadClientPlugin()
  assert.doesNotThrow(() => captureRegistration(plugin, { noSlots: true }))
})

test('待审批/待回答：从 uiSession.sessionStatus 读全部会话上报（同一待办只报一次）', async () => {
  const posted = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.endsWith('/state')) return { ok: true, json: async () => ({ unreadCount: 0 }) }
    posted.push({ target, body: init?.body === undefined ? null : JSON.parse(init.body) })
    return { ok: true }
  }
  // 快照可变：用来验证"待办消失 ⇒ 回报已清除"以及"同一会话的下一次待办还能再报"
  let rows = [
    // ⚠️ 真实形状是**对象带 .kind**（侧栏 `visiblePendingKind(status?.pendingInteraction?.kind)`）；
    // 曾经按字符串读 ⇒ 永远识别不出（日志 `pend:ok(0)`）⇒ 审批不弹。
    ['session-a', { pendingInteraction: { kind: 'question' }, running: false }],
    ['session-b', { pendingInteraction: { kind: 'approval' }, running: true }],
    ['session-c', { pendingInteraction: 'plan-review', running: false }],
    ['session-d', { running: true }],
  ]
  const uiSession = { sessionStatus: { getSnapshot: () => new Map(rows) } }
  const { plugin, intervals } = loadClientPlugin({ fetch: fetchImpl })
  captureRegistration(plugin, { uiSession })
  assert.equal(intervals.length, 1, '应当挂了一个轮询定时器')
  const tick = async () => { intervals[0](); await new Promise((resolve) => setTimeout(resolve, 0)) }
  const pendingCalls = () => posted.filter((p) => p.target.endsWith('/pending'))

  await tick()
  assert.equal(pendingCalls().length, 3, '三个待办各上报一次；没有待办的会话不上报')
  assert.deepEqual(pendingCalls().map((p) => p.body.sessionId).sort(), ['session-a', 'session-b', 'session-c'])
  assert.deepEqual(pendingCalls().map((p) => p.body.kind).sort(), ['approval', 'plan-review', 'question'])

  await tick()
  assert.equal(pendingCalls().length, 3, '同一个待办第二轮不再上报')

  // session-b 的审批被答复/取消 ⇒ 必须回报 kind=null（宿主据此清未读，并允许该会话的下一次待办再提醒）
  rows = rows.filter(([id]) => id !== 'session-b')
  await tick()
  const cleared = pendingCalls().filter((p) => p.body.kind === null)
  assert.equal(cleared.length, 1, '待办消失必须回报一次"已清除"')
  assert.equal(cleared[0].body.sessionId, 'session-b')

  // 同一会话随后又来一个待办 ⇒ 必须能再次上报
  rows = [...rows, ['session-b', { pendingInteraction: { kind: 'approval' }, running: true }]]
  await tick()
  const again = pendingCalls().filter((p) => p.body.sessionId === 'session-b' && p.body.kind === 'approval')
  assert.equal(again.length, 2, '清除之后同一会话的新待办必须能再提醒一次')
})

test('uiSession 服务拿不到时只记诊断、不外抛', () => {
  const { plugin, intervals } = loadClientPlugin()
  assert.doesNotThrow(() => captureRegistration(plugin))
  assert.doesNotThrow(() => intervals[0]())
})
