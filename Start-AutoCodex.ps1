param(
    [switch]$Demo,
    [int]$Port = 3210,
    [switch]$NoBrowser,
    [switch]$Foreground,
    [string]$CodexPath,
    [string]$DataDir,
    [switch]$CheckCodex
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\src\main.mjs')) {
    $projectDirectory = Join-Path $PSScriptRoot 'runtime'
}
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { throw '需要 Node.js 24 或更新版本。请安装并重新打开终端，再启动 AutoCodex。' }
$nodeExecutable = $nodeCommand.Source
$nodeVersion = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw '需要 Node.js 24 或更新版本。' }
$mainScript = Join-Path $projectDirectory 'src\main.mjs'
$modeDirectory = if ($Demo) { 'demo' } else { 'live' }
$dataDirectory = if ($DataDir) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir) }
    elseif ($env:AUTOCODEX_DATA_DIR) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:AUTOCODEX_DATA_DIR) }
    else { Join-Path $projectDirectory ".autocodex\$modeDirectory" }
$directArgs = @($mainScript, '--port', "$Port", '--data-dir', $dataDirectory)
if ($Demo) { $directArgs += '--demo' }
if ($PSBoundParameters.ContainsKey('CodexPath')) {
    $requestedCodex = $CodexPath.Trim().Trim('"')
    if ($requestedCodex -and ($requestedCodex -match '[\\/]' -or $requestedCodex -in @('.', '..') -or (Test-Path -LiteralPath $requestedCodex -PathType Container))) {
        $requestedCodex = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($requestedCodex)
    }
    # The equals form preserves an intentionally empty value in Windows PowerShell 5.1.
    $directArgs += "--codex-command=$requestedCodex"
}
if ($CheckCodex) {
    & $nodeExecutable @directArgs --diagnose-codex
    exit $LASTEXITCODE
}
$launchFile = Join-Path $dataDirectory 'open-panel.html'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$configureScript = Join-Path $PSScriptRoot 'Configure-LocalPlugin.ps1'
if (Test-Path -LiteralPath $configureScript) {
    & $configureScript -ConnectionFile (Join-Path $dataDirectory 'connection.json')
}
if ($Foreground) {
    & $nodeExecutable @directArgs
    exit $LASTEXITCODE
}
# A detached Node child with no inherited terminal handles lets this script
# return even when invoked from another program. JSON preserves the exact argv.
$requestFile = Join-Path $dataDirectory ('.launch-' + [guid]::NewGuid().ToString() + '.json')
$request = @{ args = $directArgs; cwd = $projectDirectory; dataDirectory = $dataDirectory } | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($requestFile, $request, [System.Text.UTF8Encoding]::new($false))
try {
    $launchOutput = & $nodeExecutable (Join-Path $projectDirectory 'src\launch.mjs') $requestFile
    if ($LASTEXITCODE -ne 0) { throw '后台启动失败，请检查 Node.js 安装与数据目录。' }
    $workerProcessId = ($launchOutput | ConvertFrom-Json).pid
} finally { Remove-Item -LiteralPath $requestFile -Force }
$process = Get-Process -Id $workerProcessId -ErrorAction SilentlyContinue
if (-not $process) { throw "服务启动失败。请查看 $dataDirectory\service-error.log。" }
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    if ($process.HasExited) {
        throw "服务启动失败。请查看 $dataDirectory\service-error.log。"
    }
    $connectionFile = Join-Path $dataDirectory 'connection.json'
    if (Test-Path -LiteralPath $connectionFile) {
        try {
            $connection = Get-Content -Raw -Encoding UTF8 -LiteralPath $connectionFile | ConvertFrom-Json
            if ($connection.pid -eq $process.Id -and (Test-Path -LiteralPath $launchFile)) {
                if (-not $NoBrowser) { Invoke-Item -LiteralPath $launchFile }
                Write-Output "AutoCodex 已启动：$($connection.origin)；进程 $($process.Id)"
                Write-Output "重新打开面板：$launchFile"
                exit 0
            }
        } catch { }
    }
}
throw '等待服务启动超时，请查看服务日志。'
