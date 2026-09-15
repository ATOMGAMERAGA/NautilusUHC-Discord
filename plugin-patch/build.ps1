param(
    # Değiştirilmeden okunacak taban JAR (ör. dist/NautilusUHC-1.2.1-linkfix.jar).
    [Parameter(Mandatory = $true)]
    [string]$InputJar,

    [string]$OutputJar = (Join-Path $PSScriptRoot '..\dist\NautilusUHC-1.2.2-linkfix.jar'),

    [string]$Version = '1.2.2',

    [string]$JavaBin = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$inputPath = (Resolve-Path -LiteralPath $InputJar).Path
$outputPath = [IO.Path]::GetFullPath($OutputJar)
if ([IO.Path]::GetExtension($inputPath) -ne '.jar' -or [IO.Path]::GetExtension($outputPath) -ne '.jar') {
    throw 'Girdi ve çıktı .jar uzantılı olmalı.'
}
if ($inputPath -ieq $outputPath) {
    throw 'Çıktı JAR girdi JAR ile aynı olamaz; taban JAR değiştirilmez.'
}

if ($JavaBin) {
    $javac = Join-Path $JavaBin 'javac.exe'
    $javap = Join-Path $JavaBin 'javap.exe'
} else {
    $javac = (Get-Command javac -ErrorAction Stop).Source
    $javap = (Get-Command javap -ErrorAction Stop).Source
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("nautilus-linkfix-" + [guid]::NewGuid())))
if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Geçici çalışma dizini güvenli temp kökünün dışında.'
}
$stubs = Join-Path $tempRoot 'stubs'
$classes = Join-Path $tempRoot 'classes'
$baseClasses = Join-Path $tempRoot 'base-classes'
New-Item -ItemType Directory -Force $stubs, $classes, $baseClasses | Out-Null

# Değiştirilen upstream sınıfları: yalnız bunlar JAR'dan çıkarılıp yeniden eklenir.
$replacedPrefixes = @('com/nautilus/discordlink/')
$replacedBridge = @('com/nautilus/bridge/BridgePoller', 'com/nautilus/bridge/BridgeInstance')

function Test-Replaced([string]$name) {
    foreach ($prefix in $replacedPrefixes) { if ($name.StartsWith($prefix)) { return $true } }
    foreach ($class in $replacedBridge) {
        if ($name -eq "$class.class" -or $name.StartsWith("$class`$")) { return $true }
    }
    return $name -eq 'plugin.yml' -or $name -eq 'config.yml'
}

function Invoke-Native([scriptblock]$command, [string]$failure) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $command 2>&1 | ForEach-Object { "$_" }
        if ($LASTEXITCODE -ne 0) { throw "$failure ($LASTEXITCODE)" }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-ExternalRefs([string]$classRoot) {
    $names = Get-ChildItem -LiteralPath $classRoot -Recurse -Filter '*.class' |
        ForEach-Object { $_.FullName.Substring($classRoot.Length + 1).Replace('\', '/').Replace('.class', '') }
    $refs = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($i = 0; $i -lt $names.Count; $i += 40) {
        $chunk = $names[$i..([Math]::Min($i + 39, $names.Count - 1))]
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $output = & $javap -v -p -cp $classRoot $chunk 2>$null
        $ErrorActionPreference = $previous
        foreach ($line in $output) {
            if ($line -match '= (Methodref|InterfaceMethodref|Fieldref)\s+#\d+\.#\d+\s+//\s+(\S+)') {
                # İkinci -match $Matches'i ezer; eşleşmeleri önce yerel değişkenlere al.
                $kind = $Matches[1]
                $reference = $Matches[2]
                foreach ($prefix in 'org/bukkit/', 'net/kyori/', 'com/google/gson/', 'io/papermc/', 'net/md_5/') {
                    if ($reference.StartsWith($prefix)) {
                        [void]$refs.Add("$kind $reference")
                        break
                    }
                }
            }
        }
    }
    return ,$refs
}

function Get-EntryHash([System.IO.Compression.ZipArchiveEntry]$entry) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $entry.Open()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($stream))
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

try {
    # 1) Derleme stub'ları (yalnız derleme için; JAR'a GİRMEZ).
    $stubSources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'compile-stubs') -Recurse -Filter '*.java' |
        ForEach-Object { $_.FullName }
    Invoke-Native { & $javac -encoding UTF-8 --release 21 -d $stubs $stubSources } 'Stub derlemesi başarısız'

    # 2) Yama kaynakları taban JAR + stub'larla derlenir.
    $sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' |
        ForEach-Object { $_.FullName }
    Invoke-Native { & $javac -encoding UTF-8 --release 21 -cp "$inputPath;$stubs" -d $classes $sources } 'javac başarısız'
    $foreign = Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' |
        Where-Object { -not $_.FullName.Substring($classes.Length + 1).Replace('\', '/').StartsWith('com/nautilus/') }
    if ($foreign) { throw "Derleme çıktısında com/nautilus dışı sınıf var: $($foreign.FullName -join ', ')" }

    # 3) Stub doğrulaması: yeni sınıfların Paper API referanslarının hepsi taban
    #    JAR'da zaten çalışan referanslar olmalı (yanlış imza = çalışma zamanı hatası).
    $zip = [IO.Compression.ZipFile]::OpenRead($inputPath)
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.StartsWith('com/nautilus/') -and $entry.FullName.EndsWith('.class')) {
                $target = Join-Path $baseClasses ($entry.FullName.Replace('/', '\'))
                New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            }
        }
        $pluginYml = [IO.StreamReader]::new($zip.GetEntry('plugin.yml').Open(), [Text.UTF8Encoding]::new($false)).ReadToEnd()
        $configYml = [IO.StreamReader]::new($zip.GetEntry('config.yml').Open(), [Text.UTF8Encoding]::new($false)).ReadToEnd()
    } finally {
        $zip.Dispose()
    }
    $known = Get-ExternalRefs $baseClasses
    $used = Get-ExternalRefs $classes
    $unknown = @($used | Where-Object { -not $known.Contains($_) })
    if ($unknown.Count -gt 0) {
        throw "Taban JAR'da doğrulanmamış Paper/Adventure/Gson referansı: `n$($unknown -join "`n")"
    }
    Write-Output "API referans doğrulaması: $($used.Count) referansın tamamı taban JAR'da mevcut."

    # 4) Metadata: sürüm, /unlink kullanımı, instance-id açıklaması; token boş kalır.
    $pluginYml = [regex]::Replace($pluginYml, '(?m)^version:\s*.*$', "version: $Version")
    $unlinkPattern = '(?m)^(  unlink:\r?\n    description: ).*(\r?\n    usage: ).*$'
    if (-not [regex]::IsMatch($pluginYml, $unlinkPattern)) { throw 'plugin.yml unlink bloğu bulunamadı.' }
    $pluginYml = [regex]::Replace($pluginYml, $unlinkPattern, {
        param($m)
        $m.Groups[1].Value + "Minecraft–Discord hesap bağlantısını iki taraftan kaldırır" +
            $m.Groups[2].Value + '/unlink <oyuncu> [sebep] | /unlink <mc|dc|uuid> <değer> [sebep]'
    })

    $configYml = [regex]::Replace($configYml, '(?m)^(\s*token:\s*).+$', { param($m) $m.Groups[1].Value + '""' })
    $instancePattern = '(?ms)^  # Bu sunucunun köprüdeki kimliği\..*?^  instance-id:[^\r\n]*'
    if (-not [regex]::IsMatch($configYml, $instancePattern)) { throw 'config.yml instance-id bloğu bulunamadı.' }
    $newline = if ($configYml.Contains("`r`n")) { "`r`n" } else { "`n" }
    $instanceBlock = @(
        '  # Bu sunucunun köprüdeki kimliği; her yoklamada bota gönderilir.',
        '  # /link kodları bu kimlikten türeyen 2 karakterlik kapsamla başlar ve bot',
        '  # doğrulamayı yalnız kodu üreten sunucuya gönderir (plugin 1.2.2).',
        '  # Aynı bota birden fazla sunucu (test + canlı) bağlanıyorsa her birine FARKLI',
        '  # bir değer ver. Boş bırakılırsa kalıcı bir kimlik üretilip',
        '  # plugins/NautilusUHC/bridge-instance-id dosyasına yazılır; bu klasörü başka',
        '  # bir sunucuya kopyalarsan o dosyayı sil ya da instance-id ayarla.',
        '  instance-id: ""'
    ) -join $newline
    $configYml = [regex]::Replace($configYml, $instancePattern, { param($m) $instanceBlock })

    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $tempRoot 'plugin.yml'), $pluginYml, $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $tempRoot 'config.yml'), $configYml, $utf8NoBom)

    # 5) Çıktı sıfırdan yazılır: taban JAR'daki girişler aynı sırayla ve zaman
    #    damgasıyla kopyalanır, yalnız değiştirilen girişler yenileriyle değişir.
    #    (.NET Framework ZipArchive Update modu bazı dizin girişlerini tutarsız
    #    başlıkla yeniden yazdığı için kullanılmaz.)
    $outputDirectory = Split-Path -Parent $outputPath
    New-Item -ItemType Directory -Force $outputDirectory | Out-Null
    if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
    $source = [IO.Compression.ZipFile]::OpenRead($inputPath)
    $target = [IO.Compression.ZipFile]::Open($outputPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entry in $source.Entries) {
            if (Test-Replaced $entry.FullName) { continue }
            $copy = $target.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
            $copy.LastWriteTime = $entry.LastWriteTime
            if (-not $entry.FullName.EndsWith('/')) {
                $reader = $entry.Open()
                $writer = $copy.Open()
                try {
                    $reader.CopyTo($writer)
                } finally {
                    $writer.Dispose()
                    $reader.Dispose()
                }
            }
        }
        Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | Sort-Object FullName | ForEach-Object {
            $name = $_.FullName.Substring($classes.Length + 1).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($target, $_.FullName, $name,
                [IO.Compression.CompressionLevel]::Optimal)
        }
        foreach ($meta in 'plugin.yml', 'config.yml') {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($target, (Join-Path $tempRoot $meta), $meta,
                [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally {
        $target.Dispose()
        $source.Dispose()
    }

    # JDK'nın kendi zip okuyucusu her girişi boyut/CRC denetimiyle açabilmeli.
    $extractCheck = Join-Path $tempRoot 'extract-check'
    New-Item -ItemType Directory -Force $extractCheck | Out-Null
    $jarTool = if ($JavaBin) { Join-Path $JavaBin 'jar.exe' } else { (Get-Command jar -ErrorAction Stop).Source }
    Push-Location $extractCheck
    try {
        Invoke-Native { & $jarTool --extract --file $outputPath } 'Üretilen JAR JDK ile açılamadı'
    } finally {
        Pop-Location
    }

    # 6) Doğrulama: değiştirilmeyen her girişin içeriği taban JAR ile birebir aynı.
    $before = [IO.Compression.ZipFile]::OpenRead($inputPath)
    $after = [IO.Compression.ZipFile]::OpenRead($outputPath)
    try {
        $afterByName = @{}
        foreach ($entry in $after.Entries) { $afterByName[$entry.FullName] = $entry }
        $checked = 0
        foreach ($entry in $before.Entries) {
            if (Test-Replaced $entry.FullName) { continue }
            $copy = $afterByName[$entry.FullName]
            if (-not $copy) { throw "Değiştirilmemesi gereken giriş kayboldu: $($entry.FullName)" }
            if ($entry.Length -ne $copy.Length -or (Get-EntryHash $entry) -ne (Get-EntryHash $copy)) {
                throw "Değiştirilmemesi gereken giriş farklı: $($entry.FullName)"
            }
            $checked++
        }
        $versionLine = ([IO.StreamReader]::new($afterByName['plugin.yml'].Open()).ReadToEnd() -split "`n" |
            Where-Object { $_ -match '^version:' } | Select-Object -First 1).Trim()
        if ($versionLine -ne "version: $Version") { throw "plugin.yml sürümü beklenen değil: $versionLine" }
        Write-Output "Değişmeyen giriş doğrulandı: $checked; plugin.yml $versionLine"
    } finally {
        $before.Dispose()
        $after.Dispose()
    }

    $hash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
    Write-Output "Çıktı: $outputPath"
    Write-Output "SHA-256: $hash"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
