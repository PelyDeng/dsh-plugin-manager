$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'deploy/build.ps1') @args
exit $LASTEXITCODE
