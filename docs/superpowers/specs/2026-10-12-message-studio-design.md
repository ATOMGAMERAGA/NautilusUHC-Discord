# Nautilus mesaj düzenleyici ve maç bildirimleri

Kullanıcı ayrıntılı tasarımı devretti ve 12 Ekim 2026'da başlama talimatı verdi.
Bot ve plugin birlikte güncellenir; canlı Discord mesajı bu çalışma sırasında gönderilmez.

- `/admin dm`: yalnız komutu kullanan adminin gördüğü panel. Düz metin veya embed;
  içerik, başlık, renk, görseller, yazar, footer, en fazla 25 alan ve 5 URL butonu.
  Hedefler: kendisi, seçilmiş üyeler, bir rol, bildirim aboneleri veya tüm insan üyeler.
  Son gönderim ekranında alıcı sayısı ve onay bulunur; tek onay tek gönderim yapar.
- `/admin dm test:true` aynı paneli kullanır ama bütün hedef seçimleri yalnız komutu
  kullanan kişinin DM'ine yönlendirilir. Normal paneldeki test düğmesi de yalnız ona gider.
- `%etiket%` her teslimatta alıcının kendi etiketi olur. `%kullanici%`, `%sunucu%`,
  `%tarih%` ek kolaylık yer tutucularıdır. Preview ve DM aynı üreticiyi kullanır.
- Her adminin her sunucuda en fazla 5 kalıcı şablonu vardır. Şablon kaydetme/yükleme/
  güncelleme/silme bulunur; şablonlar hedefi ve test modunu değiştirmez.
- `/embed` mevcut isteğe bağlı başlangıç değerleriyle aynı paneli açar; metin ve embed
  birlikte gönderilebilir, kanal seçilebilir ve yalnız kendine DM testi yapılabilir.
- Maç planı/başlangıcı ve sonuçlar kullanıcının emojili, ayraçlı embed düzenini kullanır.
  FFA/To2/To3, etkin senaryolar, nautilusuhc.com, 1.21+, isteğe bağlı ödül;
  Türkiye saatiyle aynı gün saat, başka gün Türkçe tarih; başlangıçta Açıldı.
  Host hesap bağlantısından gelen Discord kimliğiyle gösterilir, yoksa Minecraft adı.
- `/admin macmesajtest` örnek plan/başlangıç/sonuç mesajlarını çağrıldığı kanala gönderir;
  gerçek üretici kullanılır, hiçbir everyone/here veya abone DM dağıtımı tetiklenmez.
- Plugin `/uhcadmin`: FFA/To2/To3; maça özel ödül; everyone/here ayrı aç/kapat.
  Ödül ve mention ayarları planla birlikte kalır, diğer plan veya host değişikliklerinden
  etkilenmez. Köprü mevcut imzaları korur, yeni alanlar ekler.
- Bildirim açıksa mention embed yanında `||@everyone @here||` içeriğiyle gönderilir.
  Varsayılan kapalı; testte ve önceden duyurulmuş planın başlangıcında kapalı.
- Discord boyut/URL sınırları gönderimden önce doğrulanır. Paneller admin ve sahibi
  denetimli, süreli; çift tıklama, eski onay ve başarısız DM kontrollü sonuç üretir.

Teslim: bot branch'i GitHub'a push, yeni JAR ve kısa kurulum/kullanım belgesi.
