param(
    # Entegrasyon testinin kullanacağı plugin JAR'ı (üretilmiş 1.2.2 JAR'ı).
    [Parameter(Mandatory = $true)]
    [string]$Jar,

    [string]$JavaBin = '',

    # JAR'dan önce yüklenecek kütüphaneler (Windows'ta tam sqlite-jdbc).
    [string[]]$PrependClasspath = @(),

    # Paper'ın sağladığı ek kütüphaneler (slf4j-api).
    [string[]]$ExtraClasspath = @(),

    # node.exe'nin bulunduğu klasör (PATH'te değilse).
    [string]$NodeBin = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$jarPath = (Resolve-Path -LiteralPath $Jar).Path
$javac = if ($JavaBin) { Join-Path $JavaBin 'javac.exe' } else { (Get-Command javac -ErrorAction Stop).Source }
$java = if ($JavaBin) { Join-Path $JavaBin 'java.exe' } else { (Get-Command java -ErrorAction Stop).Source }
$node = if ($NodeBin) { Join-Path $NodeBin 'node.exe' } else { (Get-Command node -ErrorAction Stop).Source }

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("nautilus-link-it-" + [guid]::NewGuid())))
$classes = Join-Path $tempRoot 'classes'
New-Item -ItemType Directory -Force $classes | Out-Null

try {
    $prepend = $PrependClasspath | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
    $extra = $ExtraClasspath | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
    $support = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'test\support') -Filter '*.java' |
        ForEach-Object { $_.FullName }
    $ErrorActionPreference = 'Continue'
    & $javac -encoding UTF-8 -cp ((@($prepend) + @($jarPath)) -join ';') -d $classes $support 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "Harness derlemesi başarısız: $LASTEXITCODE" }

    $env:NAUTILUS_LINK_IT_JAVA = $java
    $env:NAUTILUS_LINK_IT_CLASSPATH = (@($classes) + @($prepend) + @($jarPath) + @($extra)) -join ';'
    Push-Location (Join-Path $PSScriptRoot '..')
    try {
        & $node --test 'test/linkintegration.test.js' 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw "Entegrasyon testi başarısız: $code" }
    Write-Output 'Entegrasyon testi geçti.'
} finally {
    Remove-Item Env:\NAUTILUS_LINK_IT_JAVA -ErrorAction SilentlyContinue
    Remove-Item Env:\NAUTILUS_LINK_IT_CLASSPATH -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
