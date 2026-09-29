# dsh-attention 卸载：撤销协议注册、停掉角标进程、清理状态目录。
# 用法：uninstall.ps1 [-KeepState]
param([switch]$KeepState)
$ErrorActionPreference = 'Continue'
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$home_ = Join-Path $env:USERPROFILE '.dsh\dsh-attention'

# 1) 撤销协议注册
& $ps51 -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'protocol.ps1') -Unregister

# 1.5) 撤销 AUMID 注册（横幅应用名的自定义显示；不清掉会在通知设置里留一条孤零零的"DeepSeek Harness"）
& $ps51 -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'register-app-id.ps1') -Unregister

# 2) 停角标（按锁文件里的 PID）
$lock = Join-Path $home_ 'badge.lock'
if (Test-Path $lock) {
  $badgePid = 0
  try { $badgePid = [int](Get-Content $lock -Raw) } catch { }
  if ($badgePid -gt 0) { Stop-Process -Id $badgePid -Force -ErrorAction SilentlyContinue }
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}

# 3) 清状态
if (-not $KeepState -and (Test-Path $home_)) { Remove-Item $home_ -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host 'dsh-attention 已卸载（别忘了从 profiles\desktop\cordis.patch.yml 里删掉对应 insert 行）'
