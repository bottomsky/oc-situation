<#
.SYNOPSIS
启动本地演示；需要 Node.js 24、Bun >= 1.3.12 和已运行的 Docker。
.EXAMPLE
.\start.ps1
.EXAMPLE
.\start.ps1 -CheckOnly
.EXAMPLE
.\start.ps1 -BackendOnly -InstallDependencies
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$BackendOnly,
    [switch]$InstallDependencies
)

$ErrorActionPreference = 'Stop'
# PowerShell 7 的原生命令错误由退出码统一处理，兼容 Windows PowerShell 5.1。
$PSNativeCommandUseErrorActionPreference = $false

function Resolve-Application {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$command) { throw "未找到 $Name，请安装并加入 PATH 后重新打开终端。" }
    return $command.Source
}

function Resolve-Bun {
    if ($env:BUN_EXECUTABLE) {
        if (!(Test-Path -LiteralPath $env:BUN_EXECUTABLE -PathType Leaf) -or [IO.Path]::GetExtension($env:BUN_EXECUTABLE) -ne '.exe') {
            throw 'BUN_EXECUTABLE 必须指向存在的 bun.exe。'
        }
        return [IO.Path]::GetFullPath($env:BUN_EXECUTABLE)
    }
    # npm 全局安装可能仅暴露 bun.ps1/bun.cmd；后台 shell:false 需要实际二进制。
    foreach ($directory in ($env:PATH -split ';' | Where-Object { $_ })) {
        $directory = $directory.Trim('"')
        foreach ($relative in @('bun.exe', 'node_modules/bun/bin/bun.exe')) {
            $candidate = Join-Path $directory $relative
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
        }
    }
    throw '未找到 Bun 实际可执行文件。请安装 Bun，或将 BUN_EXECUTABLE 设为 bun.exe 的完整路径。'
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments, [string]$FailureMessage)
    $global:LASTEXITCODE = 0
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage（退出码：$LASTEXITCODE）。" }
}

# STARTUP MAIN
$exitCode = 0
$locationPushed = $false
$oldBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
$oldBunExecutable = $env:BUN_EXECUTABLE
$oldConsoleInputEncoding = [Console]::InputEncoding
$oldConsoleOutputEncoding = [Console]::OutputEncoding
$oldPipelineEncoding = $OutputEncoding
try {
    # Node emits UTF-8; PowerShell 5.1 otherwise decodes piped native output using the legacy code page.
    $startupUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $startupUtf8
    [Console]::OutputEncoding = $startupUtf8
    $OutputEncoding = $startupUtf8
    Push-Location -LiteralPath $PSScriptRoot
    $locationPushed = $true
    foreach ($relative in @('package.json', 'bun.lock', 'infra/compose.yaml', 'scripts/workspace.ts')) {
        if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $relative) -PathType Leaf)) { throw "项目文件缺失：$relative。" }
    }

    $node = Resolve-Application 'node'
    $bun = Resolve-Bun
    $docker = Resolve-Application 'docker'
    $nodeVersion = (Invoke-Checked $node @('--version') '读取 Node.js 版本失败' | Out-String).Trim()
    if ($nodeVersion -notmatch '^v24\.') { throw "需要 Node.js 24，当前版本：$nodeVersion。" }
    $bunVersion = (Invoke-Checked $bun @('--version') '读取 Bun 版本失败' | Out-String).Trim()
    if ($bunVersion -notmatch '^(\d+\.\d+\.\d+)' -or [version]$Matches[1] -lt [version]'1.3.12') {
        throw "需要 Bun 1.3.12 或更高版本，当前版本：$bunVersion。"
    }
    Invoke-Checked $docker @('compose', 'version') 'Docker Compose 不可用，请检查 Docker 安装' | Out-Host
    Invoke-Checked $docker @('info', '--format', '{{.ServerVersion}}') 'Docker daemon 未就绪，请先启动 Docker 并确认当前用户有访问权限' | Out-Host
    Write-Host '前置环境检查通过。'

    if (!$CheckOnly) {
        $env:BUN_EXECUTABLE = $bun
        $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PSScriptRoot '.data/playwright'
        $dependenciesReady = $false
        if (!$InstallDependencies) {
            try {
                Invoke-Checked $node @('--eval', "for (const name of ['tsx', 'playwright', 'nuxt/package.json']) require.resolve(name)") '工作区依赖缺失' | Out-Null
                $dependenciesReady = $true
            } catch {
                Write-Host '工作区依赖缺失或不完整，将安装锁定版本。'
            }
        }
        if (!$dependenciesReady) {
            Write-Host '正在安装工作区依赖……'
            Invoke-Checked $bun @('--no-env-file', 'install', '--frozen-lockfile') '依赖安装失败' | Out-Host
        }

        Write-Host '正在启动 PostgreSQL、ClickHouse、NATS 和 S3……'
        Invoke-Checked $docker @('compose', '-f', 'infra/compose.yaml', 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'clickhouse', 'nats', 's3') '基础设施启动失败' | Out-Host

        # Node 内检查实际路径，仅返回 ASCII，兼容 PowerShell 5.1 的中文控制台编码。
        $browserStatus = (Invoke-Checked $node @('--eval', "process.stdout.write(require('node:fs').existsSync(require('playwright').chromium.executablePath()) ? 'present' : 'missing')") '检查 Chromium 实际可执行文件失败' | Out-String).Trim()
        if ($browserStatus -cne 'present' -and $browserStatus -cne 'missing') { throw 'Playwright 浏览器检查返回了无效状态。' }
        if ($browserStatus -ceq 'missing') {
            Write-Host '本地 Playwright Chromium 缺失，正在安装……'
            Invoke-Checked $node @('node_modules/playwright/cli.js', 'install', 'chromium') 'Chromium 安装失败' | Out-Host
        }

        $demoArguments = @('--env-file-if-exists=.env.local', '--import', 'tsx', 'scripts/workspace.ts', 'demo')
        if ($BackendOnly) { $demoArguments += '--backend-only' }
        if ($BackendOnly) {
            Write-Host '正在前台启动后台演示。Web 单独启动后访问 http://127.0.0.1:13001。'
        } else {
            Write-Host '正在前台启动演示，就绪后访问 http://127.0.0.1:13001。'
        }
        Write-Host '登录账号文件：.data/demo-admin.json（由演示入口生成，请在本机查看）。'
        Write-Host '演示会先等待消费者恢复历史积压（最多 120 秒），再注入新样例；超时保留队列和数据。'
        Write-Host '按 Ctrl+C 停止本次演示；数据库等基础设施容器保留运行。'
        Invoke-Checked $node $demoArguments '演示运行失败' | Out-Host
    }
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
} finally {
    [Console]::InputEncoding = $oldConsoleInputEncoding
    [Console]::OutputEncoding = $oldConsoleOutputEncoding
    $OutputEncoding = $oldPipelineEncoding
    $env:PLAYWRIGHT_BROWSERS_PATH = $oldBrowserPath
    $env:BUN_EXECUTABLE = $oldBunExecutable
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
