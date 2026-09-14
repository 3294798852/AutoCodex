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
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
# The helper verifies an existing instance before starting another process.
# JSON preserves exact paths and avoids shell quoting for Unicode/space names.
$requestFile = Join-Path $dataDirectory ('.launch-' + [guid]::NewGuid().ToString() + '.json')
$request = @{ args = $directArgs; cwd = $projectDirectory; dataDirectory = $dataDirectory; portExplicit = $PSBoundParameters.ContainsKey('Port'); probeOnly = [bool]$Foreground } | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($requestFile, $request, [System.Text.UTF8Encoding]::new($false))
try {
    $launchOutput = & $nodeExecutable (Join-Path $projectDirectory 'src\launch.mjs') $requestFile
    $launchExitCode = $LASTEXITCODE
    try { $result = ($launchOutput -join [Environment]::NewLine) | ConvertFrom-Json }
    catch { throw "无法读取启动结果。请查看 $dataDirectory\service-error.log。" }
    if ($launchExitCode -ne 0 -or -not $result.ok) {
        if ($result.error) { throw $result.error }
        throw "后台启动失败。请查看 $dataDirectory\service-error.log。"
    }
} finally { Remove-Item -LiteralPath $requestFile -Force }
$configureScript = Join-Path $PSScriptRoot 'Configure-LocalPlugin.ps1'
if (Test-Path -LiteralPath $configureScript) {
    & $configureScript -ConnectionFile (Join-Path $dataDirectory 'connection.json')
}
if ($Foreground -and $result.status -eq 'absent') {
    & $nodeExecutable @directArgs
    exit $LASTEXITCODE
}
if ($result.status -eq 'reused') {
    Write-Output "AutoCodex 已在运行，使用现有服务：$($result.origin)；进程 $($result.pid)"
} else {
    Write-Output "AutoCodex 已启动：$($result.origin)；进程 $($result.pid)"
}
Write-Output "重新打开面板：$($result.launchPath)"
if (-not $NoBrowser) {
    try { Invoke-Item -LiteralPath $result.launchPath }
    catch { Write-Warning "服务正常，但浏览器未能自动打开。请手动打开：$($result.launchPath)" }
}
exit 0
