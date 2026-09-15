param(
    # Testlerin çalışacağı plugin JAR'ı (girdi ya da üretilmiş JAR).
    [Parameter(Mandatory = $true)]
    [string]$Jar,

    [string]$JavaBin = '',

    # Çalıştırılacak test sınıfları. Boşsa plugin-patch/test altındaki tüm *Test.java.
    [string[]]$Tests = @(),

    # Paper'ın çalışma zamanında sağladığı, JAR'a gömülü olmayan kütüphaneler
    # (ör. HikariCP'nin istediği slf4j-api.jar).
    [string[]]$ExtraClasspath = @(),

    # JAR'dan ÖNCE yüklenecek kütüphaneler. Plugin JAR'ı yalnız Linux SQLite
    # native'lerini gömer; Windows'ta tam sqlite-jdbc sürücüsü başa konur.
    [string[]]$PrependClasspath = @()
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$jarPath = (Resolve-Path -LiteralPath $Jar).Path
if ($JavaBin) {
    $javac = Join-Path $JavaBin 'javac.exe'
    $java = Join-Path $JavaBin 'java.exe'
} else {
    $javac = (Get-Command javac -ErrorAction Stop).Source
    $java = (Get-Command java -ErrorAction Stop).Source
}

$testDirectory = Join-Path $PSScriptRoot 'test'
if ($Tests.Count -eq 0) {
    $Tests = Get-ChildItem -LiteralPath $testDirectory -Filter '*Test.java' |
        Sort-Object Name | ForEach-Object { $_.BaseName }
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("nautilus-linkfix-tests-" + [guid]::NewGuid())))
$classes = Join-Path $tempRoot 'classes'
New-Item -ItemType Directory -Force $classes | Out-Null

$failed = @()
try {
    # Testler yalnız JAR'daki sınıflarla derlenir; kaynak ağacı sınıf yoluna girmez.
    $sources = @()
    foreach ($test in $Tests) {
        $sources += (Join-Path $testDirectory "$test.java")
    }
    $support = Join-Path $testDirectory 'support'
    if (Test-Path -LiteralPath $support) {
        $sources += Get-ChildItem -LiteralPath $support -Filter '*.java' | ForEach-Object { $_.FullName }
    }
    # Windows PowerShell stderr satırlarını (ör. slf4j uyarısı) hata kaydına
    # çevirir; sonuç yalnız çıkış koduyla değerlendirilir.
    $ErrorActionPreference = 'Continue'
    $extra = $ExtraClasspath | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
    $prepend = $PrependClasspath | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
    $compilePath = (@($prepend) + @($jarPath)) -join ';'
    & $javac -encoding UTF-8 -cp $compilePath -d $classes $sources 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "Test derlemesi başarısız: $LASTEXITCODE" }

    $classPath = (@($classes) + @($prepend) + @($jarPath) + @($extra)) -join ';'
    foreach ($test in $Tests) {
        Write-Output "== $test"
        & $java '-Dstdout.encoding=UTF-8' '-Dstderr.encoding=UTF-8' -cp $classPath $test 2>&1 |
            ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^SLF4J' }
        if ($LASTEXITCODE -ne 0) { $failed += $test }
    }
    $ErrorActionPreference = 'Stop'
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}

if ($failed.Count -gt 0) {
    Write-Output "BAŞARISIZ: $($failed -join ', ')"
    exit 1
}
Write-Output "Tüm Java testleri geçti ($($Tests.Count))."
