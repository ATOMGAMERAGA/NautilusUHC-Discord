# Salt okunur production preflight

`src/readinesspreflight.js` ve `scripts/readiness-preflight.js` canlı maç öncesi 17 kontrol için uygulanabilir rapor üretir. Ağ bağlantısı kurmaz, botu başlatmaz, Minecraft komutu göndermez, maç/dünya/oyuncu/kanal veya kalıcı takım verisi değiştirmez. JSON kanıt zarfını değerlendirir; istenirse mevcut SQLite dosyasında salt okunur sorgu çalıştırır. Yeni bağımlılık yoktur.

```bash
# Şablon bilerek gerçek kanıt içermez: 17 UNVERIFIED, çıkış kodu 1.
npm run preflight -- docs/readiness-evidence.example.json

# Yetkilinin topladığı güncel kanıtı değerlendirir.
node scripts/readiness-preflight.js /secure/path/evidence.json

# Yalnız mevcut veritabanını readonly açar; oluşturma/migration yapmaz.
node scripts/readiness-preflight.js /secure/path/evidence.json --db /secure/path/bot.db
```

JSON stdout'a, yalnız sabit ve secretsiz kullanım/okuma hataları stderr'e yazılır. Çıkış kodları: **0** tüm kontroller PASS; **1** en az bir FAIL/UNVERIFIED; **2** yanlış kullanım veya okunamayan/geçersiz JSON. `ready=false` ve `decision=NO-GO`, eksik kanıtla maç başlatma kararı verilmesini önler. Araç herhangi bir başlatma akışına otomatik bağlanmamıştır.

`observedAt` tüm zarfın toplandığı ISO-8601 UTC zamandır. Her alan aynı güncel gözlem grubundan gelmelidir; eski kanıtı yeni zamanla etiketlemeyin. Eksik/geçersiz zaman, 5 dakikadan eski kanıt veya 30 saniyeden fazla gelecek zaman tüm kontrolleri UNVERIFIED yapar. Saf API testlerde `evaluateReadiness(evidence, {now,maxAgeMs})` kabul eder. Eksik/null/bozuk alanlar PASS sayılmaz. PASS yalnız sağlanan kanıtın içerik/tutarlılık kontrolüdür; canlı bağlantının araç tarafından sınandığı anlamına gelmez.

## Kanıt nasıl toplanmalı?

`docs/readiness-evidence.example.json` bir **teşhis zarfı şablonudur**, yeni bir bridge endpoint değildir. `null` alanları yalnız yetkilinin doğruladığı güncel değerlerle doldurun; doğrulanamayanları null bırakın. Şablona üretim token/secret/hash, `.env` veya tam config dump eklemeyin. Araç giriş değerlerini rapora geri basmaz; yine de giriş dosyası guild ve oyuncu kimlikleri içerebilir, güvenli yerde saklanmalıdır.

| Alan / kontrol | Güvenli kanıt kaynağı ve kabul koşulu |
| --- | --- |
| `runtime.javaVersion` | Paper sürecini çalıştıran JVM'nin `java -version` sürümü, ör. `21.0.8`. Bot makinesindeki farklı JVM kanıt değildir. Java 21 gerekir. |
| `runtime.serverSoftware`, `minecraftVersion`, `paperCompatible` | Çalışan sunucunun `/version` çıktısından yazılım adı ve `1.21.11`. `Paper` doğrudan kabul edilir; Leaf gibi forklar için ayrıca bu dağıtımın Paper API uyumluluğunu doğrulayan `paperCompatible:true` kanıtı gerekir. Fork uyumluluğu bilinmiyorsa UNVERIFIED, açıkça false ise FAIL. Yalnız yazılım adı uyumluluk kanıtı değildir. Derleme API sürümü çalışma sürümünü kanıtlamaz. |
| `runtime.plugins` | Canlı eklenti listesi; ör. `[{"name":"LibertyBans","enabled":true}]`. Eksiksiz listede yoksa FAIL; liste bilinmiyorsa null. |
| `discord.ready`, `guildId`, `configuredGuildId` | Canlı bot `client.isReady()`, erişilen guild ve `config.guildId`; ikisi aynı string snowflake olmalı. |
| `discord.intents`, `portalMembersIntentEnabled` | Client intent adları listesi `GuildMembers`, `GuildVoiceStates` içermeli. Developer Portal Server Members Intent yetkisi ayrıca boolean olarak kanıtlanmalı; kaynakta intent tanımlanması Portal onayını kanıtlamaz. |
| `discord.guildPermissions` | Canlı guild bot üyesinin etkin izin adları: `ManageChannels`, `ManageRoles`, `MoveMembers`, `Connect`; veya `Administrator`. |
| `discord.category.permissions`, `global.permissions`, `managedChannels[].permissions` | Canlı `channel.permissionsFor(botMember)` sonucu izin adları dizisi. Guild izni tek başına kanal overwrite engelini dışlamaz. Her kanalda `ManageChannels`, `MoveMembers`, `Connect` aranır. Yönetilen kanallar yoksa doğrulanmış boş liste `[]`; bilinmiyorsa null. |
| `botHighestRolePosition`, `linkedRole` | Bot en yüksek rolünün `position` değeri, mevcut Minecraft bağlantı rolünün `position` ve `managed` alanı. Bot rolü kesin olarak üstte olmalı, hedef rol managed olmamalı. Administrator rol hiyerarşisini aşmaz. |
| `discord.categoryId`, `globalId`, `category`, `global` | `src/voice.js` içindeki gerçek `VOICE_CATEGORY`, `GLOBAL_VOICE` değerleri ile canlı kanal `id`, `guildId`, `type` karşılaştırılır. GuildCategory=4; GuildVoice=2. Bu kimlikler ortam değişkeni değildir. |
| `category.childCount`, `managedChannels[]` | Kategoride botun sahip olmadığı kanallar dahil tüm mevcut çocuk sayısı. Her yönetilen canlı kanal için registry `key`, gerçek `id`, `parentId` (null olabilir), `type:2`, `permissions` kanıtı gerekir. Desired anahtarlar `entry`, `solo`, `spectator`, `team:N`; zaten kategoride bulunan desired ID yeniden sayılmaz. Yalnız eksik desired kanallar yeni yer tüketir. Retired sahipli kanal ancak `releasable:true` ile güvenli boşaltma/silme kanıtı varsa yer açabilir. Yer yetmiyorsa ve gerekli retired güvenliği bilinmiyorsa UNVERIFIED, kesin yetmiyorsa FAIL. |
| `bridge.stats` | Mevcut **canlı bot sürecinde** `mcapi.bridgeSnapshot()` / `queue.stats()` çıktısı: `connected`, `instances`, `instanceIds`, `ambiguous`, `duplicateInstanceIds`. Ayrı CLI'da yeni queue oluşturmak canlı süreç kanıtı değildir. `/saglik`, `/admin köprü` teşhisleri kanıt toplamaya yardımcı olur. |
| `bridge.expectedInstanceId` | Minecraft `bridge.instance-id` / `BridgeInstance.id` ile doğrulanmış açık kimlik. Tek kimlik eşleşmeli, duplicate listesi boş, ambiguous=false olmalı. Anonim `ip:` kimlikleri kabul edilmez. |
| `bridge.authentication` | `botSecretConfigured`, `pluginSecretConfigured`, `sharedSecretMatches` üç açık boolean. Yetkili BRIDGE_SECRET ile plugin `bridge.token` değerini güvenli oturumda karşılaştırır. Başarılı poll tek başına konfigürasyon eşitliğinin yerine geçmez; değer veya hash rapora konmaz. |
| `database` | `reachable`, `integrity:"ok"`, `requiredTablesPresent`. `--db` bu alanı gerçek readonly SQLite `PRAGMA quick_check` ve `settings`/`processed_events` tablo sorgusuyla değiştirir. Sürücü: mevcut better-sqlite3; kullanılamazsa Node >=22.5 `node:sqlite`. Dosya yoksa oluşturulmaz. SQLite'ın normal okuyucu kilitleri kullanılır; botun yazma yetkisi veya disk kapasitesi bu sorguyla kanıtlanmaz. |
| `teams` | Gerçek GET `/api/teamadmin` gövdesi: `teamSize`, `active`, `teams:[{number,members:[{uuid,team,...}]}]`, `players:[{uuid,team?,...}]`. UUID/numara tekilliği, kapasite, her iki yönde üyelik eşleşmesi kontrol edilir. FFA takım ataması kabul edilmez. Desteklenen admin/TeamPolicy sınırı 1–4; To2/3/4 özel olarak testlidir. To5 ve üzeri tutarsız konfigürasyon FAIL olur. Bu kontrol takım boyutu admin düzeltmesinin yerine geçmez. |
| `voice` | Gerçek GET `/api/voice`: `enabled`, `active`, `matchKey`, `teams`, `links:[{uuid,discordId,online,participant,alive,team?}]`. Takım kadrolarıyla karşılaştırılır; eksik/kısmi gövde geçmez. İki MC hesabının aynı Discord ID'ye bağlı olması yasaklanmaz; MC UUID tekrarı reddedilir. |
| `world` | Yetkilinin mevcut dünya seçimi/hazırlık loglarından `ready`, `selectedWorldExists`; yapılandırmadan zorunlu datapack tam adları `requiredDatapacks`, salt okunur `/datapack list enabled` çıktısından `enabledDatapacks`. Her zorunlu ad etkin listede birebir bulunmalı. Gerçekten zorunlu datapack yoksa bunu doğrulayan boş `[]` kullanılabilir; bilinmeyen liste null kalır. |

Gövde toplamak için mevcut `mcapi.teamAdmin()` ve `mcapi.voiceSnapshot()` GET işlemleri kullanılabilir; komut/POST admin işlemleri kullanılmamalıdır. Araç `src/config.js`, `src/db.js`, `src/mcapi.js`, `src/voice.js` import etmez; dolayısıyla eksik token nedeniyle çıkış, migration veya bot bağlantısı gibi dolaylı yan etkiler oluşturmaz.

## API ve doğrulama sınırları

Mevcut `/api/voice` / `/api/teamadmin` dünya hazırlığını, datapack zorunluluk listesini, çalışan Java/Paper sürümünü, LibertyBans'ın etkinliğini veya Discord Portal yetkisini eksiksiz sunmaz. Bu alanlar için sahte `/api/preflight` endpoint'i varsayılmamıştır; operatör kanıtı olmadan UNVERIFIED kalır. Ayrı alınan voice/teamadmin görüntüleri takım değişimiyle yarışabilir; aynı sakin anda yeniden kanıt alın, bu araç kayıt onarmaz.

`teamadmin.active` maçın başlatılmış olmasını kapsar; `voice.active` gerçek running durumunu ifade eder. Countdown/warmup sırasında `teamadmin.active=true`, `voice.active=false` tek başına hata sayılmaz. Başlatılmış (`teamadmin.active=true`) maçta voice.enabled mutlaka true olmalıdır; running voice durumunda started/enabled/matchKey aranır; idle voice için boş matchKey gerekir. Gerçek oyuncu ses taşıması veya permission overwrite izolasyonu bu raporla kanıtlanmaz; canlı staging Discord testleri ayrıca gereklidir. Administrator izni platform düzeyinde özel erişim sağlar.

Tek açık instance kimliği ve duplicate yokluğu aynı kimlikle sırayla bağlanan iki süreci kesin dışlamaz. Panel/container deployment envanterinde tek poller/tek üretim sunucusu bulunduğu ayrıca doğrulanmalıdır. Kurulu bağımlılıklardaki `npm ci` audit uyarıları ayrı risk kaydıdır; preflight bunları gidermez veya otomatik `npm audit fix` çalıştırmaz.

## Test kanıtı ve kullanım kararı

RED: eksik modül/stub ile testler başarısız oldu; stub koşusunda 12 gerçek assertion başarısızlığı izlendi. Portal yetkisi/anonim kimlik ve bozuk intent dizisi ayrıca önce başarısız gözlemlendi. GREEN: `node --test test/readinesspreflight.test.js` ile 24 test. CLI testleri mevcut DB içeriğinin byte olarak değişmediğini ve eksik DB'nin oluşturulmadığını sınar. Bu testler yerel, saf/mocked kanıt testleridir; gerçek Discord/Paper/LibertyBans/dünya entegrasyonu değildir.

Canlı ortam kanıtı sağlanmadığından bu geliştirme oturumunda üretim için **NO-GO / UNVERIFIED**. Yetkili güncel kanıtı toplamalı, tüm 17 kontrol PASS olmalı ve canlı staging ses/lifecycle denemeleri ayrı tamamlanmalıdır. Araç kendi GO raporunu dağıtım veya otomatik maç başlatma yetkisi olarak kullanmaz.

Bu alt görevin ilk geniş doğrulaması (inceleme düzeltmeleri öncesi): `npm test` **399 toplam, 392 PASS, 0 FAIL, 7 SKIP**; `npm run check` ve preflight CLI sözdizimi kontrolü geçti. Atlanan testler I1, I1b, I2, I3, I4, I5, I6 gerçek JAR + SQLite bağlantı entegrasyonlarıdır; `NAUTILUS_LINK_IT_JAVA` / `NAUTILUS_LINK_IT_CLASSPATH` sağlanmadı. Bu sayı eşzamanlı ana audit geliştirmesinin o andaki durumudur; ana rapor nihai suite sayısını yeniden doğrulamalıdır. Şablonun CLI denemesi 0 PASS / 0 FAIL / 17 UNVERIFIED verdi. Node `node:sqlite` deneysel özellik uyarısı başarısız test olarak yorumlanmadı.


İnceleme sonrası RED→GREEN: tam kategoride mevcut desired kanalları iki kez sayma, retired owned kanal yerini hesaba katmama, Leaf forkunu sırf adı farklı diye reddetme ve desteklenmeyen To5'i kabul etme sorunları için 6 test eklendi. Yeni testlerin 5'i önce başarısız gözlemlendi (50 yeni + 1 mevcut kanal senaryosu zaten doğru reddediliyordu). Düzeltme sonrası **24/24** hedef test geçti. `FeatureBridge.voice` takımları doğrudan `TeamOperations.snapshot` çıktısından alır; `player()` takım üyelerine `uuid` ve `team` alanlarını ekler. Preflight bu gerçek gövdeyi kullanır, farklı bir üyelik şeması varsaymaz.

`managedChannels` kapasite kanıtı mevcut `uhc_voice_registry_v1.channels` anahtar/ID haritasından ve güncel Discord kanal durumundan aynı anda toplanmalıdır. Registry'de bulunup Discord'da gerçekten silinmiş ID'ler canlı envantere eklenmez; yalnız cache eksikliği silinmiş kanıtı değildir. `managedChannels:[]` yalnız hiç yönetilen canlı kanal olmadığı doğrulandıysa kullanılmalıdır. Retired `releasable:true` boş kanal veya güvenli tahliye/silme koşulları doğrulanan kanaldır; tahliye başarısı belirsizse true yazılmamalıdır. Araç bu emri çalıştırmaz.

İnceleme düzeltmeleri sonrası geniş doğrulama: `npm test` **408 toplam / 401 PASS / 0 FAIL / 7 SKIP**, `npm run check` başarılı. Aynı 7 gerçek JAR bağlantı entegrasyonu bu çalıştırmada da ortam değişkenleri eksik olduğundan SKIP kaldı; canlı test olarak gösterilmedi.


Son bağımsız incelemede bulunan P1 yanlış GO düzeltildi: `teamadmin.active=true` fakat `voice.enabled=false` gövdesi FeatureBridge'in `enabled=isStarted||planned` sözleşmesine aykırıdır. Yeni negatif regresyon önce `PASS !== FAIL` ile RED oldu; evaluator artık bunu FAIL yapar. Pozitif countdown testi `teamadmin.active=true`, `voice.active=false`, `voice.enabled=true`, `matchKey=""` durumunun geçerli kaldığını doğrular. Düzeltme sonrası hedef preflight suite **26/26 PASS**; nihai geniş suite ana görev tarafından ayrıca çalıştırılır.
