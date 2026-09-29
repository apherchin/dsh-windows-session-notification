/**
 * win-notify —— PowerShell 出口的唯一封装：spawn 参数、超时、连续失败降级。
 *
 * 三条实测约束：
 *  - 必须用 Windows PowerShell 5.1（pwsh 7 无 WinRT 类型投影）；
 *  - 不要 detached / unref（后台/脱离会话会 0x80073D54，且 PlaySync 需要进程活着播完铃声）；
 *  - 载荷一律走单个 Base64 参数（规避 Windows spawn 参数转义）。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'

/** 连续失败达到这个次数就降级为"只更新角标"。 */
export const FAILURE_THRESHOLD = 3
/** 单次 PowerShell 调用的硬超时（毫秒）。 */
export const SCRIPT_TIMEOUT_MS = 10_000

/**
 * 构造出口封装。
 * @param {{ scriptsDir: string, powershellPath: string, log: (m: string) => void, spawnImpl?: Function }} options - 依赖。
 * @returns {{ toast: Function, focus: Function, registerProtocol: Function, registerAppId: Function, stats: Function }} 出口 API。
 */
export function createWinNotify({ scriptsDir, powershellPath, log, spawnImpl = nodeSpawn }) {
  let consecutiveFailures = 0
  let degraded = false

  const encode = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

  /**
   * 跑一个一次性脚本。
   * @param {string} script - 脚本文件名。
   * @param {object} payload - 载荷。
   * @returns {boolean} 是否已发起。
   */
  function runScript(script, payload) {
    try {
      const child = spawnImpl(powershellPath, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', join(scriptsDir, script),
        '-PayloadB64', encode(payload),
      ], { windowsHide: true })
      const timer = setTimeout(() => { try { child.kill() } catch { } }, SCRIPT_TIMEOUT_MS)
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          consecutiveFailures = 0
          if (degraded) { degraded = false; log('win-notify: 已从降级恢复') }
        } else {
          consecutiveFailures += 1
          log(`win-notify: ${script} exit=${code} (连续失败 ${consecutiveFailures})`)
          if (consecutiveFailures >= FAILURE_THRESHOLD && !degraded) {
            degraded = true
            log('win-notify: 连续失败达阈值 → 降级为仅更新角标')
          }
        }
      })
      return true
    } catch (error) {
      consecutiveFailures += 1
      log(`win-notify: spawn ${script} 失败 ${String(error)}`)
      if (consecutiveFailures >= FAILURE_THRESHOLD) degraded = true
      return false
    }
  }

  return {
    /**
     * 弹一条 Toast。
     * @param {object} payload - toast 载荷。
     * @returns {boolean} 是否已发起。
     */
    toast(payload) {
      if (degraded) return false
      return runScript('toast.ps1', payload)
    },
    /**
     * 把 DSH 拉到前台。
     * @param {object} payload - 至少含 logFile。
     * @returns {boolean} 是否已发起。
     */
    focus(payload) {
      return runScript('focus.ps1', payload)
    },
    /**
     * 确保 dsh-attention 协议处理器已注册（幂等；best-effort）。
     * 为什么必须自动做：Toast 的 launch 是 `dsh-attention:open/<id>`，没注册时 Windows 会弹
     * "需要使用新应用以打开此链接"，点击回调形同虚设——实测踩过。
     * @returns {boolean} 是否已发起。
     */
    registerProtocol() {
      try {
        const child = spawnImpl(powershellPath, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', join(scriptsDir, 'protocol.ps1'),
          '-Register',
        ], { windowsHide: true })
        child.on('exit', (code) => log(`win-notify: protocol register exit=${code}`))
        return true
      } catch (error) {
        log(`win-notify: protocol register 失败 ${String(error)}`)
        return false
      }
    },
    /**
     * 确保 Toast 的 AUMID（应用标识）已注册（幂等；best-effort）。
     * 为什么必须自动做：AUMID 没有注册"显示名"时，横幅顶部会退化成进程名 —— 用户 2026-09-26 截图实证
     * 就是 "Windows PowerShell"。注册后显示自己的名字与图标。见 scripts/register-app-id.ps1。
     * @returns {boolean} 是否已发起。
     */
    registerAppId() {
      try {
        const child = spawnImpl(powershellPath, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', join(scriptsDir, 'register-app-id.ps1'),
          '-Register',
        ], { windowsHide: true })
        child.on('exit', (code) => log(`win-notify: app id register exit=${code}`))
        return true
      } catch (error) {
        log(`win-notify: app id register 失败 ${String(error)}`)
        return false
      }
    },
    /**
     * ⛔ 已退役（2026-09-26）：不在这里启动 `badge.ps1`。
     *
     * 原因：任务栏角标由**拥有窗口的进程**设置，而那是 Electron 主进程；本插件跑在宿主子进程里，
     * 跨进程 `ITaskbarList3::SetOverlayIcon` **必然失败**（实测 DSH / foobar2000 / 微信三个窗口全 `E_FAIL`，
     * 而同进程调 `SetProgressState` 全 `S_OK`）。现在角标改由渲染进程的 Badging API 负责
     * （client.js 的 `navigator.setAppBadge`，宿主经 `/api/attention/state` 的 `unreadCount` 供数）。
     * 留着旧路只会：多一个常驻 PowerShell 进程 + 每次未读数变化刷一条 `HRESULT E_FAIL`。
     * @returns {{ degraded: boolean, consecutiveFailures: number }} 出口状态。
     */
    stats() {
      return { degraded, consecutiveFailures }
    },
  }
}
