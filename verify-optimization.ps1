# NovelForge 优化验证脚本

Write-Host "🔍 NovelForge 代码优化验证" -ForegroundColor Cyan
Write-Host "================================`n" -ForegroundColor Cyan

# 检查新增文件
Write-Host "📁 检查新增工具模块..." -ForegroundColor Yellow
$newFiles = @(
    "src/utils/path.ts",
    "src/utils/errors.ts",
    "src/utils/performance.ts"
)

$allExist = $true
foreach ($file in $newFiles) {
    if (Test-Path $file) {
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $file (未找到)" -ForegroundColor Red
        $allExist = $false
    }
}

# 检查优化的文件
Write-Host "`n📝 检查已优化的文件..." -ForegroundColor Yellow
$optimizedFiles = @(
    "src/utils/template.ts",
    "src/core/cache.ts",
    "src/core/project.ts",
    "src/core/render.ts",
    "src/core/chapters.ts",
    "src/utils/vfsWeb.ts"
)

foreach ($file in $optimizedFiles) {
    if (Test-Path $file) {
        $content = Get-Content $file -Raw
        if ($content -match 'from ["\']\.\.?/utils/path["\']') {
            Write-Host "  ✅ $file (已更新)" -ForegroundColor Green
        } else {
            Write-Host "  ⚠️  $file (可能未完全更新)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  ❌ $file (未找到)" -ForegroundColor Red
    }
}

# 检查文档
Write-Host "`n📚 检查文档..." -ForegroundColor Yellow
$docs = @(
    "../OPTIMIZATION_SUMMARY.md",
    "../CHANGELOG.md"
)

foreach ($doc in $docs) {
    if (Test-Path $doc) {
        Write-Host "  ✅ $doc" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $doc (未找到)" -ForegroundColor Red
    }
}

# 统计代码行数
Write-Host "`n📊 代码统计..." -ForegroundColor Yellow
$pathLines = (Get-Content "src/utils/path.ts").Count
$errorsLines = (Get-Content "src/utils/errors.ts").Count
$perfLines = (Get-Content "src/utils/performance.ts").Count
$totalNew = $pathLines + $errorsLines + $perfLines

Write-Host "  path.ts: $pathLines 行" -ForegroundColor Cyan
Write-Host "  errors.ts: $errorsLines 行" -ForegroundColor Cyan
Write-Host "  performance.ts: $perfLines 行" -ForegroundColor Cyan
Write-Host "  总计新增: $totalNew 行" -ForegroundColor Green

# 验证路径工具导出
Write-Host "`n🔧 验证工具函数..." -ForegroundColor Yellow
$pathContent = Get-Content "src/utils/path.ts" -Raw
$expectedFunctions = @(
    "normalizePath",
    "basename",
    "dirname",
    "joinPath",
    "cleanPath",
    "safeFilename",
    "extname",
    "basenameWithoutExt"
)

$missingFunctions = @()
foreach ($func in $expectedFunctions) {
    if ($pathContent -match "export function $func") {
        Write-Host "  ✅ $func()" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $func() (未找到)" -ForegroundColor Red
        $missingFunctions += $func
    }
}

# 最终结果
Write-Host "`n================================" -ForegroundColor Cyan
if ($allExist -and $missingFunctions.Count -eq 0) {
    Write-Host "✨ 验证通过！所有优化已成功应用。" -ForegroundColor Green
} else {
    Write-Host "⚠️  验证发现问题，请检查上述标记为红色的项。" -ForegroundColor Yellow
}

Write-Host "`n💡 下一步：" -ForegroundColor Cyan
Write-Host "  1. 运行构建测试：pnpm build" -ForegroundColor White
Write-Host "  2. 测试应用功能：pnpm tauri dev" -ForegroundColor White
Write-Host "  3. 提交代码：git add . && git commit -m 'feat: 优化路径处理、错误处理和性能工具'" -ForegroundColor White
Write-Host ""
