# dsh-attention 协议处理器注册/撤销（per-user，HKCU，无需管理员）。
# 处理器把被点击的 URI 追写进 clicks.log，宿主轮询该文件。
# 用法：protocol.ps1 -Register | -Unregister | -Status
param(
  [switch]$Register,
  [switch]$Unregister,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$protoKey = "HKCU:\Software\Classes\dsh-attention"
$clicksFile = Join-Path $env:USERPROFILE ".dsh\dsh-attention\clicks.log"
$handlerCmd = Join-Path $env:USERPROFILE ".dsh\dsh-attention\click-handler.cmd"

function Write-ClickHandler {
  $dir = Split-Path -Parent $clicksFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  # .cmd 必须纯 ASCII
  $lines = @(
    '@echo off',
    ('echo %DATE% %TIME% %1>> "{0}"' -f $clicksFile)
  )
  [System.IO.File]::WriteAllLines($handlerCmd, $lines, (New-Object Text.ASCIIEncoding))
}

if ($Status) {
  Write-Host ("协议键存在: " + (Test-Path $protoKey))
  $cmdKey = Join-Path $protoKey "shell\open\command"
  if (Test-Path $cmdKey) { Write-Host ("处理器: " + (Get-ItemProperty $cmdKey).'(default)') }
  Write-Host ("clicks.log 存在: " + (Test-Path $clicksFile))
  exit 0
}

if ($Unregister) {
  if (Test-Path $protoKey) { Remove-Item $protoKey -Recurse -Force; Write-Host "已撤销 dsh-attention 协议注册" }
  else { Write-Host "协议未注册" }
  exit 0
}

if (-not $Register) { Write-Host "用法：-Register | -Unregister | -Status"; exit 2 }

Write-ClickHandler
New-Item -Path $protoKey -Force | Out-Null
New-ItemProperty -Path $protoKey -Name '(default)' -Value 'URL:DSH Attention' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $protoKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$cmdPath = Join-Path $protoKey "shell\open\command"
New-Item -Path $cmdPath -Force | Out-Null
New-ItemProperty -Path $cmdPath -Name '(default)' -Value ('"{0}" "%1"' -f $handlerCmd) -PropertyType String -Force | Out-Null
Write-Host ("已注册 dsh-attention -> " + ('"{0}" "%1"' -f $handlerCmd))
exit 0
