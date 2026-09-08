# Use deploy/build.ps1 when only the current checkout should be built without Git sync.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Missing prerequisite: Node.js. See PRIVATE.md.'
}
& node (Join-Path $PSScriptRoot 'private-deploy/release.mjs') @args
exit $LASTEXITCODE
