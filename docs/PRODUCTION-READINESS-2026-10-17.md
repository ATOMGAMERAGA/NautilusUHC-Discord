# NautilusUHC production readiness — 17 Ekim 2026

**Karar: NO-GO — mevcut canlı sürüm için.** Doğrulanan P0/P1 düzeltmeleri aşağıdaki ayrı dal ve 1.2.10 JAR'da hazırdır; talep gereği canlıya dağıtılmadı. Düzeltmeler dağıtılıp aşağıdaki gerçek ses/maç provası geçerse karar **CONDITIONAL GO** olarak yeniden değerlendirilebilir. Testlerden %100 sorunsuzluk sonucu çıkarılamaz.

Denetim tabanı: `d01ead02fde07af466a271e5e3828febdbf4a13c`. Çalışma dalı: `codex/readiness-129`. İstenen kapsam [özgün talepte](readiness-request-2026-10-17.md) korunmuştur. Varsayımlar veya doğrulanamayan canlı koşullar başarılı sayılmadı.

## A. Kritik hatalar ve uygulanan düzeltmeler

Satırlar düzeltme sonrası dosyaları gösterir; eski davranış taban commit'te ve RED regresyonlarda yeniden üretildi.

| Öncelik / dosya | Kök neden ve tetikleyici | Uygulanan çözüm / kanıt |
|---|---|---|
| P0 — `src/voice.js:28,63,153` | Döngüde tek üyenin fetch/rol/taşıma 403/429 hatası tüm reconciliation'ı kesiyordu. İlk taşıma başarısızken ortak matchKey ilerlemesi başlangıç retry'sini kaybettirebiliyordu. | Üye bazlı hata izolasyonu, 403 için en az 30 sn, diğer hatalarda en az 5 sn ve 429 retry_after uyumlu backoff; kalıcı pendingRoutes; üye sorgusu bilinmiyorsa pending korunur. Hareketler kişi başına sıralanır, gerçek voice.channelId doğrulanmadan başarı verilmez. Bir oyuncunun hatasında diğer oyuncunun taşınması ve retry testleri var. |
| P0 — `src/voice.js:191` | Yalnız beklenen overwrite imzası tutuluyordu; manuel Connect grant veya rol değişikliği cache'de görünse bile onarılmıyordu. Entry'de tüm member overwrites korunup unlinked giriş açılabiliyordu. | Gerçek gateway cache overwrites normalize edilip beklenen politika ile karşılaştırılıyor. Yalnız fark varsa REST set yapılır. Takım/Solo/İzleyici normal oyuncuların manuel girişine kapalı; entry sadece bağlı rol, bot ve güvenli kullanıcı istisnalarını taşır. İlgisiz kanallar registry dışında kalır. |
| P1 — `src/voice.js:24,57,153`; `src/voiceentrypermissions.js:19` | Unlink, spam engeli, rol kaldırma403 ve köprü kesintisi birlikte olduğunda engel bitişi eski Connect allow'u/neutral'i geri açabiliyordu. Başarısız expiry geçmiş deadline ile 100ms retry döngüsü üretebiliyordu. | Yetkili unlink eski Connect allow restorasyonunu geçersizleştirir. Başarısız rol kaldırma için registry.revoked deny tutulur; expiry resolver bu deny'ı köprü kesilse de korur. Guard REST retry'si kullanıcı bazlı/backoff'ludur; expiry zamanlayıcısı retryAt'i dikkate alır. Speak gibi diğer bitler korunur. Birleşik hata/recovery regresyonu var. |
| P1 — `src/voice.js:103,134,233` | Eski takımın reroute'u hata verdiğinde Global'e tahliye edilip kanal siliniyor, oyuncu dış kanalda kaldığından sonra tekrar alınmıyordu. Eski+yeni kanalların toplamı kategori50 sınırına çarpabiliyordu. | Normal retirement doğru reroute doğrulanana kadar eski kanalı korur; cleanup diğer kanalları bağımsız işler. Kapasite gerektiğinde yalnız yönetilen eski kanallar güvenle tahliye edilir; pending dönüş korunur. Dış kategoriye taşınmış managed voice da yeni kategori slotu tüketir. Manuel kanallar silinmez. |
| P1 — `src/voice.js:45,125` | Her5sn tüm guild kanalları fetch ediliyordu; cache miss silinme gibi yorumlanabiliyordu. | Başlangıçta bir keşif, devamında gateway cache ve gereken ID'ye hedefli fetch. Yalnız Unknown Channel10003 silinmiş sayılır; 403/429 kimliği kaybettirmez. Değişmeyen poll'da full-fetch ve overwrite write olmadığı test edildi. |
| P1 — `src/voicecore.js:2`; `src/mcapi.js:215` | Kısmi link satırları yanlış spectator/global kararı üretebiliyordu. İstek beklerken ikinci instance gelmesi eski tek-instance ön kontrolünü aşabiliyordu. | Snapshot alan/flag/takım üyeliği doğrulaması, hatada fail-closed; outage kanalları silmez. Voice yanıtı tamamlanırken de instance belirsizliği tekrar kontrol edilir. Eski isteğe bağlı UUID/online biçimi sınırlı geriye uyumlulukla korunur. |
| P1 — `plugin-patch/src/com/nautilus/admin/{TeamPolicy,TeamOperations,AdminController,TeamAdminGui,ScheduleBook}.java`; `src/teamadmin.js` | TeamManager To4 desteklediği hâlde yönetim katmanı 1–3 kabul ediyor; bootstrap config'deki4'ü3 olarak kalıcılaştırabiliyordu. | FFA/To2/To3/To4 aynı sınır1–4 kullanır. Doluluk, revision, maç/countdown kilitleri korunur. Mevcut3 tercihleri otomatik4 yapılmaz; roster ve config sıfırlanmaz. Ayrıntı: [Java raporu](readiness-java-findings.md). |
| P1 — `src/readinesspreflight.js:43` | Yeni kontrol mekanizmasının bağımsız incelemesi, started teamadmin ile disabled voice çelişkisine yanlış GO buldu. | teams.active => voice.enabled zorunlu; geçerli countdown active=false/enabled=true kabul edilir. Negatif ve pozitif regresyonlar var. |

Kritik kategori/Global türü, kapasite, kanal oluşturma/izin hataları sessizce geçilmez: sabit güvenli kod ve guild/kanal/işlem/maç korelasyonu loglanır. Upstream hata mesajı, token, secret veya API request gövdesi loga kopyalanmaz. Discord **Administrator**, kanal overwrite deny'larını platform gereği aşar; adminlerin başka takımları dinleyemeyeceği garanti edilmez.

Ek bağımlılık bulgusu: başlangıç npm audit raporunda3 kayıt vardı (2 moderate,1 high), kökü undici6.24.1 idi. Manifest aralığı genişletilmeden lockfile Discord.js14.27.0 / REST2.6.3 / undici6.28.1'e güncellendi; son npm ci/audit0 bulgu. Bu uygulamada her advisory'nin sömürülebilir olduğu iddia edilmedi. Upstream doğrulama: [undici WebSocket DoS duyurusu](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5).

## B. Test sonuçları

**Son tam Node paketi:420 geçti,0 başarısız,0 atlanan.** Sonuçlar aşağıdaki doğrulama kaydında tutulur. Mock Discord testleri gerçek REST/VoiceState taşıma testi sayılmaz.

- Başlangıç: npm ci ve check geçti; **352 Node geçti,0 başarısız,7 Java IT atlandı**. Sandbox'taki ilk socket kısıtlaması kod hatası diye değerlendirilmedi; izinli loopback ortamında tekrar edildi.
- Orijinal JAR + değişmemiş testler: **17/17 Java test sınıfı geçti**.
- Yeni JAR: **21/21 Java test sınıfı geçti**,0 başarısız/atlanan. Her sınıf birden çok senaryo/assertion içerir.
- Node↔gerçek JAR/SQLite/HMAC/HTTP: **7/7 entegrasyon testi geçti**; son tam npm test'te ortam değişkenleri sağlanarak bu7 test de çalıştırılır.
- Voice/guard son odaklı paket: **48/48 geçti**. Kullanıcı bazlı403/429, gerçek konum teyidi, izin sapması, cache miss/deletion,20 eşzamanlı giriş, maç bitişinde bekleyen REST, restart, iki hesap, test takeover, unlink/guard/role-error/outage bileşimi kapsanır.
- Preflight: **26/26 geçti**; salt okunur SQLite probe, eksik dosya oluşturmama, gizli alanı çıktıya yansıtmama, stale evidence, kapasite reuse, Leaf uyumluluk kanıtı, To4/To5 sınırı ve countdown çelişkisi kapsanır.
- Son npm check, npm audit ve diff whitespace kontrolü geçti. Final sayılar: [doğrulama kaydı](readiness-verification.json).

**Çalıştırılmayanlar:** Yeni JAR'ın gerçek Paper/Leaf üzerinde tam UHC maçı; gerçek Discord rol/kanal oluşturma/oyuncu taşıma testi; gerçek oyuncularla ölüm/diriltme/PvP/DM/border geçişleri. Canlıya deployment ve canlı oyuncu/kanal mutasyonu açıkça yasaklandığı için bunlar yapılmadı. Salt okunur GET/konsol gözlemleri entegrasyon provası yerine geçmez.

Java lifecycle ayrımı: IDLE→plan→COUNTDOWN→RUNNING→death/revive/team-change/disconnect→end için gerçek FeatureBridge üretici fixture'ı, StartCoordinator için kabul/preflight reddi/engine reddi/write-before/write-after kalıcılık senaryoları çalıştı. Scatter, final heal, PvP, border, deathmatch, late join, quit/rejoin, winner ve maç sonu save engine akışları JAR'dan statik incelendi; yeni runtime kusuru kanıtlanmadığı için motor yeniden tasarlanmadı. Bunlar uçtan uca çalıştırılmış diye raporlanmadı. [Lifecycle kapsam tablosu](readiness-java-findings.md), [20 ses senaryosu](readiness-bridge-findings.md).

## C. Minecraft–Discord uyumluluğu ve artefakt

- Girdi: `dist/NautilusUHC-1.2.9-message-studio.jar`; SHA-256 `5d8e73870d18110048678cc79c6b11e53a868bb810599589c748d9167fae7bf3` **eşleşti**. Canlı MC'deki dosya da aynı hash'i verdi.
- Çıktı: `dist/NautilusUHC-1.2.10-readiness.jar`; SHA-256 `cb85055ec8fdba7f2671959a360e119e9c8a251bb29f6b0c1d1c4f54173bf773`.
- 652 ZIP girdisinin646'sı içerik olarak birebir aynı; yalnız plugin.yml ve5 takım yönetimi sınıfı değişti. Eklenen/silinen girdi yok, config.yml birebir aynı. Değişen sınıfların JAR içinde olduğu, CRC, metadata1.2.10 ve runtime method/field descriptor delta0 doğrulandı. Derleme Java21 ve gerçek Leaf/Paper API ile; stub sınıflar JAR'a eklenmedi.
- `/api/voice`: enabled = isStarted veya yaklaşan plan; active = isRunning; matchKey yalnız running iken instance:epoch; teams gerçek mevcut kadro, links online/participant/alive/team durumudur. İki MC UUID'sinin aynı Discord ID'sine bağlı olması normaldir.
- `/api/voice` ve `/api/teamadmin` bu JAR'da **outbound FeatureBridge** yolundadır; doğrudan eski BridgeHttpServer bu yolları sunmaz. Canlı bridge.mode=outbound gözlendi. Yeni API uydurulmadı.
- Köprü kesilmesi veya geçersiz snapshot son doğru üyeliğe dayanarak yeni yönlendirme/kanal silme üretmez. Aynı kimlikle sırayla bağlanan iki gerçek süreç ve yapısal olarak geçerli fakat mantıksal olarak eksik boş listeler, mevcut protokolde mutlak ayırt edilemez; deployment envanteri ve roster doğrulaması gerekir.

17 Ekim Türkiye saati10:44–10:47 salt okunur gözlemleri: Java21.0.12.1; Leaf1.21.11 API1.21.11; bot ready=true; Members intent Portal yetkisi açık, kaynakta GuildMembers/GuildVoiceStates tanımlı; botun en yüksek rol konumu15, bağlı rol1; doğru kategori/Global tip ve ID'leri; kategori2 çocuk kanal; bot Administrator ayrıcalığı; SQLite quick_check=ok; shared-secret karşılaştırması yalnız boolean olarak eşleşti. LibertyBans eklenti listesinde görüldü, bağımsız enabled kanıtı tamamlanmadı.5 datapack etkin göründü; seçilecek maç dünyasının hazır/required pack sözleşmesi doğrulanmadı. [Tarihsel kısmi kanıt](readiness-live-observation.json) secret içermez ve güncel kontrol yerine kullanılmamalıdır;5dk yaş sınırı dolunca araç UNVERIFIED verir.

## D. Canlı maç öncesi yetkili kontrolü

1. Düzeltmelerin dağıtıldığı commit/JAR hash'ini, Java21, Paper uyumlu1.21.11 ve LibertyBans etkinliğini doğrula.
2. Tek outbound Minecraft instance, kalıcı instance kimliği ve eşleşen shared secret; `/sağlık` ve canlı bridge stats'ta belirsizlik olmamasını kontrol et.
3. `/teamadmin` ve Discord takım panelinde FFA/To2/To3/To4, roster tekilliği/doluluk ve revision tutarlılığını kontrol et. Eski3 tercihini gerekiyorsa maç yokken açıkça4 seç.
4. Seçilen dünyanın hazırlığı ve **o dünyanın** zorunlu datapack'lerini doğrula; bu kontrol üretim/dünya yükleme işlemi tetiklemesin.
5. Bot rol hiyerarşisi, intent'ler, kategori/Global izinleri, mevcut/yeni geçici kanallar için50 sınırını doğrula. Bağlı olmayan normal hesap entry'ye, normal oyuncu başka takım sesine manuel girememeli.
6. Küçük kontrollü provada entry→takım/Solo, death→İzleyici, revive→takım, team-change, MC disconnect→Global, iki bağlı hesabın online seçimi, bot restart ve bridge outage/recovery akışlarını gözlemle. `/testses` ancak maç yokken; gerçek maç başlayınca testin vazgeçtiğini doğrula.
7. Maç bittiğinde yalnız registry'deki geçici kanallar temizlenmeli.0 başarısız zorunlu kontrol ve eksiksiz güncel kanıt olmadan büyük maça geçme.

Salt okunur rapor:

```bash
npm run preflight -- docs/readiness-evidence.example.json
node scripts/readiness-preflight.js /secure/current-evidence.json --db /secure/existing-bot.db
```

Boş şablon bilerek **17 UNVERIFIED / NO-GO** üretir. Script ağ/maç/dünya/oyuncu mutasyonu yapmaz; mevcut DB yalnız readonly açılır. Eksik kontrol PASS sayılmaz. [Kanıt şeması ve kaynakları](readiness-preflight-findings.md).

## E. Deployment ve rollback

**Bu görevde deployment, restart, gerçek rol/kanal değişikliği, maç başlatma/durdurma veya production DB migration/reset yapılmadı.** GitHub'a yalnız review dalı/draft PR gönderilir; production main birleştirilmez.

Dağıtım öncesi yetkili: aktif maçın bitmesini bekle; Dokploy bot image/commit ve environment referanslarını, bot SQLite+WAL tutarlı yedeğini, eski plugin JAR'ını ve NautilusUHC plugin data/config/DB/pending-link/bridge-instance dosyalarını yedekle. Sırları issue/PR/rapora koyma. Registry/guard kayıtlarını içeren bot DB yedeği kanal sahipliğini geri kazanmak için gereklidir.

Bot dalını ve ayrı1.2.10 JAR'ını planlı bakımda birlikte doğrula; plugins altında yalnız tek NautilusUHC JAR'ı kalsın. Yeni JAR'ı kopyalamadan hash doğrula. İlk gerçek maçtan önce D listesini tamamla.

Rollback: aktif maçta otomatik geri dönüş yapma. Bakımda önceki bot image/commit ve1.2.9 JAR'ına dön; plugin/veritabanları bu yama nedeniyle sıfırlanmaz veya körlemesine eski yedekle ezilmez. Yeni kalıcı anahtarlar registry.revoked/pendingRoutes eklemelidir; eski bot bunları dikkate almaz. Eski sürüme dönüş eski bilinen ses kusurlarını geri getirir; büyük maç için tekrar GO sayılmaz. Kanal ID'lerini manuel silme/yeniden adla keşfetme yerine doğru registry yedeğini kullan. Bu değişiklikte yeni DB tablo/sütun migration'ı yoktur.

## F. Kararın gerekçesi

**Mevcut canlı1.2.9: NO-GO.** Kanıtlanmış ses/To4 kusurları canlıda hâlâ mevcut; hazırlanan düzeltme otomatik yayımlanmadı. Test paketi güçlü yerel/harness kanıtı sağlar, gerçek Discord taşıması ve tam maç motoru provası sağlamaz. Preflight zorunlu dünya/kadro/instance koşulları tamamlanmadı. Bu yüzden koşulsuz GO verilmez; bakımda kurulum ve D listesinin başarılı küçük provası sonrası CONDITIONAL GO değerlendirilebilir.
