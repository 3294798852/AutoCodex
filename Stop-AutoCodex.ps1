param([switch]$Demo, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\src\main.mjs')) { $projectDirectory = Join-Path $PSScriptRoot 'runtime' }
$modeDirectory = if ($Demo) { 'demo' } else { 'live' }
$dataDirectory = if ($DataDir) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir) }
    elseif ($env:AUTOCODEX_DATA_DIR) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:AUTOCODEX_DATA_DIR) }
    else { Join-Path $projectDirectory ".autocodex\$modeDirectory" }
$connectionFile = Join-Path $dataDirectory 'connection.json'
if (-not (Test-Path -LiteralPath $connectionFile)) { throw '未找到此模式的连接文件。' }
$connection = Get-Content -Raw -Encoding UTF8 -LiteralPath $connectionFile | ConvertFrom-Json
$origin = [Uri]$connection.origin
if ($origin.Scheme -ne 'http' -or $origin.Host -ne '127.0.0.1') { throw '只允许关闭此项目的本机守护服务。' }
$headers = @{ Authorization = "Bearer $($connection.token)" }
Invoke-RestMethod -Uri "$($origin.AbsoluteUri.TrimEnd('/'))/api/v1/shutdown" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
Write-Output '已请求守护服务保存状态并关闭。'
