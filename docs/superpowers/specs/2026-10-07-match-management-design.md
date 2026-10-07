# Maç yönetimi ve Discord ses sistemi

Kullanıcının talebi: verilen 1.2.6 JAR'ı doğrudan yamalamak, bitmiş JAR sunmak; botu GitHub'a göndermek ve Panel'deki Dokploy dağıtımını izlemek. MC incelemesi ssh mc ile yapılır. Uygulama bu sohbet içinde yürütülür; rutin tercihler kullanıcı tarafından geliştiriciye bırakılmıştır.

## Ses
Kategori 1522215362857406654. Planlanmış veya aktif UHC varsa Takım Geçiş, Solo, İzleyici ve numara sırasıyla Takım N kanalları oluşturulur. Giriş yalnız hesabı bağlı üyelere açılır; hedefler Connect açısından üyeye kilitli kalır. Bot yalnız seste bulunanları taşıyabilir. Maç başlarken katılımcılar mevcut seslerinden taşınır; sonraki takım/ölüm/diriltme değişimleri yönetilen kanallardaki üyeleri günceller. Giriş kanalına yeniden katılım mevcut duruma yönlendirir. Maça katılmayan bağlı üye girişte bekler. Kopuk köprüde son durum kullanılmaz ve kanallar silinmez. Yeniden başlatma kanal kimliklerini kalıcı DB'den kurtarır. Yalnız oluşturulan kanallar temizlenir; gelecekte plan varsa korunur. Kategori başına Discord 50 kanal sınırı denetlenir.

## Oyun yönetimi
/uhcadmin ana ekranda hızlı başlatma; ayar ekranından aynı takım/senaryo/dünya tercihi ile hemen başlatma. Tercihler oyuncu UUID'sine göre atomik dosyada saklanır. Eski tarihler yeniden açıldığında ileri alınır. No Fire ateş, yanma, lav ve sıcak blok hasarını maç oyuncuları için kapatır. /teamadmin oyun GUI'si ve Discord /teamadmin paneli aynı doğrulamalı servisi kullanır: liste, oluştur, taşı, çıkar, dağıt, boyut, rastgele dağıt, tümünü temizle. Kapasite ve değişmiş takım kontrolü gerekir. Büyük toplu işlemler maç sürerken engellenir, oyuncu taşıması kullanılabilir.

## Duyuru ve teslim
Maç başlıklarında TEST yok. Normal plan duyurusu @everyone; plansız başlangıç @everyone. Planlı başlangıç ikinci ping üretmez. Diğer olaylar hiçbir toplu etiket göndermez, test işaretli olaylar ping üretmez. DM üreticisi toplu etiketi taşımamalı. Verilen JAR'ın değiştirilmeyen girdileri birebir korunur. Java 21 ve sunucunun gerçek API JAR'ları ile derlenir. Test, JAR bütünlüğü, bot sağlığı ve Dokploy logları doğrulanır.
