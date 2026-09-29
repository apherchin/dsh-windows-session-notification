<#
.SYNOPSIS
  只停用 / 恢复 profile 补丁里的 **dsh-attention 那一段 insert**，文件其它内容逐字节不动。

.DESCRIPTION
  为什么需要这个脚本：

  1. **DSH 的 web boot 门禁是「全有全无」的**。渲染端启动守卫要求**每一条** client 插件 entry 都进
     `active`，任何一条是 `failed` 或 `pending` 就 throw，桌面壳随即 `reportFatal(…, "web-boot")` ——
     **整个应用启动中止**（用户看到的就是"重启后崩溃"）。也就是说：自建 client 插件出问题时，
     应用不会给你机会在界面里把它关掉。必须能在**应用之外**、用一条命令把它摘掉。
     （2026-09-26 实测根因：client 半边往 chain 槽位 `conversation.composer` 注册时缺 `select`，
       SlotCore 抛错 ⇒ entry failed ⇒ 启动中止。详见
       `reports\dsh-attention-启动崩溃-根因-20260926.md`。）

  2. **不要走 GUI 的插件开关**。GUI 的插件/设置管理器会按自己的 store **整体重写**
     `cordis.patch.yml`：2026-09-26 一次「禁用第三方插件」把 19 个顶层条目抹成 4 个，
     本地模型路由（llm-pi-ai）、权限档位、全局提示词配置一起消失（运行中的应用几分钟后就把模型
     切到官方路由）。本脚本只改「attention 那一段」，并且**每次写入前自动备份**。

  本脚本是**幂等**的：重复跑不会有副作用；`-Disable` 后再 `-Enable`，文件内容可回到原样。

.PARAMETER Enable
  恢复启用（把被注释的那一段解注释；若文件里没有这一段则**追加**一段新的）。

.PARAMETER DryRun
  只打印会怎么改，不落盘。

.PARAMETER PatchPath
  profile 补丁路径，默认 `~\.dsh\profiles\desktop\cordis.patch.yml`。

.EXAMPLE
  # 起不来时：只停用 dsh-attention，然后完全退出并重启 DSH
  pwsh D:\DSH\Day1\plugins\dsh-attention\scripts\disable-attention.ps1

.EXAMPLE
  # 重新启用
  pwsh D:\DSH\Day1\plugins\dsh-attention\scripts\disable-attention.ps1 -Enable

.EXAMPLE
  # 只看会怎么改，不落盘
  pwsh D:\DSH\Day1\plugins\dsh-attention\scripts\disable-attention.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$Enable,
  [switch]$DryRun,
  [string]$PatchPath = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── 工具函数 ────────────────────────────────────────────────────────────

function Read-TextPreservingBom {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = if ($hasBom) {
    [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
  } else {
    [System.Text.Encoding]::UTF8.GetString($bytes)
  }
  return @{ Text = $text; HasBom = $hasBom }
}

function Find-AttentionBlock {
  <#
    返回 @{ Start; End; Kind } 或 $null。Kind: 'active' | 'commented'。
    'active'    = 顶层 `- insert:` 起、到下一个顶层 `- ` 之前，块内含 `- id: attention`
    'commented' = 顶层 `# - insert:` 起、到连续 `#` 行结束，块内含 `#     - id: attention`
  #>
  param([System.Collections.Generic.List[string]]$Lines)

  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match '^- insert:\s*$') {
      $j = $i + 1
      while ($j -lt $Lines.Count -and $Lines[$j] -notmatch '^- ') { $j++ }
      $block = $Lines.GetRange($i, $j - $i)
      if (@($block | Where-Object { $_ -match '^\s+- id: attention\s*$' }).Count -gt 0) {
        return @{ Start = $i; End = $j - 1; Kind = 'active' }
      }
      $i = $j - 1
    }
  }

  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match '^#\s*- insert:\s*$') {
      $j = $i + 1
      while ($j -lt $Lines.Count -and $Lines[$j] -match '^#') { $j++ }
      $block = $Lines.GetRange($i, $j - $i)
      if (@($block | Where-Object { $_ -match '^#\s+- id: attention\s*$' }).Count -gt 0) {
        return @{ Start = $i; End = $j - 1; Kind = 'commented' }
      }
      $i = $j - 1
    }
  }

  return $null
}

function Stop-LeftoverBadge {
  <# 停用后顺手收掉角标常驻进程（否则任务栏上那个数字图标会一直留着）。 #>
  $dir = Join-Path $env:USERPROFILE '.dsh\dsh-attention'
  $lock = Join-Path $dir 'badge.lock'
  if (-not (Test-Path -LiteralPath $lock)) { return }
  try {
    $pidText = (Get-Content -LiteralPath $lock -Raw).Trim()
    if ($pidText -match '^\d+$') {
      $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -in @('powershell', 'pwsh')) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host ("  已停掉遗留的角标进程 pid={0}" -f $pidText)
      }
    }
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
    Write-Host '  已清理 badge.lock'
  } catch {
    Write-Host ("  角标清理跳过（{0}）" -f $_.Exception.Message)
  }
}

function Test-PatchParses {
  <# 用 profile 里的 js-yaml 真解析一次；node/js-yaml 不可用就明确报"未复核"。 #>
  param([string]$Path)
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Write-Host '  ⚠ 未找到 node，跳过 YAML 复核——请人工确认文件没坏'; return }
  $profilesDir = (Split-Path -Parent (Split-Path -Parent $Path)) -replace '\\', '/'
  $env:DSH_ATTENTION_PROFILES = $profilesDir
  $script = @'
const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const patch = process.argv[1]
const candidates = [
  path.dirname(path.dirname(patch)),            // <profiles>
  path.dirname(patch),                          // <profile>
  path.join(os.homedir(), '.dsh', 'profiles'),  // 兜底（测试副本在别处时用得上）
]
let yaml
for (const dir of candidates) {
  try { yaml = createRequire(path.join(dir, 'noop.js'))('js-yaml'); break } catch { /* 下一个候选 */ }
}
if (yaml === undefined) { console.log('SKIP 未找到 js-yaml'); process.exit(0) }

const doc = yaml.load(fs.readFileSync(patch, 'utf8'))
if (!Array.isArray(doc)) { console.log('FAIL 解析结果不是数组'); process.exit(1) }
const rows = doc.filter((r) => r && typeof r === 'object' && 'insert' in r)
const ids = rows.flatMap((r) => (r.insert ?? []).map((x) => x && x.id))
console.log(`OK 顶层条目 ${doc.length}｜生效中的 insert ${rows.length} 段：${ids.join(', ') || '(无)'}`)
'@
  & node -e $script $Path
  if ($LASTEXITCODE -ne 0) { throw "✘ YAML 复核失败（$LASTEXITCODE）：补丁可能已损坏，请用 .bak-* 备份回滚" }
}

# ── 主流程 ────────────────────────────────────────────────────────────────

if (-not (Test-Path -LiteralPath $PatchPath)) { throw "找不到 profile 补丁：$PatchPath" }
$pluginEntry = (Join-Path (Split-Path -Parent $PSScriptRoot) 'index.mjs') -replace '\\', '/'

$read = Read-TextPreservingBom -Path $PatchPath
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in ($read.Text -split "`n")) { $lines.Add($line) }

$block = Find-AttentionBlock -Lines $lines
$action = if ($Enable) { 'Enable' } else { 'Disable' }

if ($action -eq 'Disable' -and $null -eq $block) {
  Write-Host '✔ 补丁里没有 attention 那一段（已经是停用状态），无需改动。'
  Stop-LeftoverBadge
  exit 0
}
if ($action -eq 'Enable' -and $block -and $block.Kind -eq 'active') {
  Write-Host '✔ attention 已经是启用状态（insert 未被注释），无需改动。'
  exit 0
}
if ($action -eq 'Disable' -and $block.Kind -eq 'commented') {
  Write-Host '✔ attention 已是停用状态（那一段被整块注释），无需改动。'
  Stop-LeftoverBadge
  exit 0
}

$replacement = [System.Collections.Generic.List[string]]::new()
if ($action -eq 'Disable') {
  foreach ($line in $lines.GetRange($block.Start, $block.End - $block.Start + 1)) {
    if ($line.Trim().Length -eq 0) { $replacement.Add('#') } else { $replacement.Add('# ' + $line) }
  }
  Write-Host ("→ 停用 attention：注释掉第 {0}-{1} 行（{2} 行）" -f ($block.Start + 1), ($block.End + 1), $replacement.Count)
} elseif ($block) {
  foreach ($line in $lines.GetRange($block.Start, $block.End - $block.Start + 1)) {
    if ($line -match '^# (.*)$') { $replacement.Add($Matches[1]) }
    elseif ($line -eq '#') { $replacement.Add('') }
    else { $replacement.Add($line) }
  }
  Write-Host ("→ 启用 attention：解注释第 {0}-{1} 行（{2} 行）" -f ($block.Start + 1), ($block.End + 1), $replacement.Count)
} else {
  $replacement.Add('')
  $replacement.Add('# ── 跨会话「需要接手」提醒 dsh-attention 的 host 半边（由 scripts\disable-attention.ps1 -Enable 追加）──')
  $replacement.Add('- insert:')
  $replacement.Add('    - id: attention')
  $replacement.Add(('      name: "' + $pluginEntry + '"'))
  $insertAt = $lines.Count
  if ($insertAt -gt 0 -and $lines[$insertAt - 1] -eq '') { $insertAt = $insertAt - 1 }
  $block = @{ Start = $insertAt; End = $insertAt - 1; Kind = 'absent' }
  Write-Host ("→ 启用 attention：在末尾追加 insert 段（index.mjs = {0}）" -f $pluginEntry)
}

if ($block.Kind -eq 'absent') {
  $lines.InsertRange($block.Start, [string[]]$replacement)
} else {
  $lines.RemoveRange($block.Start, $block.End - $block.Start + 1)
  $lines.InsertRange($block.Start, [string[]]$replacement)
}

$newText = ($lines -join "`n")
if ($newText -eq $read.Text) {
  Write-Host '（内容无变化）'
  exit 0
}
if ($DryRun) {
  Write-Host '（-DryRun：未落盘）'
  exit 0
}

$backup = "$PatchPath.bak-attention-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $PatchPath -Destination $backup -Force
$encoding = New-Object System.Text.UTF8Encoding($read.HasBom)
[System.IO.File]::WriteAllText($PatchPath, $newText, $encoding)
Write-Host ("✔ 已写入 {0}（备份：{1}）" -f $PatchPath, $backup)

Write-Host '→ 复核：'
Test-PatchParses -Path $PatchPath

if ($action -eq 'Disable') { Stop-LeftoverBadge }

Write-Host ''
Write-Host '下一步：**完全退出** DSH 再启动（关窗口不算，那只是收进托盘）：'
Write-Host '  · 托盘图标右键 → 退出应用'
Write-Host '  · 或：Get-Process ''DeepSeek Harness'' -ErrorAction SilentlyContinue | Stop-Process -Force'
Write-Host '  · 然后重新启动 DeepSeek Harness'
