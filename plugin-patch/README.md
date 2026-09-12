# NautilusUHC link-code patch

Bu klasör, dağıtılan `NautilusUHC-1.1.0-linkfix-b1.jar` içindeki
`com.nautilus.discordlink.LinkService` sınıfının kaynak ve regresyon testini
tutar.

Düzeltme, bekleyen `/link` kodlarının yalnız JVM belleğinde tutulması nedeniyle
plugin reload/restart sonrasında doğru kodların `invalid_code` olmasını önler.
Ham kod yerine SHA-256 özeti, oyuncu UUID'si, adı ve son kullanma zamanı
`plugins/NautilusUHC/pending-link-codes.dat` dosyasına atomik olarak yazılır.
Kod başarıyla kullanıldığında kayıt silinir; tek kullanımlık davranış korunur.

JDK 21 ile dağıtım JAR'ını üretmek için:

```powershell
.\plugin-patch\build.ps1 -InputJar C:\path\NautilusUHC-1.1.0-linkfix-b1.jar
```

Çıktı varsayılan olarak `dist/NautilusUHC-1.1.1-linkfix.jar` olur. Derleme,
JAR içindeki `plugin.yml` sürümünü `1.1.1` yapar ve ilk kurulum
`config.yml` dosyasına gerçek bir bridge token gömülmesini engeller.
