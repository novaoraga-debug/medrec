$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'launcher\MedRecLauncher.cs'
$outputPath = Join-Path $PSScriptRoot 'MedRec.exe'

Add-Type -TypeDefinition (Get-Content -Raw $sourcePath) `
    -OutputAssembly $outputPath `
    -OutputType ConsoleApplication

Write-Host "Created $outputPath"
