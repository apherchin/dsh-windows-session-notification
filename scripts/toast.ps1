# dsh-attention toast：WinRT 系统通知 + 分档提示音。
# 必须由 Windows PowerShell 5.1 执行（pwsh 7 不支持 WinRT 类型投影）。
# 文件必须为 UTF-8 with BOM（5.1 按 ANSI 读脚本）。
# 载荷（Base64 JSON，由 lib/payloads.mjs 生成）：{ line1, line2, line3, sound, launch, logFile }
param([Parameter(Mandatory = $true)][string]$PayloadB64)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib-common.ps1")

$payload = Read-Payload $PayloadB64
$logFile = [string]$payload.logFile
Write-AttnLog $logFile "toast: start"

$line1 = [string]$payload.line1
$line2 = [string]$payload.line2
$line3 = [string]$payload.line3
$sound = [string]$payload.sound
$launch = [string]$payload.launch

$l1 = ConvertTo-XmlText $line1
$l2 = ConvertTo-XmlText $line2
$l3 = ConvertTo-XmlText $line3
$launchXml = ConvertTo-XmlText $launch

# 正文挂 protocol 激活（点横幅任意位置即回到该会话）；自带音频静音，铃声由 SoundPlayer 播。
$audio = "<audio silent='true' />"
$line3Xml = if ($l3.Length -gt 0) { "<text>$l3</text>" } else { "" }

# `duration='short'` = 系统默认 7 秒；再配合下面的 Hide 显式收回。
# ⚠️ 原来写的是 'long'（25 秒），用户 2026-09-26 实测"横幅一直停在屏幕上不自己收回去"，
#    所以这里不再依赖系统默认时长，到点主动 Hide（见文件末尾）。
$xmlString = @"
<toast duration='short' activationType='protocol' launch='$launchXml'>
  <visual>
    <binding template='ToastGeneric'>
      <text>$l1</text>
      <text>$l2</text>
      $line3Xml
    </binding>
  </visual>
  $audio
</toast>
"@

$shown = $false
$notifier = $null
$toast = $null
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlString)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  # AUMID 决定横幅顶部那行"应用名"：注册过自己的就用（显示 DeepSeek Harness + 图标），
  # 否则退回 PowerShell 的兜底 AUMID（显示 "Windows PowerShell"）。注册见 scripts/register-app-id.ps1。
  $appId = Get-AttnAppId
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
  $shown = $true
  Write-AttnLog $logFile "toast: shown appId=$appId launch=$launch"
} catch {
  Write-AttnLog $logFile ("toast: FAILED " + $_.Exception.Message)
}

# 铃声：PlaySync 阻塞到播完，因此进程不能提前退出（也不要 detached / unref）。
if ($sound -and (Test-Path -LiteralPath $sound)) {
  try {
    Start-Sleep -Milliseconds 120
    (New-Object System.Media.SoundPlayer $sound).PlaySync()
    Write-AttnLog $logFile "toast: sound played"
  } catch {
    Write-AttnLog $logFile ("toast: sound FAILED " + $_.Exception.Message)
  }
}

# ⚠️ 刻意**不**调 `$notifier.Hide($toast)`：
#   `duration='short'` 本身就会在约 7 秒后自动收回横幅，这正是用户要的"过一会儿自己收回去"；
#   显式 Hide 只会让通知消失得更彻底 —— 用户 2026-09-26 反馈"什么通知都没有了"，
#   连"稍后从通知中心点回去"的机会都没了。留在通知中心里才是正确行为（那里还能点，仍是回会话的入口）。

if (-not $shown) { exit 1 }
exit 0
