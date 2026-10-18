$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $projectRoot '.test-output'
$vaultPath = Join-Path $testRoot ('测试 笔记库-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$configPath = Join-Path $vaultPath '.obsidian'
New-Item -ItemType Directory -Path $configPath -Force | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$exePath = Join-Path $projectRoot "release/知流工作台安装器-$version.exe"
function Run-InstallTest([string]$mode, [string]$path) {
    $process = Start-Process -FilePath $exePath -ArgumentList @($mode, ('"' + $path + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer test failed: $mode exit $($process.ExitCode)" }
}
Run-InstallTest '--test-install' $vaultPath
$pluginPath = Join-Path $configPath 'plugins/knowledge-flow'
foreach ($file in @('main.js','manifest.json','styles.css','THIRD-PARTY-LICENSES.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginPath $file))) { throw "Missing payload file: $file" }
}
[IO.File]::WriteAllText((Join-Path $pluginPath 'data.json'), '{"preserve":"配置和任务"}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $vaultPath '原有 笔记.md'), '不能覆盖', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $pluginPath 'main.js'), 'old plugin', [Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Path (Join-Path $pluginPath 'migration-backup-v03') | Out-Null
[IO.File]::WriteAllText((Join-Path $pluginPath 'migration-backup-v03/legacy.md'), 'one-time legacy backup')
[IO.File]::WriteAllText((Join-Path $pluginPath 'data.json.before-history-123'), 'legacy config backup')
Run-InstallTest '--test-install' $vaultPath
if ([IO.File]::ReadAllText((Join-Path $pluginPath 'data.json')) -ne '{"preserve":"配置和任务"}') { throw 'Configuration was changed' }
if ([IO.File]::ReadAllText((Join-Path $vaultPath '原有 笔记.md')) -ne '不能覆盖') { throw 'User note was changed' }
$backupPaths = @(Get-ChildItem -LiteralPath (Join-Path $configPath 'knowledge-flow-backups') -Directory)
if ($backupPaths.Count -lt 1) { throw 'No upgrade backup created' }
if ([IO.File]::ReadAllText((Join-Path $backupPaths[0].FullName 'main.js')) -ne 'old plugin') { throw 'Backup content mismatch' }
if (-not (Test-Path -LiteralPath (Join-Path $pluginPath 'migration-backup-v03/legacy.md'))) { throw 'One-time backup was not preserved' }
if (Test-Path -LiteralPath (Join-Path $backupPaths[0].FullName 'migration-backup-v03')) { throw 'One-time raw backup was duplicated' }
if (Test-Path -LiteralPath (Join-Path $backupPaths[0].FullName 'data.json.before-history-123')) { throw 'Legacy raw config backup was duplicated' }
[IO.File]::WriteAllText((Join-Path $pluginPath 'main.js'), 'rollback original', [Text.UTF8Encoding]::new($false))
Run-InstallTest '--test-rollback' $vaultPath
if ([IO.File]::ReadAllText((Join-Path $pluginPath 'main.js')) -ne 'rollback original') { throw 'Rollback failed' }
Run-InstallTest '--test-install' $vaultPath
$emptyPath = Join-Path $testRoot ('not-a-vault-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $emptyPath -Force | Out-Null
$invalidProcess = Start-Process -FilePath $exePath -ArgumentList @('--test-install', ('"' + $emptyPath + '"')) -WindowStyle Hidden -Wait -PassThru
if ($invalidProcess.ExitCode -eq 0) { throw 'Invalid vault was accepted' }
Write-Output 'Installer checks passed: install, Unicode/spaces, upgrade backup, config and note preservation, rollback, reinstall, invalid vault.'
Write-Output "Test vault: $vaultPath"
