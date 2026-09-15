[CmdletBinding()]
param(
  [Alias('Plugin')][string[]]$Plugins,
  [ValidateSet('development','release')][string]$Mode='development',
  [string]$HarnessRoot,
  [string]$DshCliJs,
  [string]$Profile='web',
  [string]$Config,
  [Alias('Home')][string]$DshHome,
  [string]$DataRoot,
  [string]$Manifest,
  [string]$BaseUrl,
  [switch]$Offline
)
$ErrorActionPreference='Stop'
$arguments=@((Join-Path $PSScriptRoot 'deployment.mjs'),'start')
$frameworkConfig=Join-Path $PSScriptRoot '../../.local/env.conf'
$useFrameworkConfig=-not $Config -and -not $env:DEPLOYMENT_CONFIG -and (Test-Path -LiteralPath $frameworkConfig -PathType Leaf)
if ($PSBoundParameters.ContainsKey('Mode') -or (-not $Config -and -not $env:DEPLOYMENT_CONFIG -and -not $useFrameworkConfig)) {$arguments+=@('--mode',$Mode)}
if ($useFrameworkConfig) {$arguments+=@('--config',$frameworkConfig)}
if ($PSBoundParameters.ContainsKey('Profile')) {$arguments+=@('--profile',$Profile)}
if ($PSBoundParameters.ContainsKey('Plugins')) {$arguments+=@('--plugins',$(if ($Plugins.Count) {$Plugins -join ','} else {'none'}))}
foreach ($mapping in @(@('HarnessRoot','harness-root'),@('DshCliJs','dsh-cli-js'),@('Config','config'),@('DshHome','home'),@('DataRoot','data-root'),@('Manifest','manifest'),@('BaseUrl','base-url'))) {
  if ($PSBoundParameters.ContainsKey($mapping[0])) {$arguments+=@("--$($mapping[1])",$PSBoundParameters[$mapping[0]])}
}
# 旧的恢复与重建开关已随对应分支删除，这里不再声明也不再转发；修正输入后直接重新运行普通 build。
if ($Offline) {$arguments+='--offline'}
& node @arguments
if ($LASTEXITCODE -ne 0) {throw "DSH 启动失败，退出码 $LASTEXITCODE"}
