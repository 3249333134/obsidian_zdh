$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$vaultPath='D:\prj\obsidian'
if (@(Get-Process -Name Obsidian -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Obsidian仍在运行，请先正常退出；此脚本不会结束进程。' }
$pluginPath=Join-Path $vaultPath '.obsidian/plugins/knowledge-flow'
$dataPath=Join-Path $pluginPath 'data.json'
$before=[IO.File]::ReadAllText($dataPath)
$beforeData=$before|ConvertFrom-Json
$beforeHash=(Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash
$exePath=Join-Path $projectRoot 'release/知流工作台安装器-0.9.0.exe'
$process=Start-Process -FilePath $exePath -ArgumentList @('--test-install',('"'+$vaultPath+'"')) -WindowStyle Hidden -Wait -PassThru
if($process.ExitCode -ne 0){throw "安装器失败：$($process.ExitCode)"}
if((Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash -ne $beforeHash){throw '安装期间配置发生变化，请核对；没有自动改写。'}
$installedVersion=([IO.File]::ReadAllText((Join-Path $pluginPath 'manifest.json'))|ConvertFrom-Json).version
$installedMainHash=(Get-FileHash -LiteralPath (Join-Path $pluginPath 'main.js') -Algorithm SHA256).Hash
$expectedMainHash=(Get-FileHash -LiteralPath (Join-Path $projectRoot 'dist/knowledge-flow/main.js') -Algorithm SHA256).Hash
if($installedVersion -ne '0.9.0' -or $installedMainHash -ne $expectedMainHash){throw '安装版本或主文件校验不一致。'}
$result=[ordered]@{version=$installedVersion;vault=$vaultPath;mainSha256=$installedMainHash;installerPreservedConfig=$true;previousTaskCount=@($beforeData.tasks).Count;diaryConnected=[bool]$beforeData.diary.connection;diaryEnabled=[bool]$beforeData.diary.connection.enabled;companyAutoConnected=$false;installedAt=[DateTimeOffset]::Now.ToString('o')}
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $projectRoot '.test-output/installation-0.9.0.json') -Encoding UTF8
$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $projectRoot 'release/安装结果-0.9.0.json') -Encoding UTF8
$result|ConvertTo-Json
