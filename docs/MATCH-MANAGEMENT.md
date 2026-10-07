# Maç ve takım yönetimi — 1.2.7

Bot ve JAR birlikte kullanılmalıdır. JAR tabanı kullanıcının gönderdiği 1.2.6-fixes dosyasıdır; yalnız ilgili sınıflar ve metadata yenilenmiştir.

## Kullanım

- Minecraft `/uhcadmin`: ana ekrandan **Hemen maç başlat**. Kişisel takım/senaryo/dünya/duyuru/tarih-saat ayarları UUID'ye göre `plugins/NautilusUHC/host-preferences.properties` dosyasında saklanır. Ayar ekranında **Hemen başlat** veya **Maçı planla** seçilebilir. Hemen başlat, uzun plan/geri sayım beklemez; güvenli hazırlık ve dağıtım devam eder.
- Minecraft ve Discord `/teamadmin`: takım listesi, oluşturma, oyuncu taşıma, Solo yapma, dağıtma, boyut, rastgele dağıtım ve temizleme. Toplu sıfırlama/boyut değişimi maç sırasında kapalıdır. Oyun GUI'si `nautilus.host` ve giriş doğrulaması, Discord paneli Admin/üstü ister. Eski takım numaralarına işlem uygulanmaz; değişiklik olmuşsa panel yenilenmelidir.
- **Ateşten Korunma** (`no_fire`): senaryo seçimine eklendi. Maç oyuncularını ateş, yanma, lav ve sıcak blok hasarından korur.

## Discord sesleri

Kategori `1522215362857406654`. Aktif veya planlanmış maç varsa **Takım Geçiş**, numara sıralı **Takım N**, **Solo**, **İzleyici** oluşturulur. Giriş yalnız bağlı hesaplara açılır. Hedef kanallara kullanıcı kendisi bağlanamaz; bot taşır. Kanal kimlikleri bot DB'sinde saklanır. Rol **UHC • Hesabı Bağlı** bot tarafından yönetilir; botun rolü bunun üzerinde olmalıdır.

Botta **Kanalları Yönet**, **Rolleri Yönet**, **Üyeleri Taşı**, **Bağlan** izinleri ve GuildVoiceStates intent'i gerekir. Discord yöneticileri platform gereği kanal izinlerini aşabilir; bot yönetilen seslerde bağlantısız üyeleri ayırır. Kategoride en fazla 50 kanal olabilir; diğer mevcut kanallar korunur.

Bot yalnız Discord sesine bağlı kişileri taşıyabilir. Maç başlarken katılımcılar mevcut seslerinden taşınır. Sonrasında sistemin seslerindeki takım değişimleri, ölüm ve diriltmeler en fazla yaklaşık 5 saniyede izlenir. Sesten ayrılan oyuncu tekrar Takım Geçiş'e girdiğinde güncel durumuna yönlendirilir. Maçta olmayan bağlı kullanıcı girişte bekler. Son maç/plan bitince yalnız sistemin oluşturduğu kanallar kaldırılır. Köprü koparsa kanallar korunur ve eski durumla yönlendirme yapılmaz.

## Duyurular

Temiz başlıklar kullanılır; TEST ön eki yoktur. Gerçek plan duyurusu `@everyone` gönderir. Planı duyurulmuş başlangıç ikinci ping üretmez; plansız başlangıç ping üretir. Maç içi faz/MVP/sonuç/host bildirimi toplu etiket göndermez. Gerçek test olayları da toplu etiket göndermez. DM içerikleri kendi kullanıcı mention izinlerini kullanır.

## Derleme ve geri dönüş

`python3 plugin-patch/build.py BASE.jar dist/NautilusUHC-1.2.7-voice-admin.jar --java-bin JDK21/bin --api-dir SERVER_API_LIBRARIES`

Sunucudaki gerçek Paper/Leaf API ve Adventure/Gson bağımlılıkları derlemede kullanılır, JAR'a katılmaz. Araç değiştirilmeyen girişleri birebir karşılaştırır. Tek NautilusUHC JAR'ı kullanılmalıdır. Geri dönüşte sunucu durdurulup yedek 1.2.6 JAR'ı geri konur; mevcut DB korunur. Yeni kişisel tercih dosyası eski sürümce yok sayılır. Bot değişikliklerini de geri almak gerekirse Git commit'i geri alınabilir.
