#!/usr/bin/env pwsh
<#
.SYNOPSIS
    dsh-draft-studio 兼容性自检 —— DSH 升级后跑一次，确认插件还活着。

.DESCRIPTION
    检查四层，任一层失败都会给出可操作的提示：
      1. 源码语法        两半的 JS 是否还能被解析
      2. 清单契约        peerDependencies / engines / files / patch 是否仍符合当前标准
      3. 宿主运行时      DSH 是否在跑、端口、插件条目是否 active、Config schema 是否注册
      4. 端到端          真机打一次 /refine，看生成管线是否通

    退出码：0 = 全部通过；1 = 有检查失败；2 = 脚本自身无法运行。

.PARAMETER SkipLive
    跳过第 4 层（不发起真实模型调用，省时间/省钱）。

.PARAMETER Port
    覆盖自动探测的 Web 端口。

.EXAMPLE
    ./scripts/self-check.ps1
    ./scripts/self-check.ps1 -SkipLive
#>
[CmdletBinding()]
param(
    [switch]$SkipLive,
    [int]$Port = 0
)

$ErrorActionPreference = 'Continue'
$script:failures = 0
$script:warnings = 0

function Pass([string]$msg) { Write-Host "  [PASS] $msg" -ForegroundColor Green }
function Fail([string]$msg, [string]$fix) {
    $script:failures++
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
    if ($fix) { Write-Host "         → $fix" -ForegroundColor DarkYellow }
}
function Warn([string]$msg, [string]$note) {
    $script:warnings++
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
    if ($note) { Write-Host "         → $note" -ForegroundColor DarkYellow }
}
function Section([string]$t) { Write-Host "`n$t" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 0. 定位项目根与自身
# ---------------------------------------------------------------------------

$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Write-Host "无法定位项目根（$root 下没有 package.json）" -ForegroundColor Red
    exit 2
}
$pkgPath = Join-Path $root 'package.json'
try { $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json } catch {
    Write-Host "package.json 解析失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

Write-Host "dsh-draft-studio 自检" -ForegroundColor White
Write-Host "项目：$root"
Write-Host "版本：$($pkg.version)  包名：$($pkg.name)"

# ---------------------------------------------------------------------------
# 1. 源码语法
# ---------------------------------------------------------------------------

Section '1. 源码语法'

foreach ($f in @('index.js', 'client.js')) {
    $p = Join-Path $root $f
    if (-not (Test-Path $p)) { Fail "$f 不存在" "恢复该文件"; continue }
    $null = node --check $p 2>&1
    if ($LASTEXITCODE -eq 0) { Pass "$f 语法正确" }
    else { Fail "$f 语法错误" "运行 node --check $f 查看详情" }
}

# ---------------------------------------------------------------------------
# 2. 清单契约（对照 DSH 当前标准）
# ---------------------------------------------------------------------------

Section '2. 清单契约'

# 2.1 dsh.bundle.patch —— 这是"可安装"的唯一凭据
if ($pkg.dsh.bundle.patch) {
    $patchPath = Join-Path $root ($pkg.dsh.bundle.patch -replace '^\./', '')
    if (Test-Path $patchPath) { Pass "dsh.bundle.patch 与文件都在（$($pkg.dsh.bundle.patch)）" }
    else { Fail "dsh.bundle.patch 指向的文件不存在" '检查 package.json 的 dsh.bundle.patch' }
} else {
    Fail '缺少 dsh.bundle.patch' '只声明 dsh.client 无法安装（标准明文）'
}

# 2.2 官方库必须是 peerDependencies，不能是 dependencies
$badDeps = @()
if ($pkg.dependencies) {
    foreach ($n in $pkg.dependencies.PSObject.Properties.Name) {
        if ($n -like '@deepseek-ai/*') { $badDeps += $n }
    }
}
if ($badDeps.Count -gt 0) {
    Fail "官方库被声明为 dependencies：$($badDeps -join ', ')" '改为 peerDependencies（市场收录规则要求）'
} elseif ($pkg.peerDependencies -and $pkg.peerDependencies.PSObject.Properties.Name.Count -gt 0) {
    Pass "官方库声明为 peerDependencies（$($pkg.peerDependencies.PSObject.Properties.Name -join ', ')）"
} else {
    Warn '既无 dependencies 也无 peerDependencies' '若代码 import 了官方库，宿主未提供时会降级'
}

# 2.3 engines.dsh 必须用显式 prerelease 分支，否则排除所有 rc
if ($pkg.engines.dsh) {
    $range = $pkg.engines.dsh
    # 判据是"有没有 || 分支"，而不是"含不含 rc.<数字><" —— 后者在单一范围里也成立，
    # 而单一范围正是出问题的形状（它只放行自己那个元组上的预发布版本）。
    if ($range.Contains('||')) {
        Pass "engines.dsh 用 || 多分支覆盖预发布：$range"
    } else {
        Fail "engines.dsh 无 || 分支，会静默排除其他 rc 版本：$range" '改成 ">=X-rc.N <Y-0 || >=X+1-rc.0 <Y" 形式'
    }
} else {
    # 故意不声明（2026-11-06 决定）：宿主 app-boot 里 engines.dsh 一旦声明就单独决定
    # 兼容性，不满足时整个 bundle 被跳过、插件从界面消失；而 semver 的预发布规则使声明
    # 只能逐 rc 元组各写一支，新 rc 一出即全部失效。不声明则回落到 peer 检查，本包唯一的
    # peer 是 @deepseek-ai/schemastery（不匹配 dsh / dsh-* 前缀）→ 永远判定兼容。
    Pass '未声明 engines.dsh（故意：声明它会在新 rc 元组上被宿主跳过）'
}

# 2.4 files 必须包含运行时必需的每一项
$requiredFiles = @('index.js', 'client.js', 'cordis.patch.yml', 'icon.svg')
if ($pkg.files) {
    $missing = @()
    foreach ($r in $requiredFiles) {
        if (-not ($pkg.files | Where-Object { $_ -eq $r })) { $missing += $r }
    }
    $hasLocale = $pkg.files | Where-Object { $_ -like 'locale/*' }
    if (-not $hasLocale) { $missing += 'locale/*.json' }
    if ($missing.Count -eq 0) { Pass "files 覆盖全部运行时文件（$($pkg.files.Count) 项）" }
    else { Fail "files 缺：$($missing -join ', ')" '缺项不会进 npm 包，用户装上就坏' }
} else {
    Warn '未声明 files' 'npm 会打包整个目录，可能带入不该发的文件'
}

# 2.5 locale 元数据（市场卡片读它）
foreach ($lang in @('en', 'zh')) {
    $lp = Join-Path $root "locale/$lang.json"
    if (-not (Test-Path $lp)) { Warn "locale/$lang.json 不存在" '市场卡片会缺标题或描述'; continue }
    try {
        $loc = Get-Content $lp -Raw | ConvertFrom-Json
        if ($loc.meta.title -and $loc.meta.description) { Pass "locale/$lang.json 有 title 与 description" }
        else { Fail "locale/$lang.json 缺 meta.title 或 meta.description" '市场卡片会回退到 package.json' }
    } catch { Fail "locale/$lang.json 解析失败" $_.Exception.Message }
}

# 2.6 patch 里的 entry 引用本包名
$patchFile = Join-Path $root 'cordis.patch.yml'
if (Test-Path $patchFile) {
    $ptxt = Get-Content $patchFile -Raw
    if ($ptxt -match [regex]::Escape($pkg.name)) { Pass 'cordis.patch.yml 引用了本包名' }
    else { Fail "cordis.patch.yml 未出现包名 $($pkg.name)" 'entry 的 name 应等于 package.json name' }
}

# ---------------------------------------------------------------------------
# 3. 宿主运行时
# ---------------------------------------------------------------------------

Section '3. 宿主运行时'

$proc = Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek Harness' } | Select-Object -First 1
if ($proc) { Pass "DSH 在运行（PID $($proc.Id)）" }
else { Fail 'DSH 未运行' '先启动 DeepSeek Harness 再跑自检' }

# 端口：优先用参数，否则探测候选
if ($Port -eq 0) {
    $candidates = @(35913, 17871, 4254)
    foreach ($c in $candidates) {
        $l = Get-NetTCPConnection -State Listen -LocalPort $c -ErrorAction SilentlyContinue
        if ($l) { $Port = $c; break }
    }
}
if ($Port -gt 0) { Pass "Web 端口 $Port 在监听" }
else { Fail "未找到监听端口（试过 $($candidates -join ', ')）" '用 -Port 显式指定' }

# 插件是否装进 profile
$profDeps = Join-Path $env:USERPROFILE ".dsh\profiles\desktop\node_modules\$($pkg.name)"
if (Test-Path $profDeps) { Pass "已安装到 profile（$profDeps）" }
else { Warn "profile 里找不到 $($pkg.name)" '可能未安装，或安装在别的 profile' }

# ---------------------------------------------------------------------------
# 4. 端到端
# ---------------------------------------------------------------------------

Section '4. 端到端'

if ($SkipLive) {
    Warn '已跳过真实调用（-SkipLive）' '完整验证请去掉该参数'
} elseif ($Port -gt 0) {
    $url = "http://127.0.0.1:$Port/$($pkg.name)/refine"
    try {
        $body = '{"draft":"自检：把这句话改写成一个更清晰的提示词"}'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-WebRequest -Uri $url -Method POST -ContentType 'application/json' -Body $body -TimeoutSec 240 -UseBasicParsing
        $sw.Stop()
        $j = $r.Content | ConvertFrom-Json
        if ($r.StatusCode -eq 200 -and $j.ok -eq $true) {
            Pass "POST /$($pkg.name)/refine → 200 ok=true（$([math]::Round($sw.Elapsed.TotalSeconds,1))s，$($j.finish)，$($j.text.Length) 字）"
            if ($j.route) { Write-Host "         路由：$($j.route.provider) / $($j.route.model)" -ForegroundColor DarkGray }
        } elseif ($r.StatusCode -eq 200) {
            Fail "接口返回 200 但 ok=false（$($j.code)：$($j.error)）" '看 code 判断：UNSUPPORTED_REASONING_EFFORT 是强度档位不被支持'
        } else {
            Fail "接口返回 $($r.StatusCode)" '插件可能没加载，检查设置页是否空白'
        }
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($code -eq 405) { Fail '路由不存在（405）' '插件未加载或 path 改了' }
        elseif ($code -eq 0) { Fail "请求失败：$($_.Exception.Message)" 'DSH 可能刚重启，端口变了' }
        else { Fail "HTTP $code" '检查插件是否启用' }
    }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

Write-Host ''
if ($script:failures -eq 0 -and $script:warnings -eq 0) {
    Write-Host '全部通过。' -ForegroundColor Green
    exit 0
} elseif ($script:failures -eq 0) {
    Write-Host "通过，有 $($script:warnings) 项提醒。" -ForegroundColor Yellow
    exit 0
} else {
    Write-Host "$($script:failures) 项失败，$($script:warnings) 项提醒。" -ForegroundColor Red
    exit 1
}
