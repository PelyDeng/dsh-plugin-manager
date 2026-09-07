$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../../../deploy/scripts/start.ps1'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ("dsh-start-wrapper-"+[guid]::NewGuid().ToString('N'))
$scriptRoot=Join-Path $testRoot 'deploy/scripts'
New-Item -ItemType Directory -Path $scriptRoot -Force | Out-Null
try {
  Copy-Item -LiteralPath $source -Destination (Join-Path $scriptRoot 'start.ps1')
  $fixture=@'
const args=process.argv.slice(2);
console.log(JSON.stringify({args,home:process.env.DSH_HOME}));
if(args.includes('fail')) process.exitCode=7;
'@
  [IO.File]::WriteAllText((Join-Path $scriptRoot 'deployment.mjs'),$fixture+"`n",[Text.UTF8Encoding]::new($false))
  $before=$env:DSH_HOME
  $result=& (Join-Path $scriptRoot 'start.ps1') -Plugins one,two -Profile custom -Mode release -HarnessRoot '../official with spaces' -Home 'data/local home' -Config 'deploy/config/example.json' -Resume
  $actual=$result | ConvertFrom-Json
  $expected=@('start','--mode','release','--profile','custom','--plugins','one,two','--harness-root','../official with spaces','--config','deploy/config/example.json','--home','data/local home','--resume')
  if (($actual.args | ConvertTo-Json -Compress) -ne ($expected | ConvertTo-Json -Compress)) {throw 'PowerShell 包装器参数与统一协议不一致'}
  if ($env:DSH_HOME -ne $before) {throw '包装器修改了调用者环境'}
  $failed=$false
  try {& (Join-Path $scriptRoot 'start.ps1') -Mode release -Manifest fail | Out-Null} catch {$failed=$true}
  if (-not $failed) {throw 'Node执行器失败未传播'}
  $previousConfig=$env:DEPLOYMENT_CONFIG
  try {
    $env:DEPLOYMENT_CONFIG=$null
    $without=(& (Join-Path $scriptRoot 'start.ps1')) | ConvertFrom-Json
    if ('development' -notin $without.args) {throw '无配置默认开发模式丢失'}
    New-Item -ItemType Directory -Path (Join-Path $testRoot '.local') | Out-Null
    [IO.File]::WriteAllText((Join-Path $testRoot '.local/env.conf'),"DSH_MODE=release`n")
    $automatic=(& (Join-Path $scriptRoot 'start.ps1')) | ConvertFrom-Json
    if ('--config' -notin $automatic.args -or '--mode' -in $automatic.args) {throw '私有配置自动发现或模式优先级错误'}
    $explicit=(& (Join-Path $scriptRoot 'start.ps1') -Mode development) | ConvertFrom-Json
    if ('development' -notin $explicit.args) {throw '显式模式未覆盖文件模式'}
    $env:DEPLOYMENT_CONFIG='original.json'
    $inherited=(& (Join-Path $scriptRoot 'start.ps1')) | ConvertFrom-Json
    if ('--config' -in $inherited.args -or '--mode' -in $inherited.args) {throw '自动发现覆盖了已有环境配置'}
  } finally {$env:DEPLOYMENT_CONFIG=$previousConfig}
  Write-Output 'PowerShell参数与失败传播检查通过。'
} finally {
  $resolved=[IO.Path]::GetFullPath($testRoot)
  $prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {throw '测试清理路径越界'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
exit 0
