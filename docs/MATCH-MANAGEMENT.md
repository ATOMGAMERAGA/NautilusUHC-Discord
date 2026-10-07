# Maç ve takım yönetimi — 1.2.8

Bot ve JAR birlikte kullanılmalıdır. JAR tabanı kullanıcının gönderdiği 1.2.6-fixes dosyasıdır; yalnız ilgili sınıflar ve metadata yenilenmiştir.

## Kullanım

- Minecraft `/uhcadmin`: ana ekrandan **Hemen maç başlat**. Kişisel takım/senaryo/dünya/duyuru/tarih-saat ayarları UUID'ye göre `plugins/NautilusUHC/host-preferences.properties` dosyasında saklanır. Ayar ekranında **Hemen başlat** veya **Maçı planla** seçilebilir. Hemen başlat, uzun plan/geri sayım beklemez; güvenli hazırlık ve dağıtım devam eder.
- Minecraft ve Discord `/teamadmin`: takım listesi, oluşturma, oyuncu taşıma, Solo yapma, dağıtma, boyut, rastgele dağıtım ve temizleme. Toplu sıfırlama/boyut değişimi maç sırasında kapalıdır. Oyun GUI'si `nautilus.host` ve giriş doğrulaması, Discord paneli Admin/üstü ister. Eski takım numaralarına işlem uygulanmaz; değişiklik olmuşsa panel yenilenmelidir.
- **Ateşten Korunma** (`no_fire`): senaryo seçimine eklendi. Maç oyuncularını ateş, yanma, lav ve sıcak blok hasarından korur.

## Discord sesleri

Kategori `1522215362857406654`. Aktif veya planlanmış maç varsa **Takım Geçiş**, numara sıralı **Takım N**, **Solo**, **İzleyici** oluşturulur. Giriş yalnız bağlı hesaplara açılır. Hedef kanallara kullanıcı kendisi bağlanamaz; bot taşır. Kanal kimlikleri bot DB'sinde saklanır. Rol **UHC • Hesabı Bağlı** bot tarafından yönetilir; botun rolü bunun üzerinde olmalıdır.

Botta **Kanalları Yönet**, **Rolleri Yönet**, **Üyeleri Taşı**, **Bağlan** izinleri ve GuildVoiceStates intent'i gerekir. Discord yöneticileri platform gereği kanal izinlerini aşabilir; bot yönetilen seslerde bağlantısız üyeleri ayırır. Kategoride en fazla 50 kanal olabilir; diğer mevcut kanallar korunur.

Bot yalnız Discord sesine bağlı kişileri taşıyabilir. Maç başlarken katılımcılar mevcut seslerinden taşınır. Sonrasında sistemin seslerindeki takım değişimleri, ölüm ve diriltmeler en fazla yaklaşık 5 saniyede izlenir. Sesten ayrılan oyuncu tekrar Takım Geçiş'e girdiğinde güncel durumuna yönlendirilir. Minecraft hesabı çevrimdışı olan veya aktif maçta katılımcı olmayan bağlı kullanıcı **Global Ses** (`1522216892658614272`) kanalına gider. İki hesabı bağlı kullanıcı o anda çevrimiçi hesabına göre yönlendirilir; maç katılımcısı olan çevrimiçi hesap önceliklidir. Son maç/plan bitince kullanıcılar global sese taşınır ve yalnız sistemin oluşturduğu kanallar kaldırılır. Köprü koparsa kanallar korunur ve eski durumla yönlendirme yapılmaz.

## Hesaplar ve giriş sınırları

Bir Discord hesabına iki Minecraft hesabı bağlanabilir. Her Minecraft UUID'si yalnız bir Discord'a bağlıdır; üçüncü MC hesabı reddedilir. Discord `/link` ve yönetici `/linkbilgi` iki hesabı gösterir. Bir hesabı kaldırmak diğerini etkilemez. İki hesaplı kullanıcıdan bağlantı kaldırılırken MC adı/UUID'si seçilmelidir; Discord ID ile belirsiz kaldırma işlem yapmaz. Eski tek kullanımlık kod, replay ve unlink sürüm korumaları devam eder.

Minecraft sunucusunda aynı IP'den aynı anda tek oyuncu bulunabilir. Giriş sırasında IP rezerve edilir; diğer oyuncu lobi dahil girişte reddedilir. Çıkış/başarısız giriş rezervasyonu bırakır. IP kayıtları kalıcı saklanmaz.

Takım Geçiş'e bir dakikalık kayan pencerede onuncu giriş, o kullanıcıya bir dakikalık giriş engeli verir ve kullanıcıyı global sese taşır. Botun taşımaları sayılmaz; engellenmiş tekrar denemeler süreyi uzatmaz. Engel ve önceki kişisel Bağlan izni DB'de saklanır, bot restart'ından sonra korunur. Süre bitince izin otomatik eski haline döner. Global Ses ve sunucudaki diğer sesler bu engelle kilitlenmez.

## Ses testi

Discord `/testses` Admin/üstü içindir ve aktif/planlanmış maç yokken çalışır. Minecraft hesabı bağlı olmalıdır. Bot aynı kategoride kilitli **Takım Geçiş**, **Takım 1**, **Solo**, **İzleyici** kanallarını hazırlar. Seste bulunuyorsan girişe taşır; seste değilsen 60 saniye içinde Takım Geçiş'e girmen gerekir. İki saniye sonra Takım 1'e, iki saniye sonra Solo'ya, iki saniye sonra İzleyici'ye taşır. Son iki saniyenin ardından önceki sesine döndürür (önceden seste değilsen bağlantını keser) ve geçici kanalları temizler. Sesten ayrılınca test durur. Test sırasında maç planlanır/başlarsa gerçek maç yönetimi devralır. Aynı anda tek ses testi çalışır.

## Duyurular

Temiz başlıklar kullanılır; TEST ön eki yoktur. Gerçek plan duyurusu `@everyone` gönderir. Planı duyurulmuş başlangıç ikinci ping üretmez; plansız başlangıç ping üretir. Maç içi faz/MVP/sonuç/host bildirimi toplu etiket göndermez. Gerçek test olayları da toplu etiket göndermez. DM içerikleri kendi kullanıcı mention izinlerini kullanır.

## Derleme ve geri dönüş

`python3 plugin-patch/build.py BASE.jar dist/NautilusUHC-1.2.8-accounts-voice.jar --java-bin JDK21/bin --api-dir SERVER_API_LIBRARIES`

Sunucudaki gerçek Paper/Leaf API ve Adventure/Gson bağımlılıkları derlemede kullanılır, JAR'a katılmaz. Araç değiştirilmeyen girişleri birebir karşılaştırır. Tek NautilusUHC JAR'ı kullanılmalıdır. 1.2.8 veritabanında Discord ID tekillik sınırı kaldırılır ve iki hesap sınırı eklenir. Eski sürüme geri dönüşte sunucu durdurulup güncelleme öncesi JAR ve DB yedeği birlikte geri konmalıdır; sonradan yapılan bağlantı değişiklikleri bu yedekte bulunmaz. Yeni kişisel tercih dosyası eski sürümce yok sayılır. Bot değişikliklerini de geri almak gerekirse Git commit'i geri alınabilir.
