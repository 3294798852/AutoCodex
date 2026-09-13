param([string]$ConnectionFile)
$ErrorActionPreference = 'Stop'
$pluginDirectory = $PSScriptRoot
$runtimeDirectory = Join-Path $PSScriptRoot 'runtime'
if (-not (Test-Path -LiteralPath (Join-Path $pluginDirectory '.codex-plugin\plugin.json'))) {
    $pluginDirectory = Join-Path $PSScriptRoot 'plugins\autocodex-guard'
    $runtimeDirectory = $PSScriptRoot
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginDirectory '.codex-plugin\plugin.json'))) { throw '未找到 AutoCodex 插件目录。' }
if (-not $ConnectionFile) { $ConnectionFile = Join-Path $runtimeDirectory '.autocodex\live\connection.json' }
$nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$server = @{
    command = $nodeExecutable
    args = @((Join-Path $pluginDirectory 'scripts\bridge.mjs'))
    env = @{ AUTOCODEX_CONNECTION_FILE = [System.IO.Path]::GetFullPath($ConnectionFile) }
}
$payload = @{ mcpServers = @{ 'autocodex-guard' = $server } } | ConvertTo-Json -Depth 8
$manifestPath = Join-Path $pluginDirectory '.mcp.json'
[System.IO.File]::WriteAllText($manifestPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "本机插件连接配置已生成：$manifestPath"
