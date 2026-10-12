# NautilusUHC plugin yaması (1.2.9-message-studio)

Bu klasör; dağıtılan NautilusUHC JAR’ındaki hesap bağlama, takım yönetimi,
maç planlama ve Discord duyuru sınıflarının kaynaklarını, derleme betiklerini
ve regresyon testlerini tutar. Pluginin geri kalan kaynağı burada değildir; derleme mevcut
JAR'a karşı yapılır ve JAR'daki diğer girişler bayt bayt korunur.


## 1.2.9 maç ödülü ve duyuru ayarları

- `/uhcadmin` → yeni maç taslağında ödül serbest metindir (en fazla 240 karakter).
  Ödül öğesine sol tıklayıp örste düzenle; boş metin veya sağ tık ödülü kaldırır.
  Aynı taslak hem planlama hem hemen başlatma için kullanılır.
- Discord sayfasında ve maç düzenleyicide `@everyone` ve `@here` ayrı anahtarlardır.
  Yeni/eski ayarsız hostlarda ikisi de **kapalıdır**. UUID’ye göre
  `host-preferences.properties` dosyasında saklanır.
- Her plan ödül ve iki anahtarı kendi `admin-schedule.properties` kaydına kopyalar.
  Hostun sonraki taslak değişiklikleri mevcut planı veya çalışan maçı değiştirmez.
- Takım seçimleri **FFA (takımsız solo), To2, To3** ile sınırlıdır. FFA mevcut
  atamaları temizler. Eski 4+ boyut ayarları açılışta/plan yüklemesinde To3’e
  indirilir; sığmayan takımlar düzenlenmeden takım maçı başlatılmaz.
- `match_scheduled`, `match_start`, `match_end` olaylarının `data` alanında
  `host`, `hostDiscordId`, `teamSize`, `scenarios`, `prize`, `mentionEveryone`,
  `mentionHere` bulunur. `hostDiscordId` maç hostunun UUID’sinin **LinkService**
  kaydından alınır; bağlantı yoksa boş metindir. `match_end.winners` gerçek
  kazanan isimlerini içerir; mevcut `winner` alanı da korunur.
- Sonuç bildirimi veritabanından gecikmeli gelirse tamamlanan maçın host/ödül/
  anahtar/kazanan kopyası kullanılır. Yeni maçın ayarları eski sonuca sızmaz.
  Köprü metot imzaları, olay adları, HMAC ve HTTP teslim akışı korunmuştur.

### Linux derleme ve test

JDK 21 ile **gerçek Paper 1.21.11 API** ve bağımlılık JAR’larını ayrı bir klasöre
koyun. `compile-stubs/` bu derleme için kullanılmaz ve API sınıfları çıktıya
paketlenmez. Kullanılan Paper sürümü: `paper-api-1.21.11-R0.1-20260511.115010-91`.
Derleme bağımlılıkları Paper POM’undaki sürümlerle eşleşir: Adventure 4.26.1,
Examination 1.3.0, Gson 2.11.0, Guava 33.3.1-jre, SnakeYAML 2.2,
SLF4J 2.0.16, Log4j API 2.24.1 ve BungeeCord Chat
`1.21-R0.2-deprecated+build.21`. JAR’ları Maven Central/Paper Artifactory’den alın.

```bash
python3 plugin-patch/build.py BASE.jar dist/NautilusUHC-1.2.9-message-studio.jar \
  --java-bin /path/to/jdk21/bin --api-dir /path/to/paper-libraries
python3 plugin-patch/test.py dist/NautilusUHC-1.2.9-message-studio.jar \
  --java-bin /path/to/jdk21/bin --api-dir /path/to/paper-libraries
```

`build.py` arşivi tekrar okur; değiştirilmesi gerekmeyen girişlerin içeriğini
bayt bayt taban JAR ile karşılaştırır. `test.py` bütün `*Test.java` sınıflarını
**üretilen JAR’a karşı** derler ve çalıştırır. Testler; ödülün yeniden yükleme ve
host ayarı değişikliklerine dayanmasını, iki etiketin bağımsızlığını, eski plan
geçişlerini, takım sınırını, maç epoch izolasyonunu ve gerçek HTTP üzerinden
imzalı köprü olaylarını kapsar. Canlı Paper/Discord uçtan uca kontrolü ayrıca
sunucuda yapılmalıdır.

| Dosya | Görev |
|---|---|
| `src/com/nautilus/discordlink/LinkService.java` | Kod üretimi, doğrulama, unlink, geçmiş, işlem uzlaştırma |
| `src/com/nautilus/discordlink/LinkStoreAccess.java` | Hata yutmayan SQLite erişimi ve eklemeli şema geçişi |
| `src/com/nautilus/discordlink/LinkBridgeApi.java` | Köprü API'si (protokol 2), Bukkit'e bağımlı değil |
| `src/com/nautilus/discordlink/LinkScope.java` | Kodun ait olduğu sunucu kapsamı |
| `src/com/nautilus/discordlink/LinkCommands.java` | `/link`, `/unlink` komutları |
| `src/com/nautilus/discordlink/LinkConsistencyCheck.java` | Salt-rapor tutarlılık aracı (CLI) |
| `src/com/nautilus/bridge/BridgePoller.java` | Ters köprü; hedef instance kontrolü, link işlerini API'ye yönlendirme |
| `src/com/nautilus/bridge/BridgeInstance.java` | Kalıcı otomatik köprü kimliği |
| `compile-stubs/` | Yalnız derleme için Paper/Adventure/Gson imzaları (JAR'a girmez) |

## 1.2.1'de kanıtlanan hatalar

`test/LinkRegressionTest.java` 1.2.1 JAR'ına karşı **6/6 FAIL**, 1.2.2'ye karşı
PASS verir:

1. Unlink yalnız bağlantı satırını siliyordu; unlink öncesinde üretilmiş (ör.
   `/link` bağlılık okuması SQL hatasını `null`'a çevirdiğinde) ya da DB commit ile
   kod tüketimi arasında kalmış bir kod, unlink sonrası hesabı **başka bir Discord
   hesabına** bağlıyordu.
2. `/unlink mc <ad>` ve durum sorgusu `mc_name ... LIMIT 1` ile ilk bulunan satırı
   kullanıyordu; isim değiştiren oyuncunun eski adını başkası aldığında yanlış
   bağlantı silinebiliyor/gösteriliyordu.
3. DB hataları `unlink` ve durum sorgularında "bağlantı yok" diye maskeleniyordu.

## 1.2.2 davranışı

- **Kod biçimi:** 2 karakter sunucu kapsamı + 6 karakter güvenli rastgele
  (`9DK7QX4M`). Kapsam `bridge.instance-id`'den türetilir (`LinkScope`, bot
  tarafında `src/linkrouting.js` ile birebir). Kapsam sahipliği kanıtlamaz; bot
  isteği yalnız doğru depoya yönlendirir, sahiplik o deponun özet kaydıyla
  kanıtlanır. 6 karakterli eski kodlar süreleri dolana kadar geçerlidir.
- **Unlink iptali:** Her kod üretildiği andaki unlink sayacını (epoch) ve kendi
  işlem kimliğini taşır. Unlink bağlantıyı siler ve epoch'u **aynı SQLite
  transaction'ında** artırır; kod dosyası güncellemesi kaybolsa bile unlink
  öncesi kodlar ve makbuzlar geçersizdir.
- **Çökme penceresi:** Kurulan bağlantının `link_id`'si kodun işlem kimliğidir.
  DB commit sonrası dosya yazılmadan çökme olursa yeniden deneme DB'den hangi
  işlemin commit olduğunu bilir; aynı hesap idempotent başarı alır, başka hesap
  asla devralamaz.
- **Kesin isim çözümleme:** Ad; bağlantı kayıtları, `players` tablosu ve
  (oyun içinde) Bukkit çevrimiçi/önbellek kayıtlarında birebir aranır. Birden fazla
  hesap eşleşirse hiçbir şey silinmez; UUID/Discord ID istenir.
- **Karşılaştır-ve-sil:** Yönetim panelleri beklenen `link_id` ile kaldırır;
  arada unlink/relink olduysa `stale_version` döner.
- **Denetim geçmişi:** `discord_link_events` link/unlink olaylarını zaman, UUID,
  Discord ID, yapan (yetkili/konsol/oyuncu), sebep, sonuç ve istek kimliğiyle
  tutar. Ham kod ya da secret saklanmaz; geçiş öncesi için olay uydurulmaz.

### Minecraft komutları

```
/link                              yeni kod (öncekini iptal eder)
/unlink <oyuncu> [sebep]           birebir ad, çevrimdışı dahil
/unlink mc <oyuncu> [sebep]        (geriye uyumlu)
/unlink dc <discordId> [sebep]     (geriye uyumlu)
/unlink uuid <uuid> [sebep]
```

`/unlink` için 1.2.1'deki koşullar korunur: `nautilus.mod.unlink` (plugin.yml +
komut içinde açık denetim) ve mevcut `nautilus.host` koşulu. Yetki genişletilmedi.

### Köprü protokolü 2

Ters köprüde (`bridge.mode: outbound`) plugin yoklamalara
`X-Bridge-Link-Protocol: 2` ekler; başka instance'a hedeflenmiş iş çalıştırılmaz
(`421 wrong_instance`). Yanıtlar `instance` ve `requestId` taşır.

| Uç | Açıklama |
|---|---|
| `POST /api/link/v2/probe` | Salt-okunur kod sahipliği |
| `POST /api/link/v2/verify` | Doğrulama (`requestId` ile uzlaştırılabilir) |
| `GET /api/link/v2/operation?requestId=` | Zaman aşımı sonrası işlem sonucu |
| `GET /api/link/v2/info?uuid=\|discord=\|name=` | Bağlantı + son olaylar; belirsiz ad `409` |
| `GET /api/link/v2/list?offset=&limit=` | En son eşleşen önce, eşitlikte UUID; en fazla 25 |
| `GET /api/link/v2/history?uuid=&discord=&limit=&beforeId=` | Denetim geçmişi |
| `POST /api/link/v2/unlink` | `selector`, `value`, `expectedLinkId`, `reason`, `actor` (zorunlu) |

`/api/link/status`, `/api/link/verify` ve `DELETE /api/link` ters köprüde aynı
katı kurallarla yanıtlanır (1.2.1 botlarıyla uyumlu). Yönetim uçları doğrudan
HTTP (`MC_API_URL`) modunda yoktur.

## Derleme

JDK 21 gerekir. Taban JAR değiştirilmez; çıktı ayrı dosyadır.

```powershell
.\plugin-patch\build.ps1 -InputJar .\dist\NautilusUHC-1.2.1-linkfix.jar -JavaBin <jdk21>\bin
```

Betik: stub'ları ve kaynakları derler; yeni sınıfların tüm Paper/Adventure/Gson
referanslarının taban JAR'da zaten kullanılan referanslar olduğunu doğrular;
`plugin.yml` sürümünü `1.2.2` yapar ve `/unlink` kullanımını günceller;
`config.yml` token'ını boş bırakır; değişmeyen her girişin içeriğini taban JAR'la
karşılaştırır, JAR'ı JDK ile tam açarak doğrular ve SHA-256 yazdırır.

## Testler

Plugin JAR'ı yalnız Linux SQLite native'lerini gömer. Windows'ta test için tam
`sqlite-jdbc` JAR'ı sınıf yolunun başına, Paper'ın sağladığı `slf4j-api` sonuna
eklenir:

```powershell
.\plugin-patch\test.ps1 -Jar .\dist\NautilusUHC-1.2.2-linkfix.jar -JavaBin <jdk21>\bin `
  -PrependClasspath <sqlite-jdbc.jar> -ExtraClasspath <slf4j-api.jar>

.\plugin-patch\integration.ps1 -Jar .\dist\NautilusUHC-1.2.2-linkfix.jar -JavaBin <jdk21>\bin `
  -PrependClasspath <sqlite-jdbc.jar> -ExtraClasspath <slf4j-api.jar> -NodeBin <node klasörü>
```

`integration.ps1`, gerçek plugin sınıfları + SQLite ile çalışan
`test/support/LinkBridgeHarness.java` süreçlerini botun gerçek HTTP köprüsüne
bağlar ve `test/linkintegration.test.js`'i çalıştırır.

## Kurulum sırası

1. Sunucuyu durdur; `plugins/NautilusUHC/nautilus-main.db*` ve
   `pending-link-codes.dat*` dosyalarını yedekle.
2. Botu bu sürüme güncelle (eski plugin ile de tek sunucuda güvenli çalışır).
3. `plugins/` altındaki eski NautilusUHC JAR'ını kaldır, `NautilusUHC-1.2.2-linkfix.jar`
   dosyasını koy, sunucuyu başlat.
4. Logda `Discord bağlantı şeması 1.2.2'ye yükseltildi` ve köprü kimliği/kapsamı
   satırını gör; Discord'da `/sağlık` → "Hesap bağlama protokolü: protokol 2".
5. Birden fazla sunucu aynı bota bağlıysa her birine farklı `bridge.instance-id` ver.
6. İsteğe bağlı: tutarlılık raporu (aşağıda).

Şema geçişi yalnız ekleme yapar (`discord_links.link_id` sütunu, `discord_link_epochs`,
`discord_link_events`). İlk açılışta otomatik ön yedek alınır:
`plugins/NautilusUHC/backups/nautilus-main-pre-link-1.2.2-<zaman>.db`.

### Uyumluluk

| Bot | Plugin | Durum |
|---|---|---|
| Bu sürüm | 1.2.2 | Tüm özellikler |
| Bu sürüm | 1.2.1 ve öncesi, tek sunucu | Bağlama çalışır (eski uçlar + geri okuma); yönetim paneli "Plugin güncel değil" der; `/kayıtsil` çalışır |
| Bu sürüm | Birden fazla sunucu, en az biri 1.2.1 | Hesap bağlama güvenlik için durdurulur |
| Eski bot | 1.2.2 | Eski uçlar çalışır; eski botun çoklu sunucu akışı güvenli değildir, botu da güncelle |

## Tutarlılık kontrolü (salt rapor)

Veritabanının **kopyası** üzerinde çalıştır (araç kopyaya şema geçişi uygular):

```bash
java -cp "NautilusUHC-1.2.2-linkfix.jar:libraries/org/slf4j/slf4j-api/<sürüm>/slf4j-api-<sürüm>.jar" \
  com.nautilus.discordlink.LinkConsistencyCheck nautilus-main.kopya.db [pending-link-codes.kopya.dat] > rapor.json
node scripts/link-consistency.js rapor.json data/bot.db
```

Rapor; aynı adı paylaşan bağlantıları, adı değişmiş oyuncuları, adı başka oyuncuya
geçmiş kayıtları, geçersiz Discord ID'lerini, bilinmeyen bağlanma zamanını ve bağlı
oyuncular için bekleyen kodları listeler. Bot betiği bunları bot audit kayıtlarıyla
karşılaştırır. **Hiçbir kayıt otomatik silinmez ve gerçek sahip tahmin edilmez**;
şüpheli kayıtlar oyuncu/yetkili kanıtıyla incelenip gerekirse `/unlink uuid:` ile
tek tek kaldırılır.

## Geri dönüş

1. Sunucuyu durdur, 1.2.2 JAR'ını kaldır, 1.2.1 JAR'ını geri koy.
2. `plugins/NautilusUHC/pending-link-codes.dat`, `.initialized`, `.tmp` ve `.lock`
   dosyalarını sil. 1.2.1 v3 kod dosyasını okuyamaz; bekleyen kodlar kaybolur,
   oyuncular `/link` ile yeni kod alır.
3. Eklenen DB sütun/tabloları 1.2.1 tarafından yok sayılır. Tam geri dönüş
   gerekiyorsa ön yedek geri yüklenebilir; bu durumda yedekten sonra kurulan
   bağlantılar kaybolur.
4. `bridge-instance-id` dosyası 1.2.1 için zararsızdır.
