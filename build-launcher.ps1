$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'launcher\MedRecLauncher.cs'
$downloadPath = Join-Path $PSScriptRoot 'download'
$outputPath = Join-Path $downloadPath 'MedRec.exe'

New-Item -ItemType Directory -Force -Path $downloadPath | Out-Null

if (Test-Path $outputPath) {
    Remove-Item -LiteralPath $outputPath
}

Add-Type -TypeDefinition (Get-Content -Raw $sourcePath) `
    -OutputAssembly $outputPath `
    -OutputType ConsoleApplication

Write-Host "Created $outputPath"
