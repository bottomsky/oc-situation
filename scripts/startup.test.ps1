$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$startup = Join-Path $root 'start.ps1'
if (!(Test-Path -LiteralPath $startup)) { throw 'RED: 根目录缺少 start.ps1。' }
$source = [IO.File]::ReadAllText($startup)
$tokens = $null
$errors = $null
[void][Management.Automation.Language.Parser]::ParseFile($startup, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
if (Test-Path -LiteralPath (Join-Path $root 'node_modules/nuxt/package.json')) {
    $probe = [regex]::Match($source, '"(for \(const name[^"\r\n]+)"').Groups[1].Value
    if (!$probe) { throw '缺少依赖探针。' }
    Push-Location $root
    try { & node --eval $probe; if ($LASTEXITCODE -ne 0) { throw '真实已安装依赖被错误识别为缺失。' } }
    finally { Pop-Location }
}
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('启动脚本验证-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($sandbox)
try {
    foreach ($relative in @('scripts/workspace.ts', 'infra/compose.yaml', 'bun.lock', 'package.json')) {
        $file = Join-Path $sandbox $relative
        [void][IO.Directory]::CreateDirectory((Split-Path $file -Parent))
        [IO.File]::WriteAllText($file, '{}')
    }
    $hook = @'
$testOriginalLocation = (Get-Location).Path
$testOriginalBrowser = $env:PLAYWRIGHT_BROWSERS_PATH
$testOriginalBun = $env:BUN_EXECUTABLE
function Resolve-Application { param($Name) return $Name }
function Resolve-Bun { return 'bun.exe' }
function Invoke-Checked {
    param($Executable, $Arguments, $FailureMessage)
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.txt') -Value (($Executable + ' ' + ($Arguments -join ' ')) + '|cwd=' + (Get-Location).Path)
    $joined = $Arguments -join ' '
    if ($env:STARTUP_TEST_FAILURE -and $joined.Contains($env:STARTUP_TEST_FAILURE)) { throw '模拟外部命令失败' }
    if ($joined -eq '--version') {
        if ($Executable -eq 'node') { return 'v24.1.0' }
        return '1.3.12'
    }
    if ($joined.Contains('require.resolve')) { if ($env:STARTUP_TEST_MISSING_DEPS -eq '1') { throw '依赖缺失' }; return 'ready' }
    if ($joined.Contains('executablePath')) {
        $originalEncoding = [Console]::OutputEncoding
        try {
            [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
            & node @Arguments
            if ($LASTEXITCODE -ne 0) { throw '浏览器探针失败。' }
        } finally { [Console]::OutputEncoding = $originalEncoding }
    }
}
'@
    $injected = $source.Replace('# STARTUP MAIN', ($hook + "`r`n# STARTUP MAIN"))
    $restoreCheck = @'
if ((Get-Location).Path -ne $testOriginalLocation -or $env:PLAYWRIGHT_BROWSERS_PATH -ne $testOriginalBrowser -or $env:BUN_EXECUTABLE -ne $testOriginalBun) { throw '工作目录或环境没有恢复。' }
exit $exitCode
'@
    $injected = $injected.Replace('exit $exitCode', $restoreCheck)
    [IO.File]::WriteAllText((Join-Path $sandbox 'start.ps1'), $injected, (New-Object Text.UTF8Encoding($true)))
    $playwrightStub = Join-Path $sandbox 'node_modules/playwright/index.js'
    [void][IO.Directory]::CreateDirectory((Split-Path $playwrightStub -Parent))
    [IO.File]::WriteAllText($playwrightStub, "module.exports = { chromium: { executablePath: () => require('node:path').resolve('chromium.exe') } };")
    [IO.File]::WriteAllText((Join-Path $sandbox 'package.json'), '{"type":"commonjs"}')
    [IO.File]::WriteAllText((Join-Path $sandbox 'chromium.exe'), '')
    $shell = (Get-Process -Id $PID).Path
    function Run-Case {
        param([string[]]$Parameters, [string]$Failure = '', [switch]$MissingDependencies)
        $env:STARTUP_TEST_FAILURE = $Failure
        $env:STARTUP_TEST_MISSING_DEPS = [string][int]$MissingDependencies.IsPresent
        $log = Join-Path $sandbox 'calls.txt'
        if (Test-Path $log) { Remove-Item -LiteralPath $log }
        Push-Location $env:TEMP
        try {
            & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sandbox 'start.ps1') @Parameters *> (Join-Path $sandbox 'output.txt')
            $code = $LASTEXITCODE
        } finally { Pop-Location }
        $calls = [IO.File]::ReadAllText($log)
        if ($calls.Contains('cwd=' + $env:TEMP + "`r`n")) { throw '错误：使用了调用方工作目录。' }
        return @{ Code = $code; Calls = $calls }
    }
    $check = Run-Case -Parameters @('-CheckOnly', '-InstallDependencies')
    if ($check.Code -ne 0 -or $check.Calls -match ' up |install|workspace.ts') { throw 'CheckOnly 发生副作用或失败。' }
    $normal = Run-Case -Parameters @('-BackendOnly')
    if ($normal.Code -ne 0 -or $normal.Calls -notmatch 'demo --backend-only' -or $normal.Calls -match 'install') { throw '已安装依赖的后台启动流程错误。' }
    $install = Run-Case -Parameters @() -MissingDependencies
    if ($install.Code -ne 0 -or $install.Calls -notmatch 'bun.exe --no-env-file install --frozen-lockfile') { throw '依赖安装流程错误。' }
    if ($install.Calls.IndexOf('install --frozen-lockfile') -gt $install.Calls.IndexOf(' up -d ')) { throw '安装/基础设施顺序错误。' }
    Remove-Item -LiteralPath (Join-Path $sandbox 'chromium.exe')
    $browser = Run-Case -Parameters @()
    if ($browser.Code -ne 0 -or $browser.Calls -notmatch 'cli.js install chromium') { throw '浏览器缺失安装流程错误。' }
    foreach ($failure in @('info', 'compose version', ' up -d ', 'install chromium', 'workspace.ts demo')) {
        $failed = Run-Case -Parameters @() -Failure $failure
        if ($failed.Code -eq 0) { throw ('未传播失败：' + $failure) }
        if ($failure -ne 'workspace.ts demo' -and $failed.Calls -match 'workspace.ts demo') { throw '失败后仍启动了应用。' }
    }
    $failedInstall = Run-Case -Parameters @('-InstallDependencies') -Failure 'install --frozen-lockfile'
    if ($failedInstall.Code -eq 0 -or $failedInstall.Calls -match ' up -d ') { throw '安装失败后仍启动基础设施。' }
    Write-Host 'PASS: 语法、CheckOnly、中文目录、任意工作目录、后台参数、依赖/浏览器安装与错误传播。'
} finally {
    Remove-Item Env:STARTUP_TEST_FAILURE -ErrorAction SilentlyContinue
    Remove-Item Env:STARTUP_TEST_MISSING_DEPS -ErrorAction SilentlyContinue
    $resolved = [IO.Path]::GetFullPath($sandbox)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
