<#
  生成全部-自动.ps1 —— NovelForge 一键全量生成（密钥从 Windows 凭据库自动读取，无需手输）

  与 生成全部.ps1 的唯一区别：不再 Read-Host 要用户粘贴 4 个 key，而是
  直接按 NovelForge 自己的规则从 Windows 凭据库读取：
    服务名 = com.novelforge.app.api（src-tauri/src/commands.rs:14）
    目标名 = <通道 id>.com.novelforge.app.api
    通道 id = config.json 的 presets[0].active[kind] 指向的 channels[kind][i].id
  凭据载荷在 Windows 上以 UTF-16LE 存放，这里按 UTF-16LE 解码。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File "宣传demo\生成全部-自动.ps1"            # 全量生成
    powershell -NoProfile -ExecutionPolicy Bypass -File "宣传demo\生成全部-自动.ps1" -Preflight # 只验证密钥可用性
    powershell -NoProfile -ExecutionPolicy Bypass -File "宣传demo\生成全部-自动.ps1" -WireOnly  # 只验证接线

  密钥安全：本脚本绝不打印任何 key 值，只打印通道名、凭据目标名、key 长度与「已读到/缺失」。
  config.json 先逐字节备份，运行结束（含报错）在 finally 里无条件还原并校验 SHA-256。
#>

[CmdletBinding()]
param(
  [switch]$Preflight,
  [switch]$WireOnly,
  [string]$NovelPath = '',
  [string]$OutDir = '',
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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
if (-not $LogPath)   { $LogPath   = Join-Path $ScriptDir 'run-full.log' }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Fail([string]$m) { Write-Host "`n[失败] $m" -ForegroundColor Red; exit 1 }
function Sha256([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash }
function Write-Utf8NoBom([string]$p, [string]$text) {
  [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# ============================== 凭据库读取（P/Invoke advapi32） ==============================
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NfCredMan {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    /// <summary>读取通用凭据的 CredentialBlob；不存在返回 null。</summary>
    public static byte[] ReadBlob(string target) {
        IntPtr p;
        if (!CredReadW(target, 1, 0, out p)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) { return null; }   // ERROR_NOT_FOUND
            throw new System.ComponentModel.Win32Exception(err);
        }
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            byte[] b = new byte[c.CredentialBlobSize];
            if (c.CredentialBlobSize > 0) { Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize); }
            return b;
        } finally {
            CredFree(p);
        }
    }
}
'@

$SecretService = 'com.novelforge.app.api'

function Read-NfSecret([string]$id) {
  $target = "$id.$SecretService"
  $blob = [NfCredMan]::ReadBlob($target)
  if ($null -eq $blob -or $blob.Length -eq 0) { return $null }
  # Windows 凭据库载荷：UTF-16LE。校验奇数位是否为 0，避免把二进制误当字符串。
  $oddZero = 0; $oddTotal = 0
  for ($i = 1; $i -lt $blob.Length; $i += 2) { $oddTotal++; if ($blob[$i] -eq 0) { $oddZero++ } }
  if ($oddTotal -gt 0 -and $oddZero -eq $oddTotal) {
    return [System.Text.Encoding]::Unicode.GetString($blob)
  }
  # 退路：按 UTF-8 解
  try { return (New-Object System.Text.UTF8Encoding($false, $true)).GetString($blob) } catch { return $null }
}

# ============================== 还原 ==============================
function Restore-Config {
  param([string]$OriginalHash)
  if (-not (Test-Path -LiteralPath $Bak)) { Say '  (没有备份文件，跳过还原)' 'Yellow'; return }
  if (Test-Path -LiteralPath $Cfg) {
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

# 把 key 内联进「当前激活的那个通道」（与 stage-runner.ts:40-45 同口径）
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
Say '=== NovelForge 全量生成（密钥自动读取） ===' 'Cyan'
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
if (-not $Preflight -and -not (Test-Path -LiteralPath $Driver)) { Fail "找不到驱动器：$Driver" }

# 崩溃兜底：上次异常退出留下的标记 -> 立刻还原
if (Test-Path -LiteralPath $Marker) {
  Say '[恢复] 发现上次运行异常退出留下的标记，正在用备份还原 config.json…' 'Yellow'
  $stale = if (Test-Path -LiteralPath $Bak) { Sha256 $Bak } else { '' }
  Restore-Config -OriginalHash $stale
}

# ============================== 读配置 + 从凭据库取 key ==============================
$cfgObj = (Get-Content -LiteralPath $Cfg -Raw -Encoding UTF8) | ConvertFrom-Json
$preset = $cfgObj.presets[0]
if (-not $preset) { Fail 'config.json 缺少 presets[0]' }

$kinds = @('llm', 'vision', 'image', 'tts')
Say '[1/5] 从 Windows 凭据库读取密钥（服务名 com.novelforge.app.api）…' 'Cyan'
$keys    = @{}
$ids     = @{}
$targets = @{}
foreach ($k in $kinds) {
  $list = @($preset.channels.$k)
  if ($list.Count -eq 0) { Say ("  {0,-6} 配置里没有该通道" -f $k) 'DarkGray'; continue }
  $activeId = $preset.active.$k
  $ch = $null
  foreach ($c in $list) { if ($c.id -eq $activeId) { $ch = $c; break } }
  if (-not $ch) { $ch = $list[0] }
  $id = $ch.id
  $ids[$k] = $id
  $targets[$k] = "$id.$SecretService"
  $secret = Read-NfSecret $id
  if ($secret -and $secret.Length -gt 0) {
    $keys[$k] = $secret
    Say ("  {0,-6} {1,-10} 目标名 {2}  -> 已读到（长度 {3}，值不打印）" -f $k, $id, $targets[$k], $secret.Length) 'Green'
  } else {
    Say ("  {0,-6} {1,-10} 目标名 {2}  -> 缺失" -f $k, $id, $targets[$k]) 'Yellow'
  }
}

if (-not $keys.ContainsKey('llm'))   { Fail 'llm 通道的 key 读不到，全量生成无法进行（未改动 config.json）' }
if (-not $keys.ContainsKey('image')) { Fail 'image 通道的 key 读不到，全量生成无法进行（未改动 config.json）' }

# ============================== 密钥可用性探测（可选） ==============================
function Probe-Status([string]$method, [string]$url, [string]$key, [string]$body, [hashtable]$extraHeaders = $null) {
  try {
    $headers = @{ Authorization = "Bearer $key"; 'Content-Type' = 'application/json' }
    if ($extraHeaders) { foreach ($hk in @($extraHeaders.Keys)) { $headers[$hk] = $extraHeaders[$hk] } }
    if ($body) {
      $r = Invoke-WebRequest -Uri $url -Method $method -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 60
    } else {
      $r = Invoke-WebRequest -Uri $url -Method $method -Headers $headers -UseBasicParsing -TimeoutSec 60
    }
    return @{ ok = $true; status = [int]$r.StatusCode; note = '' }
  } catch {
    $note = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $note = [string]$_.ErrorDetails.Message }
    $resp = $_.Exception.Response
    $code = -1
    if ($resp) {
      try { $code = [int]$resp.StatusCode } catch { $code = -1 }
      if (-not $note) {
        try {
          $stream = $resp.GetResponseStream()
          if ($stream) { $sr = New-Object System.IO.StreamReader($stream); $note = $sr.ReadToEnd(); $sr.Close() }
        } catch { }
      }
    }
    if (-not $note) { $note = $_.Exception.Message }
    if ($note.Length -gt 200) { $note = $note.Substring(0, 200) }
    # 兜底脱敏：任何情况下不把 key 打到日志里
    if ($key) { $note = $note.Replace($key, '***REDACTED***') }
    return @{ ok = $false; status = $code; note = $note }
  }
}

if ($Preflight) {
  Say ''
  Say '[探测] 用最小请求验证各通道密钥（llm 只花 1 个 token）…' 'Cyan'
  $llmBase = ($preset.channels.llm | Where-Object { $_.id -eq $ids['llm'] }).baseUrl
  $imgBase = ($preset.channels.image | Where-Object { $_.id -eq $ids['image'] }).baseUrl
  $visBase = if ($ids['vision']) { ($preset.channels.vision | Where-Object { $_.id -eq $ids['vision'] }).baseUrl } else { '' }
  $llmModel = ($preset.channels.llm | Where-Object { $_.id -eq $ids['llm'] }).model
  $llmUrl = $llmBase.TrimEnd('/') + '/chat/completions'
  $llmBody = '{"model":"' + $llmModel + '","messages":[{"role":"user","content":"ping"}],"max_tokens":1}'
  # opencode.ai 网关强制要求 x-opencode-session + 自定义 UA，否则 400 MissingSessionID
  # （openaiCompatible.ts:220-266 生产代码也是这么加的）
  $ocHeaders = $null
  if ($llmUrl -match 'opencode\.ai') {
    $ocHeaders = @{ 'x-opencode-session' = [guid]::NewGuid().ToString(); 'User-Agent' = 'NovelForge/probe' }
  }
  $r1 = Probe-Status 'POST' $llmUrl $keys['llm'] $llmBody $ocHeaders
  Say ("  llm    POST {0} -> {1}" -f $llmUrl, $(if ($r1.ok) { "HTTP $($r1.status) OK" } else { "HTTP $($r1.status) 失败" })) $(if ($r1.ok) { 'Green' } else { 'Red' })
  if ($r1.note) { Say ("         " + $r1.note) 'DarkGray' }

  $imgUrl = $imgBase.TrimEnd('/') + '/v1/models'
  $r2 = Probe-Status 'GET' $imgUrl $keys['image'] ''
  Say ("  image  GET  {0} -> {1}" -f $imgUrl, $(if ($r2.ok) { "HTTP $($r2.status) OK" } else { "HTTP $($r2.status)" })) $(if ($r2.ok) { 'Green' } else { 'Yellow' })
  if ($r2.note) { Say ("         " + $r2.note) 'DarkGray' }

  if ($ids['vision']) {
    $vUrl = $visBase.TrimEnd('/') + '/v1/models'
    $r3 = Probe-Status 'GET' $vUrl $keys['vision'] ''
    Say ("  vision GET  {0} -> {1}" -f $vUrl, $(if ($r3.ok) { "HTTP $($r3.status) OK" } else { "HTTP $($r3.status)" })) $(if ($r3.ok) { 'Green' } else { 'Yellow' })
  }
  if ($ids['tts']) {
    $tBase = ($preset.channels.tts | Where-Object { $_.id -eq $ids['tts'] }).baseUrl
    $tUrl = $tBase.TrimEnd('/') + '/v1/models'
    $r4 = Probe-Status 'GET' $tUrl $keys['tts'] ''
    Say ("  tts    GET  {0} -> {1}" -f $tUrl, $(if ($r4.ok) { "HTTP $($r4.status) OK" } else { "HTTP $($r4.status)" })) $(if ($r4.ok) { 'Green' } else { 'Yellow' })
  }
  Say ''
  if ($r1.ok) { Say '探测结论：llm 密钥可用。' 'Green' } else { Say '探测结论：llm 密钥不可用，请勿启动全量生成。' 'Red' }
  foreach ($k in @($keys.Keys)) { $keys[$k] = $null }
  $keys = $null
  exit $(if ($r1.ok) { 0 } else { 1 })
}

# ============================== 备份 + 注入 ==============================
$origHash = Sha256 $Cfg
Copy-Item -LiteralPath $Cfg -Destination $Bak -Force
Say ''
Say "[2/5] 已备份 config.json（原始 SHA-256 $($origHash.Substring(0,16))…）" 'Green'

$injected = @()
foreach ($k in $kinds) {
  if ($keys.ContainsKey($k)) {
    if (Set-InlineKey $cfgObj $k $keys[$k]) { $injected += $k }
    else { Say "  !! config.json 里没有 channels.$k，已跳过" 'Yellow' }
  }
}
if ($injected.Count -eq 0) { Fail '没有任何通道被注入（config.json 结构可能已变）' }

Write-Utf8NoBom $Marker $origHash
Write-Utf8NoBom $Cfg (ConvertTo-Json -InputObject $cfgObj -Depth 20)
Say ("[3/5] 已内联注入 key 到通道：" + ($injected -join ', ') + "（未打印任何 key 值）") 'Green'

# ============================== 运行 ==============================
$exit = 1
Push-Location $Repo
try {
  if ($WireOnly) { $env:NF_WIRE_ONLY = '1' } else { Remove-Item Env:\NF_WIRE_ONLY -ErrorAction SilentlyContinue }
  $env:NF_NOVEL  = $NovelPath
  $env:NF_OUTPUT = $OutDir
  Say ''
  Say "[4/5] 启动真实生成管线（提取 → 剧本 → 图像 → 配音 → 组装）…" 'Cyan'
  Say "      日志（原始 stdout/stderr，逐字节 UTF-8）：$LogPath" 'DarkGray'
  Say '      这一步最久（8 章约 30~90 分钟）；中途 Ctrl+C 也可以，config.json 会被还原。' 'DarkGray'
  # 走 cmd 重定向：日志是 node 的原样字节输出（UTF-8），同时也能被外部 tail 观察进度
  & cmd /c "node `"$Tsx`" `"$Driver`" > `"$LogPath`" 2>&1"
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
  Say ''
  Say "[5/5] 还原 config.json…" 'Cyan'
  Restore-Config -OriginalHash $origHash
  Remove-Item Env:\NF_NOVEL, Env:\NF_OUTPUT, Env:\NF_WIRE_ONLY -ErrorAction SilentlyContinue
  foreach ($k in @($keys.Keys)) { $keys[$k] = $null }
  $keys = $null
  [System.GC]::Collect()
}

Say ''
if ($exit -eq 0) { Say '生成完成（exit=0）！' 'Green' }
elseif ($exit -eq 2) { Say '生成结束但有失败任务（exit=2），详见日志与 failed.json。' 'Yellow' }
else { Say "生成未成功结束（exit=$exit）。config.json 已还原；重跑会按缓存只补缺失、不重复计费。" 'Yellow' }
Say "产物目录: $OutDir"
exit $exit
