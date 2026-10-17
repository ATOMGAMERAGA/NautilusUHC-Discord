# NautilusUHC 1.2.9 — Production Readiness, UHC Match & Discord Voice Reliability Audit

Sen kıdemli bir Java/Paper Minecraft, Node.js, Discord.js ve sistem güvenilirliği mühendisisin.

**Repository:** https://github.com/ATOMGAMERAGA/NautilusUHC-Discord

**Denetlenen commit:** `d01ead02fde07af466a271e5e3828febdbf4a13c`

**Minecraft plugin:** `NautilusUHC-1.2.9-message-studio.jar`

**Beklenen SHA-256:**
`5d8e73870d18110048678cc79c6b11e53a868bb810599589c748d9167fae7bf3`

## AMAÇ

NautilusUHC sunucusunda gerçek oyuncularla canlı bir UHC maçı yapılacak.

Hedefim:

- Oyuncuların maç başlangıcında doğru takımlarına yönlendirilmesi.
- Discord takım ses sisteminin sorunsuz çalışması.
- Ölüm, diriltme, takım değiştirme ve çevrimdışı olma durumlarının doğru yönetilmesi.
- Maç başlangıcı, geri sayım, dünya hazırlama, scatter, PvP, Deathmatch ve bitiş süreçlerinin güvenilir olması.
- Minecraft ile Discord botunun sürekli ve güvenli senkronize çalışması.
- Var olan özelliklerin bozulmaması.

**Bu yalnızca kod incelemesi değildir. Kanıtlanmış hataları düzelt, regresyon testleri ekle ve uygulanabilir bir production readiness raporu üret.**

Mevcut çalışan işlevleri gereksiz yere yeniden tasarlama. Minimal, güvenli ve geriye uyumlu değişiklikleri tercih et.

## 1. ÖNCELİKLİ HATALAR

### P0 — Discord ses senkronizasyonunun tek hatayla durması

Dosya: `src/voice.js`

`reconcile()` içinde rol senkronizasyonu, kanal oluşturma ve oyuncu taşıma işlemlerini ayrıntılı incele.

Bir oyuncunun rolü değiştirilemediğinde veya bir oyuncu taşınamadığında diğer oyuncuların senkronizasyon işlemlerinin durma riskini gider.

Gereksinimler:

- Kullanıcı bazlı hataları uygun noktalarda izole et.
- Bir oyuncunun Discord API hatası diğer oyuncuların güncellenmesini engellemesin.
- Kritik sunucu yapılandırması hatalarını sessizce yutma.
- Başarısız işlemleri sonraki reconciliation döngüsünde güvenle yeniden dene.
- Başarısız taşımalar gerçek konum doğrulanmadan başarılı kabul edilmesin.
- Gereksiz API tekrarlarını önle.
- Hata loglarına guild, kanal, işlem ve uygun korelasyon bilgilerini ekle.
- Token, gizli anahtar veya hassas verileri loglama.

### P0 — Discord kanal izinlerinin sapması

Dosya: `src/voice.js`

`registry.permissions` yalnızca beklenen izinlerin imzasını kontrol ediyor. Discord'daki gerçek izinlerin sonradan değiştirilmesini her döngüde algılamayabilir.

Şunları düzelt:

- Yönetilen kanalların gerçek permission overwrite durumunu doğrula.
- Yalnızca değişiklik varsa gerekli izinleri onar.
- Bağlı olmayan oyuncuların takım kanallarına manuel girişini engelle.
- Normal oyuncuların farklı takımları dinleyememesini sağla.
- Discord Administrator izninin platform düzeyindeki ayrıcalıklarını doğru ele al.
- Giriş spam korumasının kullanıcıya özel geçici izinlerini koru.
- Manuel olarak oluşturulmuş ilgisiz kanallara dokunma.
- Bot restart sonrasında doğru izinleri yeniden uygula.
- Her 5 saniyede gereksiz permission overwrite API isteği üretme.

### P1 — Gereksiz bütün-kanal sorguları

Dosya: `src/voice.js`

Her 5 saniyelik döngüde `guild.channels.fetch()` çalıştırılıyor.

Bunu inceleyerek:

- Gateway cache kullanımını optimize et.
- Gerektiğinde hedefli fetch yap.
- Restart sonrasında kanalları doğru keşfet.
- Cache eksikliği ile gerçekten silinmiş kanalları ayır.
- Discord rate limit mekanizmasına uy.
- Çok oyunculu maçlarda işlem kuyruklarının birikmesini önle.

### P1 — Takım boyutu tutarsızlığı

JAR içindeki `config.yml` dosyasında varsayılan `uhc.teamSize` değeri 4.

Ancak `plugin-patch/src/com/nautilus/admin/TeamOperations.java` takım yönetiminde yalnızca 1, 2 veya 3 oyunculuk takımları kabul ediyor.

Bunu kökünden incele.

- Minecraft TeamManager, UHC admin GUI, Discord teamadmin ve yapılandırmanın hangi takım boyutlarını desteklediğini belirle.
- To4 destekleniyorsa yönetim sistemini uyumlu hâle getir.
- To4 desteklenmiyorsa varsayılan yapılandırma ve yönetim seçeneklerini tutarlı hâle getir.
- Mevcut takım kayıtlarını kesinlikle bozma.
- Takım boyutu değiştirilirken kapasite ve maç durumu kontrolünü koru.

## 2. OTOMATİK DISCORD TAKIM SES SİSTEMİ

İlgili dosyalar:

- `src/voice.js`
- `src/voicecore.js`
- `src/voiceentry.js`
- `src/voiceentrypermissions.js`
- `src/mcapi.js`
- `src/bridgequeue.js`
- `plugin-patch/src/com/nautilus/bridge/FeatureBridge.java`
- `plugin-patch/src/com/nautilus/bridge/BridgePoller.java`

Aşağıdaki senaryoları doğrula:

1. Planlanan maçın ses kanalları doğru oluşturulmalı.
2. Maç başladığında bağlı ve aktif katılımcılar doğru takımlarına taşınmalı.
3. Solo oyuncular Solo kanalına gitmeli.
4. Ölen oyuncu İzleyici kanalına gitmeli.
5. Diriltilen oyuncu doğru takım kanalına dönmeli.
6. Oyuncu takım değiştirdiğinde eski takımda kalmamalı.
7. Minecraft bağlantısı kesilen oyuncu mevcut politikaya uygun biçimde Global Ses'e gitmeli.
8. Discord sesinden çıkıp yeniden giren oyuncu güncel durumuna yönlendirilmeli.
9. Discord hesabına iki Minecraft hesabı bağlıysa çevrimiçi ve katılımcı olan hesap doğru seçilmeli.
10. Minecraft köprüsü koparsa kanallar yanlışlıkla silinmemeli.
11. Köprü geri geldiğinde ses sistemi otomatik toparlanmalı.
12. Bot restart sonrasında kanal kimlikleri ve izinler kurtarılmalı.
13. Maç sona erdiğinde yalnız botun yönettiği geçici kanallar temizlenmeli.
14. Yanlışlıkla iki Minecraft instance'ının aynı köprüye bağlanması güvenli şekilde algılanmalı.
15. Çok sayıda oyuncu aynı anda ses kanalına katıldığında yarış durumları oluşmamalı.
16. Takım listesi değiştiğinde eski kanallar güvenle kaldırılmalı.
17. Kategori kanal sınırı ve geçici eski kanal kapasitesi dikkate alınmalı.
18. `/testses` gerçek maç akışını bozmamalı.
19. Ses giriş spam koruması, normal yönlendirmeyi veya yetkili testlerini yanlışlıkla engellememeli.
20. Bozuk veya kısmi `/api/voice` yanıtı sessizce yanlış kanallara taşıma üretmemeli.

Özellikle Discord VoiceStateUpdate olayları ile periyodik reconciliation arasındaki yarış durumlarını araştır.

## 3. UHC MAÇ YAŞAM DÖNGÜSÜ

Minecraft tarafındaki mevcut JAR ve kaynak/patch yapısını incele.

Şu süreçleri ayrı ayrı doğrula:

- Maçın hemen başlatılması
- Planlanan maçın başlaması
- Oyuncu ve takım listesinin hazırlanması
- Dünya seçimi ve datapack kontrolü
- Scatter ve başlangıç hazırlığı
- Geri sayım
- Oyun fazlarının geçişi
- Final Heal
- PvP açılması
- Border küçülmesi
- Deathmatch
- Oyuncu ölümü ve diriltilmesi
- Oyuncunun çıkıp tekrar girmesi
- Geç katılım
- Maçın iptal edilmesi
- Kazananın belirlenmesi
- Maç bitişi ve verilerin kaydedilmesi

Maç durumlarının Discord `/api/voice` yanıtındaki `enabled`, `active`, `matchKey`, `teams` ve `links` alanlarıyla tutarlı kalmasını doğrula.

Oyun aktifken hiçbir güvenlik düzeltmesi mevcut maç durumunu, envanterleri, oyuncu konumlarını veya takım kayıtlarını sıfırlamamalı.

## 4. PRODUCTION ÖN KONTROLLERİ

Başlatma öncesinde aşağıdaki gereksinimleri denetleyen güvenli, salt-okunur bir kontrol mekanizması tasarla:

- Paper 1.21.11 uyumluluğu
- Java 21 uyumluluğu
- LibertyBans zorunlu bağımlılığı
- Discord bot bağlantısı
- GuildMembers ve GuildVoiceStates intent'leri
- Manage Channels, Manage Roles, Move Members ve Connect izinleri
- Bot rol hiyerarşisi
- Discord kategori ve Global Ses kanal kimlikleri
- Minecraft bridge outbound bağlantısı
- Bridge instance kimliği ve çoklu instance kontrolü
- Ortak secret yapılandırması
- Bot veritabanı erişimi
- Minecraft takım verilerinin bütünlüğü
- Dünya hazırlığı ve zorunlu datapack varlığı

Kontrol yalnızca bir rapor oluştursun. Otomatik olarak canlı maç başlatmasın, dünyayı değiştirmesin veya oyuncuları taşımasın.

## 5. TESTLER

Öncelikle mevcut testleri çalıştır:

```bash
npm ci
npm run check
npm test
```

Java tarafındaki mevcut test altyapısını ve derleme prosedürlerini inceleyerek ilgili kontrolleri de çalıştır.

Ek regresyon testleri yaz:

- Bir kullanıcıya rol verilememesi
- Bir kullanıcının ses kanalına taşınamaması
- Discord 403/429 API yanıtları
- Kanalın silinmesi veya manuel izinlerinin değiştirilmesi
- Aynı anda çok oyuncunun katılması
- Ölüm ve diriltme olaylarının art arda gelmesi
- Aktif maç sırasında bot restart
- Bridge bağlantısının kesilmesi ve geri gelmesi
- İki bağlı Minecraft hesabı
- FFA, To2, To3 ve destekleniyorsa To4
- Eski ve yeni takım kanallarının geçişi
- Maç ortasında takım değiştirme
- `/testses` sırasında maç başlaması
- Maç bitişi sırasında devam eden Discord API işlemleri

Mock testleri ile gerçek Discord/Paper entegrasyon testlerini birbirinden ayır.

Çalıştırılamayan testleri başarılı olarak gösterme. Eksik bağımlılıkları ve doğrulanamayan koşulları açıkça raporla.

## 6. DEĞİŞİKLİK GÜVENLİĞİ

Şu kurallar zorunlu:

- Eski özellikleri kaldırma.
- Kalıcı veritabanlarını sıfırlama.
- Üretim sırlarını değiştirme veya paylaşma.
- Gerçek sunucuda otomatik deployment yapma.
- Mevcut Discord kanallarını sebepsiz silme.
- Çalışan maçı otomatik durdurma.
- Gereksiz büyük refactor yapma.
- Güvenlik kontrollerini kaldırarak hataları gizleme.
- Testleri geçsin diye test beklentilerini anlamsız şekilde zayıflatma.
- Kaynak kodu değiştirdiysen uygun testlerle doğrula.
- Değiştirilen Java sınıflarının üretilen JAR'a gerçekten dahil olduğunu doğrula.

## 7. ÇIKTI VE KABUL KRİTERLERİ

İşi yalnızca analizle bırakma.

Kanıtlanmış hatalar için gerçek kod düzeltmeleri yap. Yeni testleri ekle ve mümkün olanları çalıştır.

Sonunda Türkçe teknik rapor üret:

**A. Kritik hatalar:** Dosya, satır, kök neden, tetikleyen senaryo, uygulanan çözüm.

**B. Test sonuçları:** Geçen, başarısız ve çalıştırılamayan testleri ayrı göster.

**C. Minecraft–Discord uyumluluğu:** API sözleşmesi, sürüm ve JAR doğrulaması.

**D. Canlı maç kontrol listesi:** Yetkilinin maçtan önce uygulayacağı kısa doğrulamalar.

**E. Deployment ve rollback:** Hangi dosyaların değiştiği, neyin yedekleneceği ve güvenli geri dönüş yöntemi.

**F. Son karar:** `GO`, `CONDITIONAL GO` veya `NO-GO`.

Her kararı test sonuçları ve kod kanıtlarıyla gerekçelendir.

**Önemli:** %100 sorunsuzluk garantisi verme. Gerçek Discord sunucusunda veya Minecraft ortamında doğrulama yapılmadıysa bunu kesinlikle açık belirt.

Öncelik: **Maçın güvenli başlayabilmesi ve oyuncuların doğru Discord takım seslerinde bulunması.** Diğer özellikler üzerinde yalnızca gerçek hata tespit edersen değişiklik yap.