# 公共：Base64 载荷解码 + 日志 + XML 转义。被 toast.ps1 / badge.ps1 / focus.ps1 点源。
function Read-Payload([string]$PayloadB64) {
  if ([string]::IsNullOrEmpty($PayloadB64)) { return @{} }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
    return ($json | ConvertFrom-Json)
  } catch { return @{} }
}

function Write-AttnLog([string]$LogFile, [string]$Message) {
  if ([string]::IsNullOrEmpty($LogFile)) { return }
  try {
    $dir = Split-Path -Parent $LogFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"), $Message) -Encoding UTF8
  } catch { }
}

function ConvertTo-XmlText([string]$Value) {
  if ($null -eq $Value) { return "" }
  return $Value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&apos;")
}

# dsh-attention 自己的 AUMID（由 scripts/register-app-id.ps1 注册）。注册它之后，通知横幅顶部的
# "应用名"才显示自己的名字；没注册时会退化成进程名 "Windows PowerShell"（用户 2026-09-26 截图实证）。
$script:AttnAppId = 'DSH.Attention'
$script:AttnFallbackAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

function Get-AttnAppId {
  <# 已注册自己的 AUMID 就用它；否则退回 PowerShell 的兜底 AUMID（通知照样能弹，只是名字难看）。 #>
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\AppUserModelId\DSH.Attention')
    if ($null -ne $key) { $key.Close(); return $script:AttnAppId }
  } catch { }
  return $script:AttnFallbackAppId
}
