$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../../../deploy/scripts/start.ps1'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ("dsh-start-wrapper-"+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  Copy-Item -LiteralPath $source -Destination (Join-Path $testRoot 'start.ps1')
  $fixture=@'
const args=process.argv.slice(2);
console.log(JSON.stringify({args,home:process.env.DSH_HOME}));
if(args.includes('fail')) process.exitCode=7;
'@
  [IO.File]::WriteAllText((Join-Path $testRoot 'deployment.mjs'),$fixture+"`n",[Text.UTF8Encoding]::new($false))
  $before=$env:DSH_HOME
  $result=& (Join-Path $testRoot 'start.ps1') -Plugins one,two -Profile custom -Mode release -HarnessRoot '../official with spaces' -Home 'data/local home' -Config 'deploy/config/example.json' -Resume
  $actual=$result | ConvertFrom-Json
  $expected=@('start','--mode','release','--profile','custom','--plugins','one,two','--harness-root','../official with spaces','--config','deploy/config/example.json','--home','data/local home','--resume')
  if (($actual.args | ConvertTo-Json -Compress) -ne ($expected | ConvertTo-Json -Compress)) {throw 'PowerShell 包装器参数与统一协议不一致'}
  if ($env:DSH_HOME -ne $before) {throw '包装器修改了调用者环境'}
  $failed=$false
  try {& (Join-Path $testRoot 'start.ps1') -Mode release -Manifest fail | Out-Null} catch {$failed=$true}
  if (-not $failed) {throw 'Node执行器失败未传播'}
  Write-Output 'PowerShell参数与失败传播检查通过。'
} finally {
  $resolved=[IO.Path]::GetFullPath($testRoot)
  $prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {throw '测试清理路径越界'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
exit 0
