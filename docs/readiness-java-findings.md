# Java / UHC / To4 readiness bulguları — 17.10.2026

Denetim tabanı: `d01ead02fde07af466a271e5e3828febdbf4a13c`. Bu çalışma üretim sunucusuna bağlanmadı; canlı maç, Discord kanalı, oyuncu, dünya veya kalıcı üretim verisi değiştirmedi. Bulgular verilen JAR'ın yeni decompilation çıktısından, patch kaynaklarından ve izole testlerden elde edildi. `/tmp/nautilus-decompiled` eski çıktısı kanıt olarak kullanılmadı.

## A. Kanıtlanmış hatalar ve çözüm

### P1 — To4 motor desteğine rağmen yönetim katmanı To3'e düşürüyordu

- `plugin-patch/src/com/nautilus/admin/TeamPolicy.java:4,7`: eski `limit(4)` sonucu `3`; eski `canJoin(...,4,...)` daima `false`.
- `plugin-patch/src/com/nautilus/admin/AdminBootstrap.java:55`: açılışta mevcut limit policy ile yeniden kaydediliyor. Böylece JAR `config.yml` içindeki varsayılan `uhc.teamSize: 4`, henüz takım oluşturulmamış temiz açılışta bile `3` oluyordu. Önceden kaydedilmiş To4 takımların üyeleri silinmiyordu; limitleri yanlış küçültülüp yönetim işlemleri tutarsızlaşıyordu.
- `plugin-patch/src/com/nautilus/admin/TeamOperations.java:54,60,67,74`: taşıma, oluşturma, boyut ve rastgele dağıtım To4'ü reddediyordu.
- `plugin-patch/src/com/nautilus/admin/TeamAdminGui.java:100`: yalnız üç boyut sunuluyordu. `AdminController.java:317,319,723`: plan düzenleyici ve yardım metni de To3'e sınırlıydı.
- `plugin-patch/src/com/nautilus/admin/ScheduleBook.java:84,223`: yeni To4 planı reddediliyor, kaydedilmiş To4 planı okunurken To3'e indiriliyordu. `MatchAnnouncementContext` ortak policy nedeniyle duyurudaki To4 değerini de küçültüyordu.
- `src/teamadmin.js:48`: Discord modalı gerçekte kabul edilmeyen `1–100` aralığını gösteriyordu; yerel aralık kontrolü bulunmuyordu.

Motor kanıtı: gerçek 1.2.9 JAR `com/nautilus/team/TeamManager.class` içindeki `load()` varsayılanı `uhc.teamSize=4`; `setLimit(int)`, `isFull(int)`, `createTeam(List<UUID>)`, `getMembers(int)` To3 kısıtı taşımıyor. `UhcMatchManager.buildGroups()` scatter gruplarını takım kimliği üzerinden kuruyor; `aliveGroups()`/`checkWin()` kazananı takım kimliği veya solo UUID üzerinden belirliyor. Bu akışlarda dört kişiyi engelleyen bir sınır bulunmadı. To4 yönetimini desteklemek mevcut motorla uyumludur.

Çözüm: ortak yönetim policy üst sınırı 4 oldu; TeamOperations, iki Minecraft GUI'si ve takvim doğrulaması aynı aralığı kabul ediyor. Discord modalı `1–4` gösteriyor ve 0/5/100 değerlerini köprü yazmasına göndermeden reddediyor. Ana iş parçacığı, oyuncu varlığı, revision, dolu takım, yeni boyuttan büyük takım ve aktif maç/hazırlık kilitleri korundu. Mevcut takım üyelerini dönüştüren bir migration eklenmedi.

**İşletim notu:** Eski sürüm daha önce `3` kaydetmişse yeni JAR bunu kendiliğinden `4` yapmaz. Yetkili maç yokken panelden To4 seçmelidir. Bu tercih eski kayıtları otomatik değiştirmemek içindir. Mevcut >4 eski takvim değerlerini sınırlama politikası kaldırılmadı; desteklenen en büyük değer artık To4. Böyle eski planlar varsa yetkili kontrol etmelidir.

Regresyon kanıtı: `TeamSizeReadinessTest` eski JAR'da `bootstrap must preserve configured To4 capacity` hatasıyla, `TeamOperationsReadinessTest` eski JAR'da `To4 size mutation rejected` hatasıyla kırıldı; yeni JAR'da geçiyor. Discord testinde eski modal aralığı ve sınır dışı köprü yazması ayrı ayrı kırıldı; düzeltmeden sonra 7/7 geçti. Eski To4 reddetme testi To5 sınır kontrolüne taşındı; yeni testler To4 kabulünü, doluluğu ve kayıt korunmasını ayrıca doğruluyor.

### P1 — Yeni JAR üretiminde sürüm metadata'sı yanlış kalıyordu

`plugin-patch/build.py:4,20` daha önce her çıktının `plugin.yml` sürümünü sabit `1.2.9` yazıyordu. Ayrı readiness dosyası üretildiğinde eski metadata gerçekten gözlendi ve `version: 1.2.10` kontrolü kırıldı. Derleyiciye `--version` eklendi; varsayılan `1.2.10`. Yeni çıktı açıkça `--version 1.2.10` ile üretildi ve metadata doğrulandı.

## B. Test sonuçları ve sınırlar

| Kontrol | Sonuç | Kapsam / sınır |
|---|---|---|
| Denetlenen commit'in değişmemiş Java testleri, orijinal JAR | **17/17 test sınıfı geçti** | Test kaynakları commit'ten `/tmp` altına çıkarılarak çalıştırıldı. |
| Son kaynakların Java testleri, readiness JAR | **21/21 test sınıfı geçti; 0 başarısız, 0 atlanan** | 17 mevcut + 4 yeni sınıf. Sınıflar kendi içlerinde birden çok senaryo/assertion içeriyor. |
| Discord teamadmin mock testleri | **7/7 geçti** | Panel yetkisi, stale revision, mevcut işlemler, To4 ve sınır dışı boyut. |
| Node ↔ gerçek JAR LinkService/LinkBridgeApi + SQLite + HTTP/HMAC | **7/7 geçti; 0 atlanan** | İki hesap, üçüncü hesap reddi, instance/kod çakışmaları, scoped routing, kayıp yanıt uzlaştırması, eski unlink paneli. |
| Yeni JAR ZIP CRC, metadata ve üyelik | **Geçti** | 652 giriş; 646 içeriği birebir aynı; altı giriş değişti; eklenen/silinen giriş yok. |
| Değişen beş sınıfta `javap` runtime üye referans karşılaştırması | **Geçti** | Yeni method/field/interface referansı veya descriptor eklenmedi. |
| Gerçek Paper 1.21.11 + LibertyBans sunucusunda tam maç | **Çalıştırılmadı** | Yeni JAR canlı sunucuya yüklenmedi; görevde tam maç başlatılmadı. Salt okunur canlı gözlemler ana raporda ayrıca belirtilir. |
| Gerçek Discord guild/rol/ses taşıması | **Çalıştırılmadı** | Canlı Discord işlemleri yapılmadı. |

Başlangıçta `/tmp/nautilus-api` sınıf yolunda SLF4J ve Log4j API eksikti; ilk Java çalıştırmasında 8 sınıf ortam nedeniyle çalışamadı. Gerçek SLF4J API mevcut yerel test bağımlılığından, Log4j API 2.25.3 resmi Maven Central artifact'ından `/tmp` altına eklendi. Sandbox localhost socket açmayı da engelliyordu; yalnız test işlemleri için sandbox dışı çalıştırma kullanıldı. Bu sorunlardan sonra **orijinal 17 sınıfın tamamı** ve **son 21 sınıfın tamamı** geçti. İlk ortam hataları uygulama regresyonu olarak sunulmuyor; son başarılı çalışma ayrıca doğrulandı.

Uyarılar: test-only harness Paper sınıflarını dünyayı başlatmadan hazırlamak için `sun.misc.Unsafe` kullanır ve javac dört uyarı verir. SLF4J provider eklenmediği için testte NOP logger uyarısı görülür. `LinkTwoAccountsTest` beklenen SQLite trigger ihlallerini bilerek üretip doğrular; logdaki bu iki exception son test başarısızlığı değildir. Üretim koduna test amaçlı yardımcı eklenmedi.

Yeni testlerin ayrımı:

- `TeamSizeReadinessTest`: FFA/To2/To3/To4 policy davranışı, dolu takım ve aynı takım idempotence, To5 reddi, To4 planının restart sonrası korunması, duyuru bağlamı.
- `TeamOperationsReadinessTest`: gerçek JAR TeamManager/TeamOperations; To4 oluşturma ve dört üyeye doldurma, beşinci üyenin reddi, To3'e küçültmede kayıt/limit korunması, diskten yeniden okuma, RUNNING/COUNTDOWN toplu işlem kilidi, stale revision ve açık idle FFA işlemi.
- `FeatureBridgeReadinessTest`: gerçek JAR API producer ve geçici gerçek SQLite link deposu; phase alanı fixture tarafından atanır. IDLE/planned/COUNTDOWN/RUNNING/end sözleşmesi; gerçek `markDead`→`markAlive` ve sıradaki `checkWin` ile aynı tick diriltme; takım ve bağlantı değişimleri; tek Discord'a bağlı iki Minecraft UUID. Bu bir Paper maç başlatma entegrasyon testi değildir.
- `StartCoordinatorReadinessTest`: gerçek coordinator ve gerçek takvim dosyasıyla beş durum: kabul, dünya önkontrol reddi, motor reddinde ayar geri yükleme, STARTING yazma hatasında başlamama, kabulden sonraki kayıt hatasında çalışan maçı koruyup otomatik planlamayı durdurma. Dünya/oyun motoru Port sınırı fixture'dır.

Doğrulanan komutlar:

```bash
python3 plugin-patch/build.py dist/NautilusUHC-1.2.9-message-studio.jar \
  dist/NautilusUHC-1.2.10-readiness.jar \
  --java-bin /tmp/java-21-openjdk-amd64/bin --api-dir /tmp/nautilus-api --version 1.2.10
python3 plugin-patch/test.py dist/NautilusUHC-1.2.10-readiness.jar \
  --java-bin /tmp/java-21-openjdk-amd64/bin --api-dir /tmp/nautilus-api
PATH=/tmp/node-v22.16.0-linux-x64/bin:$PATH node --test test/teamadmin.test.js
```

Node–Java entegrasyonunda `plugin-patch/test/support/*.java` gerçek JAR ve bağımlılıklarıyla derlendi; `NAUTILUS_LINK_IT_JAVA` ve `NAUTILUS_LINK_IT_CLASSPATH` verilip `node --test test/linkintegration.test.js` çalıştırıldı. Geçici loglar: `/tmp/nautilus-readiness-java-original-baseline.log`, `/tmp/nautilus-readiness-java-final.log`, `/tmp/nautilus-readiness-java-node-integration.log`. Kalıcı sonuç kanıtı bu rapor ve yeniden çalıştırılabilir testlerdir; `/tmp` dosyaları dağıtım gereksinimi değildir.

## C. Minecraft–Discord API sözleşmesi ve JAR

`FeatureBridge.java:12–27`: GET `/api/voice`, GET/POST `/api/teamadmin`; ana Bukkit iş parçacığında snapshot/işlem, en fazla altı saniye bekleme. POST bozuk JSON nesnesinde 400; iş kuralı reddinde 409; timeout/hata BridgePoller tarafından 502 olarak aktarılır.

`FeatureBridge.java:34–54` producer sözleşmesi:

| Alan | Üretici davranışı |
|---|---|
| `enabled` | `match.isStarted() || !schedule.upcoming().isEmpty()`: plan veya COUNTDOWN/RUNNING varsa true. |
| `active` | Yalnız `match.isRunning()`: COUNTDOWN ve warmup sırasında false. |
| `matchKey` | RUNNING iken kalıcı `BridgeInstance.id(plugin) + ":" + matchEpoch`; diğer durumlarda boş string. |
| `teams` | Gerçek TeamOperations/TeamManager snapshot'ındaki takım numarası ve üyeler. |
| `links[].online` | Minecraft UUID'si için `Bukkit.getPlayer(uuid) != null`. |
| `links[].participant` | Yalnız active ve gerçek participant setinde ise true. |
| `links[].alive` | Gerçek alive seti; tüketici active/participant kapılarıyla birlikte değerlendirmeli. |
| `links[].team` | Mevcut TeamManager ataması varsa sayı; solo için alan yok. |
| İki Minecraft hesabı | Aynı Discord ID'li iki ayrı UUID satırı normaldir; tüketici online/participant hesabı seçer. |

Kod yorumu COUNTDOWN ile RUNNING anahtarını aynıymış gibi açıklasa da gerçek producer COUNTDOWN'da boş anahtar verir. Tüketici gerçek alan davranışını izlemeli; başlangıç yönlendirmesi RUNNING geçişinde olur. Herhangi bir production FeatureBridge değişikliği yapılmadı.

`BridgePoller.java` gerçek sözleşmesi: outbound uzun yoklama 25 saniye, HTTP timeout 40 saniye; üç işçi; hata sonrası 1/2/5/10/30 saniye backoff; bağlantı dönünce kendiliğinden toparlanma. İstek ve sonuçlarda HMAC timestamp/nonce/signature, `X-Bridge-Instance`, link protocol sürümü gönderilir. `targetInstance` farklıysa yerel işlem yapılmadan 421 `wrong_instance`; feature yolları local HTTP'ye uğramadan FeatureBridge üzerinden yürür. Diğer yollar bearer ile localhost köprüye aktarılır. Node–Java mevcut entegrasyon harness'ı bu protokol ve gerçek LinkBridgeApi sınıflarını kullanır; BridgePoller thread'ini çalıştırmaz. Gerçek outbound TLS, çoklu gerçek Minecraft instance ve Paper scheduler gecikmesi ayrıca doğrulanmalıdır.

Önemli kapsam sınırı: yeni feature uçları bu JAR'da BridgePoller outbound dispatcher'ında bulunuyor. Yerel `BridgeHttpServer` dispatcher'ında `/api/voice` ve `/api/teamadmin` yok; eski direct HTTP fallback bu iki yeni uç için desteklenmiş sayılmamalı. Ses sistemi için `bridge.mode: outbound` ve güncel bot beklenir.

Artifact'lar:

- **Orijinal:** `dist/NautilusUHC-1.2.9-message-studio.jar`; SHA-256 `5d8e73870d18110048678cc79c6b11e53a868bb810599589c748d9167fae7bf3` — beklenenle aynı, değiştirilmedi.
- **Yeni:** `dist/NautilusUHC-1.2.10-readiness.jar`; SHA-256 `cb85055ec8fdba7f2671959a360e119e9c8a251bb29f6b0c1d1c4f54173bf773`.
- `plugin.yml`: version `1.2.10`, api-version `'1.21.11'`, zorunlu `depend: [LibertyBans]` korundu. `config.yml` orijinalle birebir aynı.
- Derleme `javac --release 21`; çalışma JDK `21.0.12.1`. Stub paketlenmedi. `/tmp/nautilus-api/leaf-api.jar` ve gerçek Adventure/Gson/Guava/SnakeYAML API kütüphaneleri kullanıldı. Leaf, Paper API uyumlu bir fork'tur; bu doğrulama gerçek resmi Paper çalıştırmasının yerini tutmaz.
- Mevcut patch prosedürü 80 sınıfı yeniden üretir. Karşılaştırma sonunda yalnız beş sınıfın byte içeriği farklı: `TeamOperations`, `TeamPolicy`, `AdminController`, `TeamAdminGui`, `ScheduleBook`. Bu beş sınıfın yeni JAR içinde bulunduğu ve Java testlerinin source/stub yerine JAR sınıflarını yüklediği doğrulandı. Diğer 75 yeniden derlenen sınıf da orijinalle byte olarak aynı.

## D. UHC yaşam döngüsü kanıt matrisi

Aşağıdaki manager/sınıf kanıtları denetlenen JAR'ın decompile edilmiş yöntemleridir; temel `UhcMatchManager` sınıfı yeni JAR'da birebir korunmuştur.

| Süreç | Bulunan koruma / akış | Doğrulama düzeyi |
|---|---|---|
| Hemen başlat | `start`, `forceStart`, `validateCanStart`: UHC modu, boot datapack durumu, dünya hazırlığı, IDLE, bekleyen reset ve uygun oyuncu kontrolü. AdminController ayrıca WorldSelection önkontrolü yapar. | Statik; gerçek başlangıç çalıştırılmadı. |
| Planlı başlat | `MatchScheduleService.tick`: geç başlama grace, dünya/senaryo kontrolü; StartCoordinator STARTING'i önce kaydeder, kabulde kapıyı kapatır ve STARTED kaydeder; belirsiz kabulü bozmaz. | Coordinator'ın beş kontrol/persistence durumu geçti; Paper timer/forceStartScheduled çalıştırılmadı. |
| Oyuncu/takım hazırlığı | `eligiblePlayers`: auth, UHC uygunluğu/link, host opt-in; `buildGroups`: takım ID veya solo UUID. | Gerçek To4 yönetim/kayıt ve voice producer testleri; gerçek oyuncu uygunluğu statik. |
| Dünya/datapack | `WorldSelection.preflight/prepareForStart`; `DatapackService.isWorldgenActive`: yalnız ZIP varlığı yeterli değil, boot aktifliği gerekir. | Statik; gerçek hazır dünya ve datapack doğrulanmadı. |
| Scatter/warmup/geri sayım | `onCountdownFinished`, staged spectator/async scatter, `finishPreparedStart`, post-scatter countdown; her geç callback phase/world/epoch kontrolü taşır. RUNNING yalnız activation tamamlandıktan sonra atanır. | Statik; mevcut abandoned countdown context regresyonu geçti; gerçek teleport/chunk işlemi çalıştırılmadı. |
| Final Heal/PvP/border/Deathmatch | `scheduleMatchTasks/rescheduleMatchTasks` RUNNING'de elapsed süreyi okur; heal/pvp/deathmatch tek-sefer bayrakları ve border stage seti; preload callback'leri epoch/world/phase kontrolü taşır. | Statik; gerçek timer, heal, PvP hasarı, border ve arena inşası çalıştırılmadı. |
| Ölüm/diriltme | `UhcDeathListener`→`markDead`: alive setinden çıkartır, participant kalır, checkWin sonraki tick; `markAlive`/`reviveIntoMatch` alive/participant geri ekler. | Gerçek markDead→markAlive ve sıradaki checkWin ile voice sözleşmesi geçti; envanter/respawn/revive dünya akışı çalıştırılmadı. |
| Çıkış/yeniden giriş | `handleQuit`: deathmatch link eliminasyonu veya logout body; body yoksa markDead. `handleJoinDuringMatch`: yaşayan participant body restore+survival, diğerleri spectator. AdmissionRouter bağlantı ve epoch kontrol eder. | online flag geçiş testi; body restore/survival gerçek Paper'da çalıştırılmadı. |
| Geç katılım | `lateScatter`: active, mevcut participant olmama, linked/event-world, host opt-in, deadline, pending transfer; callback epoch kontrolünden sonra participant+alive ekler. | Statik; gerçek late scatter çalıştırılmadı. |
| İptal | `cancelCountdown` hazırlık/countdown/warmup görevlerini durdurur, epoch artırır, IDLE olur. `finish(...,false)` dereceli tamamlamadan iptal bildirir. | Statik; voice IDLE fixture ve coordinator reddi test edildi. |
| Kazanan | `aliveGroups` takım ID/solo UUID; `checkWin` tek veya sıfır grup kalınca finish. | Aynı tick death→revive sonrası iki grubun kaldığı gerçek checkWin testi; gerçek kazanan finish çalıştırılmadı. |
| Bitiş/kayıt | `finish` integration.completeMatch çağrısından sonra IDLE+epoch değişimi, görev cleanup; `NautilusIntegration.completeMatch` oynayanlar/winner/Elo/history snapshot'ı kurar, async kayıttan sonra duyuru gönderir. Normal bitişte mevcut clearCompletedUhcData davranışı vardır. | SQLite link/persistence ve gecikmiş duyuru bağlamı testleri geçti; gerçek match history/Elo tam maç kaydı çalıştırılmadı. |

Bu düzeltme çalışan maçın state, envanter, koordinat veya takım kayıtlarını sıfırlayan yeni bir yol eklemez. Normal bitişteki mevcut takım/veri temizliği yeniden tasarlanmadı. Snapshot producer testindeki phase fixture'ları gerçek tam maç transitions testi olarak değerlendirilmemelidir.

## E. Canlı önkontrol ve deployment/rollback girdileri

Yetkili, bakım penceresinde ve maç yokken şu kanıtları toplamalı:

1. Gerçek sunucu Java 21, Paper 1.21.11 ve çalışan LibertyBans; plugin version/hash doğru; duplicate eski Nautilus JAR yok.
2. Salt-okunur `/api/teamadmin` snapshot'ında beklenen FFA/To2/To3/To4, benzersiz UUID/takım, kapasite ve online/link eşleşmeleri. Legacy `teams.yml` tek yetkili kaynak değildir: YamlStore aktifken takım verisi ana DB'deki `yml:teams` ayarında olabilir.
3. `/uhcadmin` kontrol ekranında dünya hazır, boot datapack aktif, host katılımı doğru; yalnız kontrol ekranını açmak maç başlatmak değildir. Aktif datapack ve hazır pool, ZIP dosyasının varlığıyla varsayılmamalı.
4. Outbound köprü taze ve tek doğru instance; secret her iki tarafta eşleşiyor ve yeterli uzunlukta; startup logunda bağlantı geri geldi/hata durumu okunmalı. Secret değeri rapora/loga yazılmamalı.
5. Gerçek Discord guild'de yetkili gözetiminde bağlantı, intent'ler, rol hiyerarşisi ve kanal izinleri doğrulanmalı; Administrator bypass normal platform davranışıdır. Gerçek maç öncesi kontrollü oyuncu testi gerekir.
6. Aktif maça hot reload veya JAR değiştirme uygulanmamalı. Bu çalışma deployment yapmadı.

Değişen üretim girdileri beş Java patch kaynağı, Python build sürüm seçimi ve Discord `src/teamadmin.js`; ayrıca test runner/testler ve yeni ayrı JAR. Yeni feature API veya DB schema migration eklenmedi. Yedekler: eski JAR, bot sürümü/lockfile, plugin config, bot SQLite ve Minecraft ana DB tutarlı SQLite backup; bridge-instance-id; takvim/host preferences ve varsa legacy YAML'ler. Çalışan SQLite dosyasını WAL durumunu gözetmeden kopyalamak güvenilir backup değildir.

Geri dönüş: maç dışındaki bakım penceresinde önceki bot sürümü ve hash'i doğrulanmış eski JAR seçilir; config/secret/instance kimliği korunur. Bu yama için DB reset/restore gerekmez. To4 ile yeni plan/kayıt oluşmuşsa eski To3 admin cap'i yeniden ortaya çıkacağından downgrade öncesi kayıtların yetkili tarafından incelenmesi gerekir; otomatik takım küçültme/temizleme uygulanmamalı. Üretim verisini eski bir yedekle otomatik ezmek rollback adımı değildir.

## F. Java tarafı karar girdisi

**CONDITIONAL GO:** Kanıtlanan To4 ve artifact sürüm hataları giderildi; orijinal 17/17, son Java 21/21, Discord teamadmin 7/7 ve gerçek JAR/SQLite/HMAC köprü entegrasyonu 7/7 geçti. Byte korunumu doğrulandı. Koşullar: gerçek Paper 1.21.11 + LibertyBans + aktif datapack/hazır dünya kontrolü, canlı Discord izin/intent/hiyerarşi doğrulaması ve yetkili gözetimindeki başlangıç/ölüm/diriltme/scatter/phase/end provası. Bu kontroller yapılmadan tüm maç yaşam döngüsü veya gerçek Discord yönlendirmesi için koşulsuz GO/garanti çıkarılamaz. Nihai tüm-sistem kararı diğer voice güvenilirlik bulgularıyla birlikte verilmelidir.
