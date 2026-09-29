# dsh-attention badge：常驻，轮询状态文件，把未读会话数画成任务栏 overlay 角标。
# 载荷（Base64 JSON）：{ stateFile, parentPid, logFile, lockFile }
# 文件必须 UTF-8 with BOM。由宿主用 PowerShell 5.1 spawn（不要 detached / unref）。
#
# ⛔ 已退役（2026-09-26）：**宿主不再 spawn 本脚本**。
#   任务栏角标只能由「拥有那个窗口的进程」设置，而那是 Electron 主进程；本脚本是宿主子进程，
#   跨进程调 ITaskbarList3::SetOverlayIcon **必然失败** —— 实测对 DSH / foobar2000 / 微信三个窗口
#   全返回 E_FAIL（同一个接口的 SetProgressState 三个窗口都 S_OK，证明接口与调用序没问题）。
#   角标现由渲染进程的 Badging API（`navigator.setAppBadge`，见 client.js）负责，宿主经
#   `/api/attention/state` 的 `unreadCount` 供数。
#   保留此文件的用途：① 记录这条死路的证据；② disable-attention.ps1 / uninstall.ps1 仍按 lock 文件
#   清理可能残留的进程。不要再把它接回宿主（win-notify.mjs 里的 startBadge 已删除）。
param([Parameter(Mandatory = $true)][string]$PayloadB64)

$ErrorActionPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "lib-common.ps1")

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AttnBadgeNative {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pfwi);
  public static IntPtr FindMain(int[] pids) {
    var set = new HashSet<int>(pids);
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains((int)pid) || !IsWindowVisible(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
[ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList3 {
  void HrInit(); void AddTab(IntPtr h); void DeleteTab(IntPtr h); void ActivateTab(IntPtr h); void SetActiveAlt(IntPtr h);
  void MarkFullscreenWindow(IntPtr h, [MarshalAs(UnmanagedType.Bool)] bool f);
  void SetProgressValue(IntPtr h, ulong a, ulong b); void SetProgressState(IntPtr h, int f);
  void RegisterTab(IntPtr a, IntPtr b); void UnregisterTab(IntPtr a); void SetTabOrder(IntPtr a, IntPtr b);
  void SetTabActive(IntPtr a, IntPtr b, uint r); void ThumbBarAddButtons(IntPtr h, uint c, IntPtr p);
  void ThumbBarUpdateButtons(IntPtr h, uint c, IntPtr p); void ThumbBarSetImageList(IntPtr h, IntPtr i);
  void SetOverlayIcon(IntPtr h, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string desc);
  void SetThumbnailTooltip(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] string tip);
  void SetThumbnailClip(IntPtr h, IntPtr r); void SetTabProperties(IntPtr a, int f); void SetJumpList(IntPtr h, IntPtr j);
}
public static class AttnOverlay {
  private static ITaskbarList3 _tlb; private static bool _ready;
  [DllImport("ole32.dll")] public static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint ctx, ref Guid iid, out IntPtr ppv);
  public static bool Init() {
    if (_ready) return true;
    Guid clsid = new Guid("56FDF344-FD6D-11d0-958A-006097C9A090");
    Guid iid = typeof(ITaskbarList3).GUID; IntPtr ppv;
    int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out ppv);
    if (hr < 0) return false;
    _tlb = (ITaskbarList3)Marshal.GetObjectForIUnknown(ppv); _tlb.HrInit(); _ready = true; return true;
  }
  public static void Set(long hwnd, long hicon, string desc) { if (_ready) _tlb.SetOverlayIcon(new IntPtr(hwnd), new IntPtr(hicon), desc); }
}
'@

$payload = Read-Payload $PayloadB64
$stateFile = [string]$payload.stateFile
$logFile = [string]$payload.logFile
$lockFile = [string]$payload.lockFile
$parentPid = 0
try { $parentPid = [int]$payload.parentPid } catch { }
if ([string]::IsNullOrEmpty($stateFile)) { Write-AttnLog $logFile "badge: no stateFile"; exit 2 }

# 单实例守卫
if (-not [string]::IsNullOrEmpty($lockFile) -and (Test-Path $lockFile)) {
  $existing = 0
  try { $existing = [int](Get-Content $lockFile -Raw) } catch { }
  if ($existing -gt 0 -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) { exit 0 }
}
if (-not [string]::IsNullOrEmpty($lockFile)) {
  try { [IO.File]::WriteAllText($lockFile, [string]$PID) } catch { }
}

$overlayReady = $false
try { $overlayReady = [AttnOverlay]::Init() } catch { }
Write-AttnLog $logFile ("badge: started pid=$PID overlayReady=$overlayReady")

$script:icons = @{}
function New-Bubble([string]$Text) {
  if ($script:icons.ContainsKey($Text)) { return $script:icons[$Text] }
  $S = 64                                       # 16px 逻辑尺寸的 4x 超采样
  $bmp = New-Object System.Drawing.Bitmap($S, $S)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $m = 3; $d = $S - 2 * $m
  $rect = New-Object System.Drawing.RectangleF $m, $m, $d, $d
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 226, 60, 45))
  $g.FillEllipse($brush, $rect); $brush.Dispose()
  $fs = if ($Text.Length -ge 3) { $d * 0.42 } elseif ($Text.Length -eq 2) { $d * 0.5 } else { $d * 0.62 }
  $font = New-Object System.Drawing.Font "Segoe UI", ([float]$fs), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sz = $g.MeasureString($Text, $font)
  $g.DrawString($Text, $font, [System.Drawing.Brushes]::White, [float](($S - $sz.Width) / 2), [float](($S - $sz.Height) / 2))
  $font.Dispose(); $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  $script:icons[$Text] = $icon
  return $icon
}

$script:last = -1
$script:stop = $false
while (-not $script:stop) {
  try {
    # 父进程守卫：DSH 宿主没了就自己退出（避免留僵尸进程）
    if ($parentPid -gt 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) {
      Write-AttnLog $logFile "badge: parent $parentPid gone, exiting"; break
    }

    $count = 0
    try {
      $raw = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8)
      $parsed = $raw | ConvertFrom-Json
      $count = [int]$parsed.count
    } catch { }

    $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $hwnd = [IntPtr]::Zero
    if ($pids.Count -gt 0) { $hwnd = [AttnBadgeNative]::FindMain([int[]]$pids) }

    if ($hwnd -ne [IntPtr]::Zero -and $count -ne $script:last -and $overlayReady) {
      $script:last = $count
      if ($count -gt 0) {
        $text = if ($count -gt 99) { "99+" } else { [string]$count }
        $ico = New-Bubble $text
        [AttnOverlay]::Set($hwnd.ToInt64(), $ico.Handle.ToInt64(), "$count 个会话待查看")
        Write-AttnLog $logFile "badge: set $count"
      } else {
        [AttnOverlay]::Set($hwnd.ToInt64(), 0, "")
        Write-AttnLog $logFile "badge: cleared"
      }
    }
  } catch {
    Write-AttnLog $logFile ("badge: loop error " + $_.Exception.Message)
  }
  Start-Sleep -Milliseconds 1500
}

# 清理：清角标 + 销毁 HICON + 删锁
try {
  $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($pids.Count -gt 0 -and $overlayReady) {
    $hwnd = [AttnBadgeNative]::FindMain([int[]]$pids)
    if ($hwnd -ne [IntPtr]::Zero) { [AttnOverlay]::Set($hwnd.ToInt64(), 0, "") }
  }
} catch { }
foreach ($icon in $script:icons.Values) { try { [AttnBadgeNative]::DestroyIcon($icon.Handle) | Out-Null; $icon.Dispose() } catch { } }
if (-not [string]::IsNullOrEmpty($lockFile)) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
Write-AttnLog $logFile "badge: exited"
exit 0
