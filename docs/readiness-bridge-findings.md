# Bridge / Voice Core Hazırlık Bulguları

Denetim tabanı: `d01ead02fde07af466a271e5e3828febdbf4a13c`. Bu çalışma `src/voicecore.js`, `src/mcapi.js`, `src/voiceentrypermissions.js` ve üç yeni test dosyasını değiştirir. `src/bridgequeue.js` ve `src/voiceentry.js` için kanıtlanmış üretim davranışını değiştiren bir düzeltme gerekmedi. Canlı Discord/Paper ortamı, gerçek hesaplar, üretim DB veya sırlar kullanılmadı.

## Kanıtlanan ve giderilen hatalar

### P0: Eksik oyun snapshot'ı yönlendirme veya temizlik yetkisi kazanabiliyordu

Tabandaki `src/voice.js:157` yalnız üst seviye diziler, iki boolean ve aktif maçta string kimlik kontrol ediyordu. `active:true,enabled:false` reddedilmiyordu; reconciliation `!state.enabled` dalında temizlik yapabiliyordu. `links` içindeki `participant` veya `alive` eksikliği ise `src/voicecore.js:31` yönlendirme dallarında Global/İzleyici sonucu üretebiliyordu. Geçersiz takım satırı, dizide null ve tanımlanmamış takım referansı da doğrulanmıyordu.

Çözüm: `src/voicecore.js:2` içindeki `isValidVoiceSnapshot` çağırana fail-closed doğrulama sağlar. Üst seviye `enabled`, `active`, `matchKey`, `teams`, `links` zorunludur; aktif maç enabled olmalı ve boş olmayan kimlik taşımalıdır. Pozitif ve benzersiz takım numaraları, geçerli hesap satırları, tanımlı takım referansları, aynı UUID'nin yinelenmemesi kontrol edilir. Aktif maçta participant/alive boolean zorunludur. UUID bulunan yeni satırlarda online boolean zorunludur. Eski, UUID/online içermeyen satırlar ve aktif olmayan seyrek satırlar uyumluluk amacıyla kabul edilir; bulunan boolean alanlar yine tip kontrolünden geçer. UUID biçimi ve Discord snowflake uzunluğu bu katmanda sıkılaştırılmaz; mevcut eski istemci/test sözleşmesi korunur.

Entegrasyon gereği: `src/voice.js` tüm snapshot'ları reconciliation öncesinde `isValidVoiceSnapshot` ile sınamalı, başarısız durumda saklanan snapshot'ı bırakmalı ve kanalları temizlememelidir. Bu dosyanın sahibi ana ajan olduğundan entegrasyonu ana ajan yapar.

Regresyon: `test/voicecore-readiness.test.js:9`, `:28`. Yeni fonksiyon yokken RED; doğrulama eklenince GREEN. Ayrıca aktif olmayan snapshot'ta eksik matchKey RED olarak tekrar üretildi ve zorunlu string kontrolüyle giderildi.

### P1: İstek devam ederken ikinci Minecraft instance'ı belirmesi gözden kaçıyordu

`src/mcapi.js:191` civarındaki başlangıç kontrolü tek instance görse bile kuyruk cevabı gelene kadar ikinci sunucu bağlanabiliyordu. Eski kod ilk sunucunun 200 cevabını oyunun tek otoritesi olarak kabul ediyordu.

Çözüm: `src/mcapi.js:213` cevabı şekillendirmeden önce `/api/voice` için instance belirsizliğini yeniden kontrol eder. Belirsizlikte `ok:false,errorCode:multiple_plugin_instances` döner; uygulanabilecek snapshot alanları döndürülmez. Korelasyon kimliği ve hata kodu mevcut log akışında kalır. Hesap bağlama yazma işlemlerinin mevcut semantiği değiştirilmez.

Regresyon: `test/mcapi-readiness.test.js:16` gerçek `createBridgeQueue` ile A poll → voice isteği → A claim → B poll → A sonucu sırasını kurar. Eski kod `ok:true` ile RED, düzeltme sonrasında GREEN. `:26` aynı kimlikli iki eşzamanlı poller'ın reddini ve 60 saniyelik belirsizlik penceresi sonrası otomatik toparlanmayı; `:39` timeout sonrası kuyruk temizliğini ve sonraki sağlıklı isteği doğrular.

### P1: Bir giriş izni hatası diğer oyuncuların izinlerini kilitli bırakabiliyordu

Tabandaki `src/voiceentrypermissions.js:8` döngüsü ilk Discord REST hatasında duruyordu. İlk kullanıcının süresi biten geçici overwrite'ı 403 üretirse diğer kullanıcıların süresi dolan overwrite'ları o döngüde kaldırılamıyordu.

Çözüm: `src/voiceentrypermissions.js:17` her blok için hatayı izole eder; başarısız kullanıcının kayıtları tekrar deneme için korunur. Diğer kullanıcılar işlenir. `createEntryPermissionManager(guard,{onError})` callback'i hatayı kullanıcı ve kanal bağlamıyla raporlayabilir. Callback yoksa bütün kullanıcılar işlendiğinde `AggregateError` fırlatılır; hata sessizce yutulmaz. Ana ajan voice manager'da callback'i loglamaya bağlamalıdır.

Regresyon: `test/voiceentry-readiness.test.js:25` A'nın delete işleminde 403 oluşturur; B'nin izni geri açılır, A sonraki başarılı döngüde temizlenir. Eski kod RED, düzeltme GREEN.

### P1: Restart sırasında cache miss kalıcı geçici engel oluşturabiliyordu

Tabandaki yönetici kanal cache'inde eski kanalı bulamazsa kayıtları bitiriyordu. Cache henüz dolmamışsa gerçek Discord overwrite'ı kalıyor, geri yükleme bilgisi kayboluyordu.

Çözüm: `src/voiceentrypermissions.js:6` eksik kanalı ID ile fetch eder. Unknown Channel (10003) gerçek yokluk olarak kabul edilir; geçici REST hatası kaydı korur ve tekrar denenir. Yalnız Connect alanı geri yüklenir; Speak/Stream gibi ilişkisiz bitler korunur.

Regresyon: `test/voiceentry-readiness.test.js:37`, `:45` cache miss ve 429 sonrası retry için RED→GREEN. `:56` ilişkisiz bitlerin korunduğu davranışı doğrular.

## Test kanıtı

Node: `/tmp/node-v22.16.0-linux-x64/bin/node` v22.16.0.

- `npm run check`: başarılı; tüm JS dosyaları sözdizimi kontrolünden geçti.
- Yeni üç dosya toplam 10 test: başarılı.
- Yeni dosyalar + `test/voiceentry.test.js` + `test/bridgequeue.test.js`: 50/50 başarılı, 0 skip; çıktı `/tmp/readiness-bridge-focused.log`.
- Bir ara tam-suite koşusu: 388 toplam, 376 geçti, 5 başarısız, 7 atlandı; çıktı `/tmp/readiness-bridge-suite.log`. Bu beş test o sırada başka ajanlarca geliştirilmekte olan preflight (yanlış kanal tipi/guild/ID/dolu kategori, Portal intents onayı, anonim IP kimliği) ve To4 teamadmin (görüntülenen revision, desteklenmeyen boyut) alanlarındaydı. Bu ara sonuç final sonuç yerine kullanılmamalı; ana ajan son bütün-suite koşusunu ayrıca raporlar.
- Normal sandbox altında test subprocess çıktısı kısıtlandı; test dosyasını doğrudan Node ile çalıştırmak RED/GREEN ayrıntılarını gösterdi. Tam-suite ve birleşik focused testler izinli yerel yürütmede çalıştırıldı. Desteklenmeyen `--test-isolation=none` seçeneği bir kontrol komutunda exit 9 üretti; desteklenen standart `node --test` komutuyla düzeltildi. Bu bir ürün test başarısızlığı değildir.

## İstenen 20 ses senaryosunun kapsamı

Aşağıdaki kanıtlar yerel JS fixture, gerçek yönlendirme/guard/kuyruk kodu ve sahte Discord REST sınırlarıdır; canlı entegrasyon olarak sunulmaz.

| No | Senaryo | Kanıt / sınır |
|---|---|---|
| 1 | Planlanan kanallar | Mevcut `test/voice.test.js` planned match testi; ana ajanın permission/cache regressions'ıyla birlikte değerlendirilir. |
| 2 | Başlangıçta aktif katılımcı | Mevcut planned/start testi; `destination` aktif participant koşulu. |
| 3 | Solo | Mevcut destination testi ve yeni geçerli solo snapshot vakası. |
| 4 | Ölüm | Mevcut destination + manager testleri, alive=false → spectator. |
| 5 | Diriltme | Mevcut destination testi alive=true ile takım hedefini doğrular; hızlı REST yarışları ana ajanın kapsamı. |
| 6 | Takım değişimi | Mevcut manager testi takım 1 → takım 2. |
| 7 | Minecraft offline | Mevcut offline testi; yeni iki hesap seçim testi iki hesap da offline iken global sonucu doğrular. |
| 8 | Discord çıkış/giriş | Mevcut transition reentry testi; en güncel tick sonrası takım hedefi. |
| 9 | İki Minecraft hesabı | `test/voicecore-readiness.test.js:39`, mevcut manager two-account testi; online participant seçimi korunur. İki online participant varsa UUID sırasına göre deterministik temsilci seçilir; tek Discord sesi iki takımı eşzamanlı temsil edemez. |
| 10 | Bridge kopması | Mevcut outage testi owned kanalların silinmediğini doğrular; yeni timeout testi işlerin kuyrukta birikmediğini doğrular. |
| 11 | Bridge toparlanma | Yeni mcapi timeout/recovery ve duplicate-window/recovery testleri; mevcut recovered unlink manager testi. |
| 12 | Bot restart | Mevcut kanal ID reuse ve guard persist/expiry testleri; yeni cache miss restore testi. |
| 13 | Maç sonunda cleanup | Mevcut cleanup yalnız owned kanal testi; devam eden REST güvenliği ana ajan testleriyle tamamlanır. |
| 14 | İki instance | Mevcut `bridgequeue.test.js` ayrı kimlik/aynı IP/duplicate kimlik testleri; yeni in-flight ikinci-instance testi. |
| 15 | Toplu ses girişleri | Guard sync Promise kuyruğu (`src/voiceentrypermissions.js:47`) korunur. Reconciliation/event yarışları ana ajan kapsamı; canlı yoğunluk testi yapılmadı. |
| 16 | Eski takım kanalları | Mevcut retired-channel akışı statik incelendi; kapasite/reroute/delete hataları ana ajan kapsamı. |
| 17 | Kategori limiti | `channelSpecs` sayısal sıralama korunur; geçici eski kanal kapasitesi ana ajan kapsamı. |
| 18 | /testses | Mevcut demo iptal/match takeover/origin restore/concurrency testleri; ana ajan değişikliklerinden sonra tekrar koşulmalı. |
| 19 | Spam guard | Mevcut 10 giriş/60 saniye, bot hareketini saymama, restart/expiry ve yeni 403/429/cache-miss/ilişkisiz bit testleri. Yetkiliye platform bypass garantisi verilmez; Administrator overwrite kurallarını Discord uygular. |
| 20 | Bozuk /api/voice | Yeni validator vakaları; ana ajan manager testleriyle yan etkilerin gerçekten engellendiğini doğrular. |

## Doğrulanamayanlar ve canlı ön kontrol

- Gerçek Discord guild'inde intents, bot rol hiyerarşisi, Move Members/Manage Roles/Connect yetkileri, rate limit/backoff zamanlaması ve Administrator istisnası yerel sahte REST testleriyle ispatlanamaz.
- Gerçek Paper üzerinde ölüm/diriltme, iki hesap çevrimiçiliği, online→offline zamanlaması ve plugin'in snapshot üreten oyun thread'i ayrıca smoke test ister. `FeatureBridge.java:34`–`:54` sözleşmesi statik olarak yeni doğrulayıcıyla uyumludur.
- Yapısal olarak geçerli fakat mantıken eksik boş links/teams listesi, mevcut protokolde total/revision/complete işareti olmadığı için gerçek boş durumdan ayırt edilemez. Yeni validator alan/tip/referans tutarsızlıklarını reddeder; doğrulanabilir veri bulunmadan protokolü yeniden tasarlamaz.
- Aynı explicit kimliği kullanan iki instance'ın poll'ları hiç çakışmazsa salt kimlik/eşzamanlılık mekanizması her koşulda iki süreç olduğunu kanıtlayamaz. Her sunucuya benzersiz instance kimliği verilmesi ve tek sunucunun bu bota bağlanması operasyonel koşuldur.
- Başlangıç öncesi yetkili bir deneme maçıyla takım → ölüm → diriltme → takım değişimi → offline → rejoin ve bridge kesinti/toparlanma kontrolü yapılmalıdır. Bu denetim otomatik canlı maç/deploy başlatmamıştır.

## Ana ajan reconciliation değişikliklerinin bağımsız incelemesi

Ana ajanın ilk `src/voice.js` yaması üzerinde üç ek P1 senaryosu `/tmp/readiness-voice-review.mjs` içinde gerçek manager/guard kodu ile RED olarak üretildi; ana ajan bu vakaları kalıcı `test/voice.test.js:254`, `:264`, `:272` regressions'ına taşıdı ve düzeltmeleri uyguladı:

1. Takımı kaldırılan kullanıcının yeni takıma taşıması 403 veriyordu; retire fallback Global'e taşıyıp eski kanalı siliyor, sonraki döngüler kullanıcının Global'de kalmasına neden oluyordu. Son kod doğru hedefe taşıma doğrulanmadan eski kanalı emekliye ayırmıyor.
2. Başlangıç anında member fetch 403 verince pending başlangıç kaydı siliniyordu; fetch toparlandığında oyuncu dış kanalda kalıyordu. Son kod member bulunamıyorsa pending kaydı koruyor; doğrulanmış bağlantısız üyede temizliyor.
3. Önce Connect:true overwrite'ı olan kullanıcı guard engeli sırasında unlink olduktan sonra, engel süresi bridge kesintisinde biterse eski Connect:true izni geri geliyordu. Son kod yetkili snapshot'ta unlink görünce guard'ın geri yükleme Connect değerini nötr hâle getiriyor; kesintide eski izin tekrar açılmıyor.

Bağımsız RED koşusu: 2 temel test geçti, yukarıdaki 3 test başarısız oldu. Son kodda aynı dosya yeniden çalıştırıldı: 5/5 başarılı. Ayrıca kategori doluluk sayacı yalnız gerçekten kategorideki emekli kanal için azaltıldı ve yerel yapılandırma hatalarına sır içermeyen kararlı `voice_*` kodları eklendi. Bu bağımsız incelemede başka engelleyici bulgu kalmadı; gerçek Discord/Paper yoğunluk ve lifecycle testleri hâlâ yapılmış değildir.
