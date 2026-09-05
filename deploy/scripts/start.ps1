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
  [switch]$Offline,
  [switch]$Resume,
  [switch]$Recover,
  [switch]$DataCompatible,
  [switch]$Rebuild
)
$ErrorActionPreference='Stop'
$arguments=@((Join-Path $PSScriptRoot 'deployment.mjs'),'start')
if ($PSBoundParameters.ContainsKey('Mode') -or (-not $Config -and -not $env:DEPLOYMENT_CONFIG)) {$arguments+=@('--mode',$Mode)}
if ($PSBoundParameters.ContainsKey('Profile')) {$arguments+=@('--profile',$Profile)}
if ($PSBoundParameters.ContainsKey('Plugins')) {$arguments+=@('--plugins',$(if ($Plugins.Count) {$Plugins -join ','} else {'none'}))}
foreach ($mapping in @(@('HarnessRoot','harness-root'),@('DshCliJs','dsh-cli-js'),@('Config','config'),@('DshHome','home'),@('DataRoot','data-root'),@('Manifest','manifest'),@('BaseUrl','base-url'))) {
  if ($PSBoundParameters.ContainsKey($mapping[0])) {$arguments+=@("--$($mapping[1])",$PSBoundParameters[$mapping[0]])}
}
foreach ($flag in @('Offline','Resume','Recover','Rebuild')) {if ($PSBoundParameters[$flag]) {$arguments+="--$($flag.ToLowerInvariant())"}}
if ($DataCompatible) {$arguments+='--data-compatible'}
& node @arguments
if ($LASTEXITCODE -ne 0) {throw "DSH 启动失败，退出码 $LASTEXITCODE"}
