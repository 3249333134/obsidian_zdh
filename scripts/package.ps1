$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '插件构建失败。' }
& node scripts/build-company-role-templates.mjs
if ($LASTEXITCODE -ne 0) { throw '岗位模板生成失败。' }
& npm.cmd run build --prefix server/company
if ($LASTEXITCODE -ne 0) { throw '公司服务构建失败。' }
& node scripts/package-company.mjs
if ($LASTEXITCODE -ne 0) { throw '公司交付文件准备失败。' }
$releasePath = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
$packagePath = Join-Path $projectRoot 'dist/knowledge-flow'
if (-not (Test-Path -LiteralPath (Join-Path $packagePath 'main.js'))) { throw '请先运行 npm run build' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$zipPath = Join-Path $releasePath "knowledge-flow-$version.zip"
Compress-Archive -LiteralPath $packagePath -DestinationPath $zipPath -Force
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw '找不到 Windows .NET Framework 编译器。' }
$exePath = Join-Path $releasePath "知流工作台安装器-$version.exe"
& $compilerPath /nologo /target:winexe /platform:anycpu "/out:$exePath" "/resource:$zipPath,payload.zip" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Core.dll (Join-Path $projectRoot 'installer/Installer.cs')
if ($LASTEXITCODE -ne 0) { throw '安装器编译失败。' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $releasePath '使用说明.md') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'DIARY-CONNECTION.md') -Destination (Join-Path $releasePath "Diary连接说明-$version.md") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "VERIFICATION-$version.md") -Destination (Join-Path $releasePath "验收记录-$version.md") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'COMPANY-GUIDE.md') -Destination (Join-Path $releasePath "公司连接说明-$version.md") -Force
$companyPaths = Get-Content -LiteralPath (Join-Path $projectRoot '.test-output/company-package-paths.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$serverZip = Join-Path $releasePath "knowledge-flow-company-server-$version.zip"
$sourceZip = Join-Path $releasePath "knowledge-flow-source-$version.zip"
Compress-Archive -LiteralPath $companyPaths.server -DestinationPath $serverZip -Force
Compress-Archive -LiteralPath $companyPaths.source -DestinationPath $sourceZip -Force
$templatesZip = Join-Path $releasePath "knowledge-flow-role-templates-$version.zip"
Compress-Archive -LiteralPath (Join-Path $projectRoot 'templates/company-roles') -DestinationPath $templatesZip -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'ROLE-TEMPLATES.md') -Destination (Join-Path $releasePath "岗位模板说明-$version.md") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'ROLE-TEMPLATES.md') -Destination (Join-Path $releasePath 'ROLE-TEMPLATES.md') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'ROLE-WORKSPACES.md') -Destination (Join-Path $releasePath "岗位工作区说明-$version.md") -Force
$hashLines = foreach ($artifactPath in @($exePath,$zipPath,$serverZip,$sourceZip,$templatesZip)) {
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $hashValue = [BitConverter]::ToString($hashAlgorithm.ComputeHash([IO.File]::ReadAllBytes($artifactPath))).Replace('-', '')
        "$hashValue  $([IO.Path]::GetFileName($artifactPath))"
    } finally { $hashAlgorithm.Dispose() }
}
$hashLines | Set-Content -LiteralPath (Join-Path $releasePath 'SHA256SUMS.txt') -Encoding utf8
Write-Output "交付文件已生成：$releasePath"
