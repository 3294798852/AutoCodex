param([string]$DesktopPath, [string]$CodexPath, [string]$DataDir, [int]$Port = 3210, [switch]$CheckOnly, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$runtimeDirectory = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\src\main.mjs')) { Join-Path $PSScriptRoot 'runtime' } else { $PSScriptRoot }
$nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not $DataDir) { $DataDir = if ($env:AUTOCODEX_DATA_DIR) { $env:AUTOCODEX_DATA_DIR } else { Join-Path $runtimeDirectory '.autocodex\live' } }
$DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
$parameters = @{ DataDir = $DataDir; NoBrowser = [bool]$NoBrowser }
if ($PSBoundParameters.ContainsKey('Port')) { $parameters.Port = $Port }
if ($PSBoundParameters.ContainsKey('CodexPath')) { $parameters.CodexPath = $CodexPath }
if (-not $CheckOnly) {
    & (Join-Path $PSScriptRoot 'Start-AutoCodex.ps1') @parameters
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$relayExecutable = Join-Path $runtimeDirectory 'native\AutoCodexRelay.exe'
if (-not (Test-Path -LiteralPath $relayExecutable)) {
    $relayExecutable = Join-Path $PSScriptRoot '.work\desktop-runtime\AutoCodexRelay.exe'
    if (-not (Test-Path -LiteralPath $relayExecutable)) { & (Join-Path $PSScriptRoot 'scripts\build-desktop.ps1') | Out-Null }
}
$request = @{ desktopPath=$DesktopPath; codexPath=$CodexPath; codexPathExplicit=$PSBoundParameters.ContainsKey('CodexPath'); dataDirectory=$DataDir; root=$PSScriptRoot; checkOnly=[bool]$CheckOnly } | ConvertTo-Json -Compress
$requestFile = Join-Path ([IO.Path]::GetTempPath()) ('autocodex-desktop-' + [guid]::NewGuid().ToString() + '.json')
[IO.File]::WriteAllText($requestFile, $request, [Text.UTF8Encoding]::new($false))
try {
    $result = & $nodeExecutable (Join-Path $runtimeDirectory 'src\desktop\launch.mjs') $requestFile
    $code = $LASTEXITCODE
    $report = ($result -join [Environment]::NewLine) | ConvertFrom-Json
    if ($report.message) { Write-Output $report.message }
    if ($report.error) { throw $report.error }
    if ($CheckOnly) { $report | Format-List }
} finally { Remove-Item -LiteralPath $requestFile -Force }
exit $code
