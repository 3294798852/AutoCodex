param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectDirectory '.work\desktop-runtime' }
$sdkDirectory = Join-Path $projectDirectory '.work\webview2-sdk'
$packagePath = Join-Path $sdkDirectory 'sdk.nupkg'
$unpacked = Join-Path $sdkDirectory 'package'
$expectedHash = 'EF128016DD1E51C59178C827ED5B8AA3322C57AFA8675D930F8109505542AD74'
New-Item -ItemType Directory -Force $sdkDirectory, $OutputDirectory | Out-Null
if (-not (Test-Path -LiteralPath $packagePath)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg' -OutFile $packagePath -TimeoutSec 60
}
$hashStream = [IO.File]::OpenRead($packagePath)
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $actualHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream))).Replace('-', '') }
finally { $hashStream.Dispose(); $hashAlgorithm.Dispose() }
if ($actualHash -ne $expectedHash) { throw 'WebView2 SDK integrity check failed.' }
if (-not (Test-Path -LiteralPath $unpacked)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $unpacked)
}
$core = Join-Path $unpacked 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $unpacked 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$destination = Join-Path $OutputDirectory 'AutoCodexWindow.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$destination" ('/win32manifest:' + (Join-Path $projectDirectory 'src\native\MonitorWindow.manifest')) /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/r:$core" "/r:$forms" (Join-Path $projectDirectory 'src\native\MonitorWindow.cs')
if ($LASTEXITCODE -ne 0) { throw 'AutoCodex window build failed.' }
Copy-Item -LiteralPath (Join-Path $projectDirectory 'src\native\MonitorWindow.config') -Destination ($destination + '.config') -Force
Copy-Item -LiteralPath $core, $forms, (Join-Path $unpacked 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $unpacked 'LICENSE.txt') -Destination (Join-Path $OutputDirectory 'WebView2-LICENSE.txt') -Force
Write-Output $destination
