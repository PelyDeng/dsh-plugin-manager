$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Missing prerequisite: Node.js. See deploy/README.md.'
}
& node (Join-Path $PSScriptRoot 'scripts/release.mjs') @args
exit $LASTEXITCODE
