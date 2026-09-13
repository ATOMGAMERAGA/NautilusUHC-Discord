# NautilusUHC link-code patch

Bu klasör, dağıtılan `NautilusUHC-1.2.0.jar` için hazırlanan
`com.nautilus.discordlink.LinkService` ve hata yutmayan atomik bağlantı
yardımcısının kaynaklarını ve regresyon testini tutar.

Düzeltme, bekleyen `/link` kodlarının yalnız JVM belleğinde tutulması nedeniyle
plugin reload/restart sonrasında doğru kodların `invalid_code` olmasını önler.
Ham kod yerine SHA-256 özeti, oyuncu UUID'si, adı ve son kullanma zamanı
`plugins/NautilusUHC/pending-link-codes.dat` dosyasına atomik olarak yazılır.
Her işlem dosyayı kilit altında yeniden okuduğundan eski bir servis örneği de
yeni kodu görebilir. Başarılı kullanım, kodu ve Discord kimliğini açık metin
saklamayan süreli bir makbuza dönüşür: aynı Discord hesabından yinelenen teslim
başarı döndürür, başka bir hesapta kullanılamaz.
SQLite bağlantısı transaction içinde `INSERT OR IGNORE` ile kurulur; yarım
kalmış bir doğrulama sonradan başka bir Discord hesabının mevcut Minecraft
bağlantısını ezmesine izin vermez. Kayıp/bozuk kod deposu veya DB erişim hatası
da `invalid_code` olarak maskelenmez.

Her `/link` çağrısı artık aynı oyuncunun önceki bekleyen kodunu hem bellekten
hem kalıcı özet deposundan iptal edip yeni bir kod üretir. Doğrulama yalnız
kilit altında yenilenmiş kalıcı özet deposunu kabul eder; eski bir servis
örneğinde kalmış ham kod yeniden geçerli hâle gelemez. Aktif kodlar farklı
oyuncular arasında da çakışma denetiminden geçer.

JDK 21 ile dağıtım JAR'ını üretmek için:

```powershell
.\plugin-patch\build.ps1 -InputJar C:\path\NautilusUHC-1.2.0.jar
```

Çıktı varsayılan olarak `dist/NautilusUHC-1.2.1-linkfix.jar` olur. Derleme,
JAR içindeki `plugin.yml` sürümünü `1.2.1` yapar ve ilk kurulum
`config.yml` dosyasına gerçek bir bridge token gömülmesini engeller.
