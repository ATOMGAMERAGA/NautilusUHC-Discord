# Şifre alanının yazarken temizlenmesi — 1.2.11

Durum: düzeltme derlendi ve test edildi; **canlıda etkin değil**. Kullanıcının
talebi doğrultusunda MC sunucusuna restart/reload uygulanmadı ve aktif JAR
değiştirilmedi. Discord botunun kodunda değişiklik yoktur.

## Neden ve düzeltme

`AuthManager.recoverLoginUi`, giriş yapmamış oyuncuların konum/bakış
değişikliklerinde `LoginUiState.clientActivity` çağırıyor. Eski metot, form
gösterildikten bir saniye sonra gelen bu etkinlikte açık formu geçersizleştiriyordu.
`begin` ardından yeni bir dialog gönderiyordu; istemci yeni formu boş alanlarla
açıyor, önceki formun gönderim revizyonu da geçersiz oluyordu. Dialog açıkken
hareket/bakış paketi gönderen istemciler bu hatayı tetikleyebiliyor.

1.2.11, hareket/bakış paketlerinden açık formun kapandığı sonucunu çıkarmıyor.
İlk ekranın açılması, eksik istemci-hazır bildiriminin kurtarılması, gerçek dünya
ve kaynak paketi geçişleri, teleport bekleme koşulları ve açık komut/etkileşim
üzerinden ekran kurtarma korunuyor. Şifre doğrulama ve oturum kodu değiştirilmedi.

## Doğrulama

- Yeni `LoginUiStateTest`, mevcut 1.2.10 JAR'ına karşı beklenen nedenle başarısız:
  `Movement/look activity requested a replacement password dialog at 5000ms`.
- Yeni 1.2.11 JAR'ına karşı bütün **22 Java test sınıfı geçti**. Yeni testin altı
  senaryosu; yazma sırasında formun korunmasını, eksik ilk yükleme bildirimini,
  dünya geçişini, birden fazla kaynak paketini, teleport ve tekrar gönderim
  korumasını kapsıyor.
- İki arşivin içerik karşılaştırmasında yalnızca `LoginUiState.class` ve
  `plugin.yml` değişti. `AuthManager` dahil diğer bütün girişler bayt bayt aynı;
  eklenen/silinen arşiv girişi yok.
- Ayrı, salt-okunur kod incelemesinde ek bulgu yok.
- Etkilenen gerçek istemcide görsel doğrulama henüz yapılmadı. Testler doğrudan
  JAR içindeki gerçek UI durum sınıfını çalıştırıyor; canlı oyun testi yapılmadı.

Derleme bağımlılıklarının ve test araçlarının kullanımı için
[`plugin-patch/README.md`](../plugin-patch/README.md) dosyasına bakın. Kullanılan
komutlar (JDK 21 ve gerçek sunucu API bağımlılıklarıyla):

```bash
python3 plugin-patch/build.py dist/NautilusUHC-1.2.10-readiness.jar \
  dist/NautilusUHC-1.2.11-auth-ui.jar \
  --java-bin /tmp/java-21-openjdk-amd64/bin --api-dir /tmp/nautilus-api --version 1.2.11
python3 plugin-patch/test.py dist/NautilusUHC-1.2.11-auth-ui.jar \
  --java-bin /tmp/java-21-openjdk-amd64/bin --api-dir /tmp/nautilus-api
```

## Hazır dosya ve canlı durum

- Çıktı: `dist/NautilusUHC-1.2.11-auth-ui.jar`.
- SHA-256: `3e5e6beb66a6a71432861c054a7f278715835dd2404ecb71d77622385f95143f`.
- MC'de yalnız hazırlık kopyası:
  `/root/nautilus/auth-ui-fix-2026-10-17/NautilusUHC-1.2.11-auth-ui.jar`.
- Aktif plugin hâlâ `NautilusUHC-1.2.10-readiness.jar`; SHA-256:
  `cb85055ec8fdba7f2671959a360e119e9c8a251bb29f6b0c1d1c4f54173bf773`.

Hazırlık kopyası `plugins/` dışında olduğundan kendiliğinden yüklenmez. Canlı
uygulama daha sonra izin verilen bir bakım zamanında yapılmalıdır. Yeniden
başlatma veya hot-reload bu çalışma kapsamında uygulanmadı.
