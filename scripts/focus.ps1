# dsh-attention focus：把 DSH 主窗口拉到前台（点通知后"窗口到眼前"这一步）。
# 载荷：{ logFile }。文件必须 UTF-8 BOM。
#
# ⚠️ 五条实测教训（前几版都在这一步静默失效，逐条记下来）：
#   1. **窗口查找用 `[int[]]`，不能用 `[uint[]]`** —— PowerShell **没有 `uint` 类型**；
#      同一个坑早先在 badge.ps1 上踩过。
#   2. **不要在 PowerShell 里碰结构体大小**：`[Marshal]::SizeOf([类型])` 在 PS 5.1 绑到
#      `SizeOf(object)` 并抛异常。结构体全部放 C# 里构造。
#   3. **只找"可见"窗口不够**：DSH 收进托盘时窗口是 `hide()`（无 WS_VISIBLE）⇒ 两遍查找
#      （可见 → Electron 真窗口类 `Chrome_WidgetWin_1`，排除隐藏辅助窗口 `_0`）。
#   4. **后台进程直接 `SetForegroundWindow` 会被前台锁拒绝**；`AttachThreadInput` 也要求
#      调用线程是 GUI 线程（有消息队列）⇒ 先 `PeekMessage` 预热消息队列，再挂前台线程。
#   5. **`FlashWindowEx` 的返回值不是"成功"，而是"调用前该窗口是否在前台"**（很容易误读成失败）。
#      日志里改叫 `wasFg=`，并注明闪是"发出去了"。
param([Parameter(Mandatory = $true)][string]$PayloadB64)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib-common.ps1")
$payload = Read-Payload $PayloadB64
$logFile = [string]$payload.logFile
Write-AttnLog $logFile "focus: start"

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AttnWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool toggle);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint filterMin, uint filterMax, uint remove);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public int cbSize; public IntPtr hwnd; public int dwFlags; public int uCount; public int dwTimeout; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  /** 两遍查找：visibleOnly=true 只认可见窗口；false 只认 Electron 真窗口类 Chrome_WidgetWin_1。 */
  public static IntPtr FindWindow(int[] pids, bool visibleOnly) {
    var set = new HashSet<int>(pids);
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains((int)pid)) return true;
      if (visibleOnly) {
        if (!IsWindowVisible(h)) return true;
      } else {
        var cls = new StringBuilder(64); GetClassName(h, cls, 64);
        if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      }
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (best == IntPtr.Zero || area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  /**
   * 把窗口弄到前台，逐级尝试并把结果串起来（每一步都要能看出来）：
   *   already → PeekMessage 预热消息队列 + AttachThreadInput+SetForegroundWindow → ALT 键解锁 → SwitchToThisWindow
   * 返回值形如 "before=0x… attached=True set=True after1=False alt=True switched=True final=True"。
   */
  public static string ForceForegroundDetail(IntPtr hwnd) {
    // 为什么要重试：点通知的瞬间**通知中心/气泡还占着前台**，头几百毫秒抢不到；等它收起来就能抢到。
    IntPtr start = GetForegroundWindow();
    if (start == hwnd) return "startFg=self attempt=0 final=True";
    bool attached = false;
    bool set = false;
    for (int attempt = 1; attempt <= 4; attempt++) {
      MSG msg;
      PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);   // 预热消息队列：AttachThreadInput 要求 GUI 线程
      IntPtr current = GetForegroundWindow();
      uint ignored;
      uint fgThread = GetWindowThreadProcessId(current, out ignored);
      uint myThread = GetCurrentThreadId();
      bool att = fgThread != 0 && fgThread != myThread && AttachThreadInput(myThread, fgThread, true);
      bool st = SetForegroundWindow(hwnd);
      BringWindowToTop(hwnd);
      if (att) AttachThreadInput(myThread, fgThread, false);
      bool ok = GetForegroundWindow() == hwnd;
      if (!ok) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);   // VK_MENU down
        keybd_event(0x12, 0, 2, UIntPtr.Zero);   // VK_MENU up（解锁前台锁）
        SetForegroundWindow(hwnd);
        ok = GetForegroundWindow() == hwnd;
      }
      if (!ok) {
        SwitchToThisWindow(hwnd, true);
        ok = GetForegroundWindow() == hwnd;
      }
      attached = attached || att;
      set = set || st;
      if (ok) return string.Format("startFg=0x{0:X} attempt={1} attached={2} set={3} final=True", start.ToInt64(), attempt, attached, set);
      System.Threading.Thread.Sleep(150);
    }
    return string.Format("startFg=0x{0:X} attempt=4 attached={1} set={2} final=False", start.ToInt64(), attached, set);
  }

  /** 闪任务栏按钮。⚠️ 返回值是"调用前该窗口是否在前台"，不是成功与否。 */
  public static bool Flash(IntPtr hwnd) {
    var info = new FLASHWINFO();
    info.cbSize = Marshal.SizeOf(typeof(FLASHWINFO));
    info.hwnd = hwnd;
    info.dwFlags = 3 | 12;   // FLASHW_ALL | FLASHW_TIMERNOFG
    info.uCount = 3;
    return FlashWindowEx(ref info);
  }
}
'@

$pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($pids.Count -eq 0) { Write-AttnLog $logFile "focus: DSH process not found"; exit 1 }

$hwnd = [AttnWin]::FindWindow([int[]]$pids, $true)
$pass = 'visible'
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [AttnWin]::FindWindow([int[]]$pids, $false); $pass = 'hidden' }
if ($hwnd -eq [IntPtr]::Zero) { Write-AttnLog $logFile "focus: 两遍都没找到 DSH 窗口（可见/隐藏都试了）"; exit 1 }

$restored = $false
if (-not [AttnWin]::IsWindowVisible($hwnd)) {
  [AttnWin]::ShowWindow($hwnd, 5) | Out-Null   # SW_SHOW：收进托盘时是"隐藏"，不是最小化
  $restored = $true
} elseif ([AttnWin]::IsIconic($hwnd)) {
  [AttnWin]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  $restored = $true
}

$detail = [AttnWin]::ForceForegroundDetail($hwnd)
$foreground = $detail -match 'final=True'
$flashed = $false
if (-not $foreground) { $flashed = [AttnWin]::Flash($hwnd) }
Write-AttnLog $logFile "focus: done pass=$pass hwnd=$hwnd restored=$restored foreground=$foreground $detail flashWasForeground=$flashed"
exit 0
