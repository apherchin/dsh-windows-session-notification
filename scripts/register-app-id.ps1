# dsh-attention 的 AppUserModelID（AUMID）注册 / 撤销（per-user，HKCU，无需管理员）。
#
# 【为什么需要】未打包应用的 Toast 顶部那行"应用名"由 `CreateToastNotifier(AUMID)` 里的 AUMID 决定；
# 该 AUMID 没有注册"显示名"时，Windows 会退化成进程名 —— 本机实测就是 **Windows PowerShell**
# （用户 2026-09-26 截图确认）。注册 `DisplayName` + `IconUri` 之后，横幅顶部显示自己的名字与图标。
#
# 【本机可对照的现成例子】（这两个应用都能正常显示自己的名字，字段就是照它们抄的）：
#   HKCU\Software\Classes\AppUserModelId\Acrobat.Reader.Notification.Manager
#       DisplayName = Acrobat Reader ｜ IconUri = …appicon_16.png ｜ CustomActivator = {…}
#   HKCU\Software\Classes\AppUserModelId\oray.sunlogin
#       DisplayName = 向日葵远程控制 ｜ IconUri = …app_unlock.ico
#
# 【图标】优先从 DSH 安装目录的 exe 抽（就是应用自己的图标）；抽不到就画一个红色圆角方块 + 白色"!"。
#
# 用法：register-app-id.ps1 -Register | -Unregister | -Status
param(
  [switch]$Register,
  [switch]$Unregister,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'

$appId = 'DSH.Attention'
$displayName = 'DeepSeek Harness'
$keyPath = "HKCU:\Software\Classes\AppUserModelId\$appId"
$stateDir = Join-Path $env:USERPROFILE '.dsh\dsh-attention'
$iconPath = Join-Path $stateDir 'appicon.png'

# DSH 桌面版的安装位置候选（用于抽取应用图标）。
$iconSources = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
)

function New-AppIcon {
  <# 生成 48×48 的 PNG 图标：优先抽 DSH 自己的图标，失败则画"红色圆角方块 + 白色 !"。 #>
  param([string]$Path)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  foreach ($exe in $iconSources) {
    if (Test-Path -LiteralPath $exe) {
      try {
        Add-Type -AssemblyName System.Drawing
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
        if ($null -ne $icon) {
          $bmp = $icon.ToBitmap()
          $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
          $bmp.Dispose(); $icon.Dispose()
          return "DSH exe 图标（$exe）"
        }
      } catch { }
    }
  }

  Add-Type -AssemblyName System.Drawing
  $size = 48
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = 11
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shape.AddArc(0, 0, $r, $r, 180, 90)
  $shape.AddArc($size - $r, 0, $r, $r, 270, 90)
  $shape.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
  $shape.AddArc(0, $size - $r, $r, $r, 90, 90)
  $shape.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 226, 60, 45))
  $g.FillPath($brush, $shape)
  $font = New-Object System.Drawing.Font 'Segoe UI', ([float]30), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('!', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, $size, $size), $fmt)
  $fmt.Dispose(); $font.Dispose(); $brush.Dispose(); $shape.Dispose(); $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return '内置绘制的红色"!"图标'
}

if ($Status) {
  Write-Host ("AUMID: {0}（显示名 {1}）" -f $appId, $displayName)
  Write-Host ("注册键存在: " + (Test-Path $keyPath))
  if (Test-Path $keyPath) {
    foreach ($name in @('DisplayName', 'IconUri', 'IconBackgroundColor')) {
      $value = (Get-ItemProperty -Path $keyPath -Name $name -ErrorAction SilentlyContinue).$name
      Write-Host ("  {0} = {1}" -f $name, $value)
    }
  }
  Write-Host ("图标文件: {0}（存在 {1}）" -f $iconPath, (Test-Path $iconPath))
  exit 0
}

if ($Unregister) {
  if (Test-Path $keyPath) { Remove-Item $keyPath -Recurse -Force; Write-Host "已撤销 AUMID 注册（横幅应用名会退回 Windows PowerShell）" }
  else { Write-Host "AUMID 未注册" }
  Remove-Item $iconPath -Force -ErrorAction SilentlyContinue
  exit 0
}

if (-not $Register) { Write-Host "用法：-Register | -Unregister | -Status"; exit 2 }

$how = New-AppIcon -Path $iconPath
New-Item -Path $keyPath -Force | Out-Null
New-ItemProperty -Path $keyPath -Name 'DisplayName' -Value $displayName -PropertyType String -Force | Out-Null
New-ItemProperty -Path $keyPath -Name 'IconUri' -Value $iconPath -PropertyType String -Force | Out-Null
New-ItemProperty -Path $keyPath -Name 'IconBackgroundColor' -Value '0xFF24292F' -PropertyType String -Force | Out-Null
Write-Host ("已注册 AUMID {0} → 显示名 '{1}'，图标 {2}（{3}）" -f $appId, $displayName, $iconPath, $how)
exit 0
