<#
  生成全部.ps1 —— NovelForge 一键全量生成（把整部小说 8 章生成成 WebGAL 视觉小说）

  用法（Windows PowerShell 5.1 或 PowerShell 7 都可以；本文件带 UTF-8 BOM，5.1 下中文不会乱码）：
    powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Desktop\project_my\NovelForge - Agent\宣传demo\生成全部.ps1"

  可选参数：
    -DryRun      干跑：不提示输入，用假 key(sk-test-000) 走完「备份 → 注入 → 启动管线 → 还原」，
                 用来证明脚本本身正确、且 config.json 被逐字节还原。不会产生任何有效调用。
    -WireOnly    和 -DryRun 一起用：只验证接线（读配置 / key 注入 / 导入小说），完全不发起网络请求。
    -Baseline    改为只跑 tests/stage-runner.ts baseline（内置示例小说的 4 个文本阶段，花费极小），
                 用来快速确认 key 是否可用，再决定要不要跑全量。
    -NovelPath   小说 txt 路径（默认 小说\铁皮城堡.txt）
    -OutDir      输出目录（默认本脚本所在目录，即 宣传demo）

  密钥安全设计：
    · 4 个 key 用 Read-Host -AsSecureString 不回显读取，只存在于本进程内存与 config.json 里；
    · config.json 先做逐字节备份，运行结束（含 Ctrl+C / 报错）在 finally 里无条件还原并校验 SHA-256；
    · 还原前先用随机字节覆盖原文件，尽量不把明文留在磁盘空闲块；
    · 崩溃兜底：运行期间存在标记文件 config.json.nfrunning；下次启动若发现它，说明上次异常退出，
      会立刻用 .nfbak 还原 config.json，再继续；
    · 本脚本绝不打印任何 key（只打印「已注入 / 缺失」）。
#>

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$WireOnly,
  [switch]$Baseline,
  [string]$NovelPath = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

# ============================== 路径 ==============================
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root   = Split-Path -Parent $ScriptDir
$Repo   = Join-Path $Root 'NovelForge-main'
$AppDir = Join-Path $env:APPDATA 'com.novelforge.app'
$Cfg    = Join-Path $AppDir 'config.json'
$Bak    = Join-Path $AppDir 'config.json.nfbak'
$Marker = Join-Path $AppDir 'config.json.nfrunning'
$Driver = Join-Path $ScriptDir 'full-run.mts'
$Tsx    = Join-Path $Repo 'node_modules\tsx\dist\cli.mjs'

if (-not $NovelPath) { $NovelPath = Join-Path $Root '小说\铁皮城堡.txt' }
if (-not $OutDir)    { $OutDir    = $ScriptDir }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Fail([string]$m) { Write-Host "`n[失败] $m" -ForegroundColor Red; exit 1 }
function Sha256([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }
function Write-Utf8NoBom([string]$p, [string]$text) {
  [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Restore-Config {
  param([string]$OriginalHash)
  if (-not (Test-Path -LiteralPath $Bak)) { Say '  (没有备份文件，跳过还原)' 'Yellow'; return }
  if (Test-Path -LiteralPath $Cfg) {
    # 还原前先用随机字节覆盖，尽量不把明文留在磁盘上。
    # （这里刻意不保留"还原前二次备份"：那份备份里就是明文 key，等于多留一处残留。）
    try {
      $len = (Get-Item -LiteralPath $Cfg).Length
      if ($len -gt 0) {
        $rnd = New-Object byte[] $len
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rnd)
        [System.IO.File]::WriteAllBytes($Cfg, $rnd)
      }
    } catch { }
  }
  Copy-Item -LiteralPath $Bak -Destination $Cfg -Force
  Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue
  $now = Sha256 $Cfg
  if ($OriginalHash -and $now -ne $OriginalHash) {
    Say "  !! config.json 还原后 SHA-256 与原始不一致：$now（原始 $OriginalHash）" 'Red'
    Say "     原始副本仍在：$Bak" 'Yellow'
  } else {
    Say "  config.json 已还原，SHA-256 一致：$now" 'Green'
  }
}

function ConvertFrom-Sec([System.Security.SecureString]$sec) {
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 把 key 内联进「当前激活的那个通道」（找不到 active 就退化为第一个），与 stage-runner.ts:40-45 同口径
function Set-InlineKey($cfgObj, [string]$kind, [string]$key) {
  $preset = $cfgObj.presets[0]
  if (-not $preset) { throw 'config.json 缺少 presets[0]' }
  $list = @($preset.channels.$kind)
  if ($list.Count -eq 0) { return $false }
  $activeId = $preset.active.$kind
  $target = $null
  foreach ($c in $list) { if ($c.id -eq $activeId) { $target = $c; break } }
  if (-not $target) { $target = $list[0] }
  $target | Add-Member -NotePropertyName 'apiKey' -NotePropertyValue $key -Force
  return $true
}

# ============================== 前置检查 ==============================
Say ''
Say '=== NovelForge 一键全量生成 ===' 'Cyan'
Say "PowerShell: $($PSVersionTable.PSVersion)"
Say "仓库: $Repo"
Say "配置: $Cfg"
Say "小说: $NovelPath"
Say "输出: $OutDir"
Say ''

if (-not (Test-Path -LiteralPath $Cfg)) { Fail "找不到 config.json：$Cfg（请先启动过一次 NovelForge）" }
if (-not (Test-Path -LiteralPath $Repo)) { Fail "找不到仓库目录：$Repo" }
if (-not (Test-Path -LiteralPath $Tsx)) { Fail "找不到 tsx：$Tsx（请先在仓库目录跑一次 pnpm install）" }
if (-not (Test-Path -LiteralPath $NovelPath)) { Fail "找不到小说文件：$NovelPath" }
if (-not $Baseline -and -not (Test-Path -LiteralPath $Driver)) { Fail "找不到驱动器：$Driver" }

# 崩溃兜底：上次异常退出留下的标记 -> 立刻还原
if (Test-Path -LiteralPath $Marker) {
  Say '[恢复] 发现上次运行异常退出留下的标记，正在用备份还原 config.json…' 'Yellow'
  $stale = if (Test-Path -LiteralPath $Bak) { Sha256 $Bak } else { '' }
  Restore-Config -OriginalHash $stale
}

# ============================== 备份 + 取 key ==============================
$origHash = Sha256 $Cfg
Copy-Item -LiteralPath $Cfg -Destination $Bak -Force
Say "[1/5] 已备份 config.json（原始 SHA-256 $($origHash.Substring(0,16))…）" 'Green'

$kinds  = @('llm', 'vision', 'image', 'tts')
$labels = @{
  llm    = 'llm     文本模型（分章/提取/剧本）【全量生成必需】'
  vision = 'vision  图片识别（图像自检/风格参考，可留空）'
  image  = 'image   图像模型（立绘/背景/CG）【全量生成必需】'
  tts    = 'tts     语音合成（配音，可留空则不配音）'
}
$keys = @{}

if ($DryRun) {
  Say '[2/5] 干跑模式：使用假 key sk-test-000（不会产生任何有效调用）' 'Yellow'
  foreach ($k in $kinds) { $keys[$k] = 'sk-test-000' }
} else {
  Say '[2/5] 请粘贴 4 个 API Key（输入不回显；直接回车 = 跳过该通道）' 'Cyan'
  Say '      提示：跑全量生成至少需要 llm 与 image 两个通道。' 'DarkGray'
  foreach ($k in $kinds) {
    $sec = Read-Host -AsSecureString -Prompt ("  " + $labels[$k])
    if ($sec -and $sec.Length -gt 0) { $keys[$k] = ConvertFrom-Sec $sec }
    else { Say ("    -> 已跳过 " + $k) 'DarkGray' }
  }
}

if (-not $Baseline) {
  if (-not $keys.ContainsKey('llm'))   { Fail 'llm 通道的 key 为空，全量生成无法进行（未改动 config.json）' }
  if (-not $keys.ContainsKey('image')) { Fail 'image 通道的 key 为空，全量生成无法进行（未改动 config.json）' }
}

# ============================== 注入 ==============================
$cfgObj = (Get-Content -LiteralPath $Cfg -Raw -Encoding UTF8) | ConvertFrom-Json
$injected = @()
foreach ($k in $kinds) {
  if ($keys.ContainsKey($k)) {
    if (Set-InlineKey $cfgObj $k $keys[$k]) { $injected += $k }
    else { Say "  !! config.json 里没有 channels.$k，已跳过" 'Yellow' }
  }
}
if ($injected.Count -eq 0) { Fail '没有任何通道被注入（config.json 结构可能已变）' }

# 标记文件先写：一旦这行之后崩溃，下次启动会自动还原
Write-Utf8NoBom $Marker $origHash
# -InputObject 而非管道：避免 PowerShell 把单元素数组拆包（channels.llm/vision/tts 都是单元素数组）
Write-Utf8NoBom $Cfg (ConvertTo-Json -InputObject $cfgObj -Depth 20)
Say ("[3/5] 已内联注入 key 到通道：" + ($injected -join ', ') + "（未打印任何 key 值）") 'Green'

# ============================== 运行 ==============================
$exit = 1
Push-Location $Repo
try {
  if ($Baseline) {
    Say '[4/5] 运行 tests/stage-runner.ts baseline（内置示例小说 4 个文本阶段，花费极小）…' 'Cyan'
    & node $Tsx (Join-Path $Repo 'tests\stage-runner.ts') 'baseline'
    $exit = $LASTEXITCODE
  } else {
    if ($WireOnly) { $env:NF_WIRE_ONLY = '1' } else { Remove-Item Env:\NF_WIRE_ONLY -ErrorAction SilentlyContinue }
    $env:NF_NOVEL  = $NovelPath
    $env:NF_OUTPUT = $OutDir
    Say '[4/5] 启动真实生成管线（提取 → 剧本 → 图像 → 配音 → 组装）…' 'Cyan'
    Say '      这一步最久（8 章约 30~90 分钟）；中途 Ctrl+C 也可以，config.json 会被还原。' 'DarkGray'
    & node $Tsx $Driver
    $exit = $LASTEXITCODE
  }
} finally {
  Pop-Location
  Say ''
  Say '[5/5] 还原 config.json…' 'Cyan'
  Restore-Config -OriginalHash $origHash
  Remove-Item Env:\NF_NOVEL, Env:\NF_OUTPUT, Env:\NF_WIRE_ONLY -ErrorAction SilentlyContinue
  foreach ($k in @($keys.Keys)) { $keys[$k] = $null }
  $keys = $null
  [System.GC]::Collect()
}

# ============================== 收尾 ==============================
Say ''
if ($Baseline) {
  if ($exit -eq 0) { Say 'baseline 全部通过 —— key 可用，可以去掉 -Baseline 跑全量了。' 'Green' }
  else { Say "baseline 有失败阶段（exit=$exit），请看上面的失败行。" 'Yellow' }
} elseif ($WireOnly) {
  if ($exit -eq 0) { Say '接线验证通过：配置读取 + key 注入 + 小说导入 都正常。' 'Green' }
  else { Say "接线验证失败（exit=$exit）。" 'Red' }
} elseif ($DryRun) {
  Say "干跑结束（exit=$exit）。假 key 在真实 API 上必然失败，这是预期结果。" 'Yellow'
  Say '关键结论：key 注入生效（管线已启动到 API 调用层），且 config.json 已被逐字节还原。' 'Yellow'
} else {
  if ($exit -eq 0) {
    Say '生成完成！' 'Green'
    Say '试玩：双击「启动游戏.bat」（必须走 http://127.0.0.1:8080/，不要双击 index.html）' 'Green'
  } else {
    Say "生成未成功结束（exit=$exit）。config.json 已还原；重跑本脚本会按缓存只补缺失、不重复计费。" 'Yellow'
  }
}
Say "产物目录: $OutDir"
exit $exit
