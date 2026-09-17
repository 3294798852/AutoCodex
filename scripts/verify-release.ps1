param([switch]$Startup, [switch]$WithCodex)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectDirectory 'package.json') | ConvertFrom-Json).version
$archivePath = Join-Path $projectDirectory "dist\autocodex-guard-$version.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $prefix = 'autocodex-guard/'
    $inventoryEntry = $archive.GetEntry($prefix + 'SHA256SUMS.json')
    if (-not $inventoryEntry) { throw 'Missing hash inventory' }
    $reader = [System.IO.StreamReader]::new($inventoryEntry.Open())
    try { $inventory = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    foreach ($required in @('.codex-plugin/plugin.json', '.mcp.json', 'scripts/bridge.mjs', 'runtime/src/main.mjs', 'runtime/src/adapters/codex-discovery.mjs', 'runtime/src/server/codex-settings.mjs', 'runtime/src/core/dnd-policy.mjs', 'runtime/src/core/recycle.mjs', 'runtime/src/native/recycle.ps1', 'runtime/native/AutoCodexRelay.exe', 'runtime/src/desktop/main.mjs', 'runtime/src/desktop/recycle-server.mjs', 'Start-AutoCodex.ps1', 'Start-AutoCodexDesktop.ps1', 'Start-AutoCodexDesktop.cmd', 'Stop-AutoCodex.ps1', 'Configure-LocalPlugin.ps1', 'docs/09-user-guide.md', 'docs/10-installation-design.md', 'docs/12-dnd-requirements.md', 'docs/13-dnd-implementation.md', 'docs/17-desktop-relay.md', 'docs/18-monitor-usability.md', 'Start-AutoCodex.cmd', 'Start-AutoCodexBrowser.cmd', 'Open-AutoCodexWindow.ps1', 'runtime/native/AutoCodexWindow.exe', 'runtime/native/Microsoft.Web.WebView2.Core.dll', 'runtime/native/Microsoft.Web.WebView2.WinForms.dll', 'runtime/native/WebView2Loader.dll')) {
        if (-not $archive.GetEntry($prefix + $required)) { throw "Missing archive member: $required" }
    }
    $reader = [System.IO.StreamReader]::new($archive.GetEntry($prefix + '.mcp.json').Open())
    try { $template = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if (@($template.mcpServers.PSObject.Properties).Count -ne 0) { throw 'MCP template must not contain build-machine paths' }
    $verified = 0
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -match '(^|/)(\.autocodex|\.work|\.git)/|(^|/)(connection\.json|open-panel\.html|guard\.sqlite[^/]*)$') { throw 'Runtime data found in package' }
        if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('/SHA256SUMS.json')) { continue }
        if (-not $entry.FullName.StartsWith($prefix) -or $entry.FullName.Contains('../')) { throw 'Unsafe archive member' }
        $relative = $entry.FullName.Substring($prefix.Length)
        $expected = $inventory.PSObject.Properties[$relative].Value
        if (-not $expected) { throw "Unlisted member: $relative" }
        $stream = $entry.Open(); $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $actual = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($actual -ne $expected) { throw "Hash mismatch: $relative" }
        $verified++
    }
    if ($verified -ne @($inventory.PSObject.Properties).Count) { throw 'Inventory count mismatch' }
} finally { $archive.Dispose() }
$report = @{ testedAt = [DateTime]::UtcNow.ToString('o'); version = $version; filesVerified = $verified; credentialsIncluded = $false; machinePathsInMcpTemplate = $false; archiveBytes = (Get-Item -LiteralPath $archivePath).Length }

function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Invoke-Launcher([string]$Script, [string[]]$LaunchArgs) {
    $parameters = @{}
    for ($index = 0; $index -lt $LaunchArgs.Count; $index++) {
        $name = $LaunchArgs[$index].TrimStart('-')
        if ($name -in @('Demo', 'NoBrowser', 'Foreground', 'CheckCodex', 'CheckOnly')) { $parameters[$name] = $true }
        else { $index++; $parameters[$name] = $LaunchArgs[$index] }
    }
    & (Join-Path $script:packageDirectory $Script) @parameters
    if ($LASTEXITCODE -ne 0) { throw "Launcher failed: $Script" }
}
function Read-Connection([string]$Directory) {
    return Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Directory 'connection.json') | ConvertFrom-Json
}
function Call-Api($Connection, [string]$Path, $Body = $null) {
    $parameters = @{ Uri = $Connection.origin + '/api/v1' + $Path; Headers = @{ Authorization = 'Bearer ' + $Connection.token }; TimeoutSec = 20 }
    if ($null -ne $Body) { $parameters.Method = 'Post'; $parameters.ContentType = 'application/json'; $parameters.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress)) }
    return Invoke-RestMethod @parameters
}
function Stop-ServiceUnderTest([string]$Directory, $Connection) {
    Invoke-Launcher 'Stop-AutoCodex.ps1' @('-DataDir', $Directory) | Out-Null
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if (-not (Get-Process -Id $Connection.pid -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'Packaged service did not stop'
}

if ($Startup -or $WithCodex) {
    Write-Output 'Verifying relocated package startup...'
    $extractDirectory = Join-Path $projectDirectory ('.work\release 中文 空格-' + [guid]::NewGuid().ToString())
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractDirectory)
    $script:packageDirectory = Join-Path $extractDirectory 'autocodex-guard'
    $demoData = Join-Path $extractDirectory '演练 数据'
    Invoke-Launcher 'Start-AutoCodex.ps1' @('-Demo', '-Port', (Get-FreePort), '-NoBrowser', '-DataDir', $demoData) | Out-Null
    $connection = Read-Connection $demoData
    Write-Output 'Checking relocated dashboard and plugin paths...'
    try {
        $state = Call-Api $connection '/state'
        if ($state.mode -ne 'demo' -or $state.version -ne $version -or $state.defaultPolicy.errorWindowMs -ne 300000 -or $state.defaultPolicy.noOutputTimeoutMs -ne 600000) { throw 'Packaged runtime defaults/version are incorrect' }
        if ($state.dnd.enabledCount -ne 0 -or -not $state.dnd.recycleSupported) { throw 'Packaged DND defaults/support are incorrect' }
        $updatedDnd = Call-Api $connection '/dnd' @{ revision = 0; commonCommands = $true }
        if ($updatedDnd.enabledCount -ne 1 -or $updatedDnd.settings.revision -ne 1) { throw 'Packaged DND settings did not save' }
        $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $packageDirectory '.mcp.json') | ConvertFrom-Json
        if ($manifest.mcpServers.'autocodex-guard'.args[0] -ne (Join-Path $packageDirectory 'scripts\bridge.mjs')) { throw 'Plugin relocation configuration did not update' }
        if ($manifest.mcpServers.'autocodex-guard'.env.AUTOCODEX_CONNECTION_FILE -ne (Join-Path $demoData 'connection.json')) { throw 'Custom connection path was not configured' }
        $windowCheck = Start-Process -FilePath (Join-Path $packageDirectory 'runtime\native\AutoCodexWindow.exe') -ArgumentList ('"' + (Join-Path $demoData 'connection.json') + '" --check') -PassThru -Wait -WindowStyle Hidden
        if ($windowCheck.ExitCode -ne 0) { throw 'Relocated WebView2 runtime check failed' }
        $report.nativeWindowRuntime = 'passed'
        $report.demoStartup = 'passed'; $report.unicodeRelocation = 'passed'; $report.customDataDirectory = 'passed'; $report.pluginReconfiguration = 'passed'
    } finally { Stop-ServiceUnderTest $demoData $connection }
    Invoke-Launcher 'Start-AutoCodex.ps1' @('-Demo', '-Port', (Get-FreePort), '-NoBrowser', '-DataDir', $demoData) | Out-Null
    $connection = Read-Connection $demoData
    try {
        $dnd = Call-Api $connection '/dnd'
        if (-not $dnd.settings.commonCommands -or $dnd.settings.revision -ne 1 -or $dnd.enabledCount -ne 1) { throw 'Packaged DND settings lost on restart' }
        $report.dndDefaults = 'passed'; $report.dndPersistence = 'passed'; $report.recycleEntryPackaged = 'passed'
    } finally { Stop-ServiceUnderTest $demoData $connection }
    $report.shutdown = 'passed'
}

if ($WithCodex) {
    Write-Output 'Checking automatic and Unicode CLI paths...'
    $nodeExecutable = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $liveData = Join-Path $extractDirectory '真实 数据'
    $automaticText = Invoke-Launcher 'Start-AutoCodex.ps1' @('-CheckCodex', '-DataDir', $liveData)
    $automatic = ($automaticText -join "`n") | ConvertFrom-Json
    if (-not $automatic.ok) { throw 'Real Codex required for -WithCodex' }
    $runtime = @{ command = $automatic.path; args = @() }
    if ($automatic.kind -eq 'npm-launcher') { $runtime.command = $nodeExecutable; $runtime.args = @($automatic.path) }
    Invoke-Launcher 'Start-AutoCodexDesktop.ps1' @('-CheckOnly', '-DataDir', $liveData) | Out-Null
    $relayConfig = Join-Path $extractDirectory '转接配置.json'
    [IO.File]::WriteAllText($relayConfig, (@{ codex = $runtime.command; codexArgs = $runtime.args } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $relayVariables = @('AUTOCODEX_RELAY_CONFIG', 'AUTOCODEX_RELAY_NODE', 'AUTOCODEX_RELAY_SCRIPT')
    $previousRelayEnvironment = @{}
    foreach ($name in $relayVariables) { $previousRelayEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $env:AUTOCODEX_RELAY_CONFIG = $relayConfig
        $env:AUTOCODEX_RELAY_NODE = $nodeExecutable
        $env:AUTOCODEX_RELAY_SCRIPT = Join-Path $packageDirectory 'runtime\src\desktop\main.mjs'
        $relayVersion = & (Join-Path $packageDirectory 'runtime\native\AutoCodexRelay.exe') --version
        if ($LASTEXITCODE -ne 0 -or $relayVersion -notmatch 'codex') { throw 'Relocated native relay did not forward --version' }
    } finally { foreach ($name in $relayVariables) { [Environment]::SetEnvironmentVariable($name, $previousRelayEnvironment[$name], 'Process') } }
    $report.desktopDiscovery = 'passed'; $report.nativeRelayUnicodeRelocation = 'passed'; $report.desktopLauncherPackaged = 'passed'
    $runtimeJson = $runtime | ConvertTo-Json -Compress
    # A JS entry point in a Unicode/space directory delegates to the installed
    # real CLI. Only command/argv are embedded; never copy credentials or env.
    $manualDirectory = Join-Path $extractDirectory '自选 Codex CLI'
    New-Item -ItemType Directory -Path $manualDirectory | Out-Null
    $manualPath = Join-Path $manualDirectory 'codex.js'
    $wrapper = @'
import { spawn } from 'node:child_process';
const target = __TARGET__;
const proc = spawn(target.command, [...target.args, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, shell: false });
proc.on('error', () => { process.exitCode = 1; });
proc.on('exit', code => { process.exitCode = code ?? 1; });
'@
    [IO.File]::WriteAllText($manualPath, $wrapper.Replace('__TARGET__', $runtimeJson), [Text.UTF8Encoding]::new($false))
    $diagnosticText = Invoke-Launcher 'Start-AutoCodex.ps1' @('-CheckCodex', '-CodexPath', $manualPath, '-DataDir', $liveData)
    $diagnostic = ($diagnosticText -join "`n") | ConvertFrom-Json
    if (-not $diagnostic.ok -or -not $diagnostic.connected -or $diagnostic.modelGenerationRequested -or $diagnostic.path -ne $manualPath) { throw 'Custom Codex diagnostic failed' }
    $report.manualUnicodePath = 'passed'; $report.codexVersion = $diagnostic.version
    Write-Output 'Checking manual override and saved settings across restarts...'
    Invoke-Launcher 'Start-AutoCodex.ps1' @('-CodexPath', $manualPath, '-DataDir', $liveData, '-Port', (Get-FreePort), '-NoBrowser') | Out-Null
    $connection = Read-Connection $liveData
    try {
        $settings = Call-Api $connection '/codex'
        if (-not $settings.locked -or $settings.installation.path -ne $manualPath) { throw 'Manual CLI override did not reach the service' }
        $connected = Call-Api $connection '/connect' @{}
        if (-not $connected.connected) { throw 'Manual CLI handshake failed' }
        if (@((Call-Api $connection '/state').tasks).Count -ne 0) { throw 'Connection check created model work' }
    } finally { Stop-ServiceUnderTest $liveData $connection }
    Invoke-Launcher 'Start-AutoCodex.ps1' @('-DataDir', $liveData, '-Port', (Get-FreePort), '-NoBrowser') | Out-Null
    $connection = Read-Connection $liveData
    try {
        $settings = Call-Api $connection '/codex'
        if ($settings.locked -or -not $settings.installation.found) { throw 'Automatic discovery failed' }
        $saved = Call-Api $connection '/codex' @{ command = $manualDirectory }
        if (-not $saved.restartRequired -or $saved.activeCommand) { throw 'Saving changed the active selection instead of next startup' }
    } finally { Stop-ServiceUnderTest $liveData $connection }
    Invoke-Launcher 'Start-AutoCodex.ps1' @('-DataDir', $liveData, '-Port', (Get-FreePort), '-NoBrowser') | Out-Null
    $connection = Read-Connection $liveData
    try {
        $settings = Call-Api $connection '/codex'
        if ($settings.source -ne '面板保存' -or $settings.restartRequired -or $settings.installation.path -ne $manualPath) { throw 'Saved installation was not restored after restart' }
        if (-not (Call-Api $connection '/connect' @{}).connected) { throw 'Saved CLI handshake failed' }
    } finally { Stop-ServiceUnderTest $liveData $connection }
    $report.automaticDiscovery = 'passed'; $report.manualOverride = 'passed'; $report.savedPathRestart = 'passed'; $report.modelGenerationRequested = $false
}
$reportPath = Join-Path $projectDirectory '.work\package-report.json'
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json
