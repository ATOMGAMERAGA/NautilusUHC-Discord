# Mesaj düzenleyici ve maç bildirimleri — 1.2.9

## Bot

Botu bu branch'in kaynaklarıyla yeniden dağıt veya güncelle ve yeniden başlat.
Slash komutları başlangıçta sunucuya otomatik kaydedilir. Mevcut token/DB/köprü
ayarlarını koru; yeni ortam değişkeni gerekmez. `data/` kalıcı depolama olmalıdır.

- `/admin dm test:true`: normal DM paneliyle aynı düzenleyici; hangi hedefi
  seçersen seç bütün gönderimler **yalnız senin DM'ine** gider.
- `/admin dm`: kendin, seçilmiş üyeler, bir rol, maç bildirimi aboneleri veya bütün
  insan üyeler. Önce metin/embed/görselleri düzenle; **Kendime test** düğmesine bas;
  sonra **Gönder** ile alıcı sayısını gör ve gönderimi onayla.
- `/embed`: kanal için aynı düzenleyici. İsteğe bağlı `kanal`, `başlık`, `açıklama`,
  `metin`, `renk`, `resim`, `küçük-resim`, `alt-yazı` başlangıç değerleri kullanılabilir.
  `test:true` bütün gönderimleri yalnız senin DM'ine yönlendirir.
- `/admin macmesajtest`: plan, açıldı ve sonuç örneklerini çağrıldığın kanala gönderir.
  `tür`, `ödül`, `takım` seçenekleri var. Everyone/here ve abone DM'i göndermez.

Panel ve yanıtları yalnız komutu kullanan kişi görür; yeni komutlar Admin yetkisine
tabidir. Önizleme de özel yanıt olarak görünür. URL butonları gerçek gönderimde
tıklanabilir; editor butonları yalnız özel panelde bulunur.

## Özelleştirme ve şablonlar

Menüden düz metin/embed, özel metin, başlık, açıklama, HEX renk, görseller, başlık
bağlantısı, yazar, alt yazı, zaman damgası, en fazla 25 alan ve 5 bağlantı butonu
ayarlanır. Alan ve buton seçiminde mevcut öğeyi seçersen kayıtlı değerlerle
düzenleme formu açılır. URL'ler HTTP/HTTPS olmalıdır.

`%etiket%` her alıcının kendi Discord etiketi olur. `%kullanici%` kullanıcı adı,
`%sunucu%` sunucu adı ve `%tarih%` Türkiye tarihiyle doldurulur. Başlık, metin,
açıklama, alanlar ve alt yazı destekler. İstenmeyen everyone/rol etiketleri çalışmaz.

**Şablon kaydet** ile kişisel bir ad gir. Aynı ad mevcut şablonu günceller.
En fazla **5 şablon** saklanır; her admin ve sunucu için ayrıdır ve bot yeniden
başladığında korunur. Şablon listesinden yükle; özelleştirme menüsündeki
**Kişisel şablon sil** ile sil. Yüklemek hedefi ve test modunu değiştirmez.

Paneller 30 dakika kullanılmadığında, gönderim onayları 2 dakikada sona erer.
Onaylanan içerik/alıcılar sabitlenir ve aynı onayla iki kez gönderilmez.
Kapalı DM'ler sonuç sayımında hata olarak gösterilir; diğer alıcılara devam edilir.

## Plugin

Sunucuyu kapat; mevcut NautilusUHC klasörünü yedekle. Eski JAR'ı kaldırıp
`dist/NautilusUHC-1.2.9-message-studio.jar` dosyasını `plugins/` klasörüne koy.
Bot güncellemesiyle birlikte kullan ve sunucuyu yeniden başlat. Paper 1.21.11 / Java21
ve mevcut LibertyBans bağımlılığı gerekir.

`/uhcadmin` → yeni maç ekranında **Ödül** yazısını ayarla. Sağ tık ödülü temizler;
boş ödülde embedin ödül satırı görünmez. Plan kaydedildiğinde ödül ve bildirim
seçimleri o plana kopyalanır; sonradan diğer maçların ayarlarıyla değişmez.
Takım seçimleri **FFA / To2 / To3**; FFA eski takımları temizler.

Yeni maç ve Discord ekranlarında **@everyone** ve **@here** ayrı açılıp kapatılır;
varsayılan kapalıdır. Açık seçenekler embed yanındaki `||@everyone @here||`
metninde görünür. Spoiler görsel olarak saklar; bildirim açıkken ping çalışır.
Plan zaten duyurulduysa başlangıçta tekrar toplu ping atılmaz.

Host'un Discord etiketi gerçek Minecraft–Discord hesap bağlantısından okunur.
Bağlantı yoksa Minecraft adı gösterilir. Bütün zamanlar Europe/Istanbul'dur.

## Doğrulama

Bot: `npm ci`, `npm test`, `npm run check` (üretim Docker imajı Node22 kullanır).
Node24'te mevcut better-sqlite3 11.x sürücüsü test sürecinde native GC hataları
verebiliyor; bu çalışmada tam suite üretimle uyumlu Node22.21.1 ve gerçek
better-sqlite3 sürücüsüyle çalıştırıldı. Gerçek Discord ve çalışan Paper sunucusu üzerinde smoke testi
kurulumdan sonra yukarıdaki yalnız-kendine test komutlarıyla yapılmalıdır.

Java build/test, gerçek Paper API JAR'larının bulunduğu bir klasörle:

```bash
python plugin-patch/build.py base.jar dist/NautilusUHC-1.2.9-message-studio.jar \
  --java-bin /path/to/jdk21/bin --api-dir /path/to/paper-libraries
python plugin-patch/test.py dist/NautilusUHC-1.2.9-message-studio.jar \
  --java-bin /path/to/jdk21/bin --api-dir /path/to/paper-libraries
```
