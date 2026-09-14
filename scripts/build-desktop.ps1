param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectDirectory '.work\desktop-runtime' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler was not found.' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$destination = Join-Path $OutputDirectory 'AutoCodexRelay.exe'
& $compiler /nologo /target:exe /optimize+ "/out:$destination" (Join-Path $projectDirectory 'src\native\DesktopRelay.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop relay build failed.' }
Write-Output $destination
