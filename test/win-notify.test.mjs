import test from 'node:test'
import assert from 'node:assert/strict'
import { createWinNotify, FAILURE_THRESHOLD } from '../lib/win-notify.mjs'

function fakeSpawn(script) {
  const calls = []
  const fn = (file, args, opts) => {
    calls.push({ file, args, opts })
    return script(calls.length)
  }
  fn.calls = calls
  return fn
}

const base = {
  scriptsDir: 'D:\\x\\scripts',
  powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  log: () => {},
}

test('toast：用 5.1 + -File toast.ps1 + Base64 单参数，且不 detached', () => {
  const spawn = fakeSpawn(() => ({ on: () => {}, unref: () => {} }))
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  notify.toast({ line1: 'a', line2: 'b' })
  const c = spawn.calls[0]
  assert.match(c.file, /powershell\.exe$/i)
  assert.ok(c.args.includes('-File'))
  assert.ok(c.args.some((a) => String(a).endsWith('toast.ps1')))
  assert.ok(c.args.includes('-PayloadB64'))
  assert.equal(c.opts.detached, undefined)
})

test('连续失败达到阈值后进入降级，不再 spawn toast', () => {
  const spawn = fakeSpawn(() => ({ on: (ev, cb) => { if (ev === 'exit') cb(1) }, unref: () => {} }))
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  for (let i = 0; i < FAILURE_THRESHOLD; i++) notify.toast({ line1: 'x' })
  const before = spawn.calls.length
  notify.toast({ line1: 'y' })
  assert.equal(spawn.calls.length, before)
  assert.equal(notify.stats().degraded, true)
})

test('focus 也走同一封装', () => {
  const spawn = fakeSpawn(() => ({ on: () => {}, unref: () => {} }))
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  notify.focus({ logFile: 'x' })
  assert.ok(spawn.calls[0].args.some((a) => String(a).endsWith('focus.ps1')))
})

test('COM 角标已退役：宿主不再提供 startBadge（跨进程 SetOverlayIcon 必失败，改走渲染进程 Badging API）', () => {
  const spawn = fakeSpawn(() => ({ on: () => {}, unref: () => {}, pid: 4242 }))
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  assert.equal('startBadge' in notify, false, '不要再把这条死路加回来')
  assert.equal('badgeRunning' in notify.stats(), false)
})

test('spawn 抛异常时不崩，且计入失败', () => {
  const spawn = () => { throw new Error('boom') }
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  assert.doesNotThrow(() => notify.toast({ line1: 'x' }))
  assert.equal(notify.stats().consecutiveFailures > 0, true)
})

test('registerProtocol 走 -File protocol.ps1 -Register（不带 PayloadB64）', () => {
  const spawn = fakeSpawn(() => ({ on: () => {}, unref: () => {} }))
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  notify.registerProtocol()
  const c = spawn.calls[0]
  assert.ok(c.args.some((a) => String(a).endsWith('protocol.ps1')))
  assert.ok(c.args.includes('-Register'))
  assert.equal(c.args.includes('-PayloadB64'), false)
})

test('registerAppId 走 -File register-app-id.ps1 -Register（不带 PayloadB64）', () => {
  const spawn = fakeSpawn(() => ({ on: () => {}, unref: () => {} }))
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  notify.registerAppId()
  const c = spawn.calls[0]
  assert.ok(c.args.some((a) => String(a).endsWith('register-app-id.ps1')), '要跑 AUMID 注册脚本，否则横幅会显示 Windows PowerShell')
  assert.ok(c.args.includes('-Register'))
  assert.equal(c.args.includes('-PayloadB64'), false)
})

test('registerAppId spawn 抛错时不崩，只记日志', () => {
  const spawn = fakeSpawn(() => { throw new Error('boom') })
  const notify = createWinNotify({ ...base, spawnImpl: spawn })
  assert.doesNotThrow(() => notify.registerAppId())
})
