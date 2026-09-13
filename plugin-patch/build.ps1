param(
    [Parameter(Mandatory = $true)]
    [string]$InputJar,

    [string]$OutputJar = (Join-Path $PSScriptRoot '..\dist\NautilusUHC-1.2.1-linkfix.jar'),

    [string]$JavaBin = ''
)

$ErrorActionPreference = 'Stop'

$inputPath = (Resolve-Path -LiteralPath $InputJar).Path
$outputPath = [IO.Path]::GetFullPath($OutputJar)
if ([IO.Path]::GetExtension($inputPath) -ne '.jar' -or [IO.Path]::GetExtension($outputPath) -ne '.jar') {
    throw 'Girdi ve çıktı .jar uzantılı olmalı.'
}

if ($JavaBin) {
    $javac = Join-Path $JavaBin 'javac.exe'
    $jar = Join-Path $JavaBin 'jar.exe'
} else {
    $javac = (Get-Command javac -ErrorAction Stop).Source
    $jar = (Get-Command jar -ErrorAction Stop).Source
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("nautilus-linkfix-" + [guid]::NewGuid())))
if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Geçici çalışma dizini güvenli temp kökünün dışında.'
}

$classes = Join-Path $tempRoot 'classes'
$metadata = Join-Path $tempRoot 'metadata'
New-Item -ItemType Directory -Force $classes, $metadata | Out-Null

try {
    $sourceDirectory = Join-Path $PSScriptRoot 'src\com\nautilus\discordlink'
    $sources = Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.java' |
        Select-Object -ExpandProperty FullName
    & $javac -encoding UTF-8 -cp $inputPath -d $classes $sources
    if ($LASTEXITCODE -ne 0) { throw "javac başarısız oldu: $LASTEXITCODE" }

    Push-Location $metadata
    try {
        & $jar --extract --file $inputPath plugin.yml config.yml
        if ($LASTEXITCODE -ne 0) { throw "JAR metadata çıkarılamadı: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    $pluginFile = Join-Path $metadata 'plugin.yml'
    $pluginText = [IO.File]::ReadAllText($pluginFile)
    $pluginText = [regex]::Replace($pluginText, '(?m)^version:\s*.*$', 'version: 1.2.1')
    [IO.File]::WriteAllText($pluginFile, $pluginText, $utf8NoBom)

    # İlk kurulum varsayılanına üretim sırrı gömmeyelim. Sunucudaki mevcut
    # plugins/NautilusUHC/config.yml dosyası JAR değişiminden etkilenmez.
    $configFile = Join-Path $metadata 'config.yml'
    $configText = [IO.File]::ReadAllText($configFile)
    $configText = [regex]::Replace(
        $configText,
        '(?m)^(\s*token:\s*).+$',
        { param($match) $match.Groups[1].Value + '""' }
    )
    $configText = [regex]::Replace(
        $configText,
        '(?m)^  # Aynı bota YALNIZ BİR Minecraft sunucusu bağlanmalıdır: hesap bağlama kodları\r?\n' +
            '^  # sunucunun BELLEĞİNDE tutulur, dolayısıyla kodu üreten sunucu ile doğrulayan\r?\n' +
            '^  # sunucu farklı olursa oyuncu doğru kodu girdiği hâlde "kod geçersiz" görür\.\r?\n',
        "  # Her Minecraft süreci farklı bir instance-id kullanmalıdır; bot doğrulamayı`r`n" +
            "  # kodu üreten instance'a hedefler. /link kodları ayrıca yerel diskte`r`n" +
            "  # tutulur ve yinelenen aynı-hesap teslimleri güvenle idempotenttir.`r`n"
    )
    [IO.File]::WriteAllText($configFile, $configText, $utf8NoBom)

    $outputDirectory = Split-Path -Parent $outputPath
    New-Item -ItemType Directory -Force $outputDirectory | Out-Null
    Copy-Item -LiteralPath $inputPath -Destination $outputPath -Force

    & $jar --update --file $outputPath `
        -C $classes 'com/nautilus/discordlink' `
        -C $metadata plugin.yml `
        -C $metadata config.yml
    if ($LASTEXITCODE -ne 0) { throw "JAR güncellenemedi: $LASTEXITCODE" }

    Write-Output $outputPath
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
