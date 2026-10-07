# İki hesap, IP oturumu ve ses giriş sınırı

Bir Discord hesabı en fazla iki Minecraft UUID'sine bağlanabilir; her UUID tek Discord'a bağlı kalır. Eski bağlantılar, link_id, kod makbuzları ve unlink epoch'ları korunur. Üçüncü hesap reddedilir; birini kaldırmak diğerini değiştirmez. Discord'dan durum sorgusunda iki hesap da görünür; doğrulama kendi UUID/link_id'si ile okunur. Çoklu hesap varsa belirsiz kaldırma rastgele hesabı silmez.

Aynı IP'den Minecraft sunucusuna eşzamanlı en fazla bir oyuncu girebilir. Ana iş parçacığında giriş rezervasyonu iki eşzamanlı giriş yarışını engeller. Reddedilmiş giriş ve çıkış rezervasyonu bırakır; restart mevcut çevrimiçi oyuncularla başlar. IP'ler kalıcı kaydedilmez.

Ses köprüsü bağlantılarda online alanını sağlar. Discord hesabının çevrimiçi MC hesabı seçilir; aktif maçtaki hesap önceliklidir. Çevrimiçi hesabı yoksa sistemin seslerinden global ses 1522216892658614272'ye taşınır. Maçın bağlı ama katılmayan kullanıcıları da global sese gider. Küresel ses kanalı sistem tarafından oluşturulmaz veya silinmez. Köprü kesilince eski bilgiyle oyuncu taşınmaz.

Takım Geçiş'e kullanıcı kaynaklı girişler kayan 60 saniyelik pencerede sayılır. Onuncu girişte 60 saniye giriş engeli verilir ve global sese taşınır. Bot taşımaları sayılmaz; engellenmiş denemeler engeli uzatmaz. Member Connect deny mevcut kişisel overwrite korunarak uygulanır, süre bitince eski izin döner; DB'de süresi saklanır ve restart sonrası kurtarılır. Bot ve tüm sunucu sesleri bu engelden etkilenmez. Yönetici Discord izni Connect deny'ı aşabildiği için olayda da kontrol yapılır.

/testses akışı korunur; gerçek maçta otomatik yönlendirme testin sahte durumundan ayrılır. Bot GitHub'a gönderilip Dokploy izlenir; plugin JAR'ı yedekle birlikte MC'ye yüklenir, canlı maç/oyuncu varken restart öncesi durum değerlendirilir.
