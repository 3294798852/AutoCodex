param([string]$DataDir, [switch]$Browser)
$ErrorActionPreference = 'Stop'
$runtimeDirectory = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\src\main.mjs')) { Join-Path $PSScriptRoot 'runtime' } else { $PSScriptRoot }
if (-not $DataDir) { $DataDir = if ($env:AUTOCODEX_DATA_DIR) { $env:AUTOCODEX_DATA_DIR } else { Join-Path $runtimeDirectory '.autocodex\live' } }
$DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
if ($Browser) { Invoke-Item -LiteralPath (Join-Path $DataDir 'open-panel.html'); exit 0 }
$windowExecutable = Join-Path $runtimeDirectory 'native\AutoCodexWindow.exe'
if (-not (Test-Path -LiteralPath $windowExecutable)) {
    $windowExecutable = Join-Path $PSScriptRoot '.work\desktop-runtime\AutoCodexWindow.exe'
    $buildInputs = @('src\native\MonitorWindow.cs', 'src\native\MonitorWindow.manifest', 'src\native\MonitorWindow.config', 'scripts\build-window.ps1') | ForEach-Object { Get-Item -LiteralPath (Join-Path $PSScriptRoot $_) }
    $needsBuild = -not (Test-Path -LiteralPath $windowExecutable) -or -not (Test-Path -LiteralPath ($windowExecutable + '.config'))
    if (-not $needsBuild) { $needsBuild = @($buildInputs | Where-Object { $_.LastWriteTimeUtc -gt (Get-Item -LiteralPath $windowExecutable).LastWriteTimeUtc }).Count -gt 0 }
    if ($needsBuild) { & (Join-Path $PSScriptRoot 'scripts\build-window.ps1') | Out-Null }
}
$connectionPath = Join-Path $DataDir 'connection.json'
if (-not (Test-Path -LiteralPath $connectionPath)) { throw '请先运行 Start-AutoCodex.cmd。' }
Start-Process -FilePath $windowExecutable -ArgumentList ('"' + $connectionPath + '"') -WindowStyle Normal | Out-Null
