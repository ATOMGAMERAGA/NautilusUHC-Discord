# NautilusUHC-DC — Nautilus PvP Discord Botu

Nautilus PvP (nautilusuhc.com) sunucusunun resmî Discord botu. Discord moderasyonu,
sunucu güvenliği (patlama koruması) ve **NautilusUHC Minecraft plugini ile tam çift
yönlü entegrasyon** içerir.

- Durum: **"nautilusuhc.com oynuyor"**
- Bot **yalnızca** Nautilus PvP sunucusunda çalışır — başka bir sunucuya eklenirse
  anında ayrılır (sunucu kilidi).

## Özellikler

### Discord moderasyonu
`/ban` `/unban` `/kick` `/mute` `/unmute` `/uyar` `/uyarılar` `/uyarısil`
`/softban` `/nick` `/not ekle|liste|sil` `/lockdown başlat|bitir`
`/sil [kullanıcı] [bot] [içerik]` `/kilit` `/yavaşmod` `/rolver` `/rolal`

- Tüm cezalar SQLite'ta kayıt altına alınır (case sistemi) ve log kanalına düşer.
- Yetki kademeleri rollere bağlıdır: **Kurucu > Admin > Baş Mod > Mod > Rehber**.
  Kurucu her şeye erişir; kimse kendisiyle aynı/üst kademedeki birine işlem yapamaz.
- **`/softban`** — yasaklayıp anında kaldırır (son N günün mesajlarını temizler).
- **`/nick`** — takma ad değiştirir/sıfırlar. **`/not`** — kullanıcı hakkında
  yalnız yetkililerin gördüğü kalıcı notlar. **`/lockdown`** — acil durumda tüm
  metin kanallarını tek komutla kilitler/açar (yalnız kendi kilitlediklerini geri açar).
- **Uyarı eskalasyonu:** `/admin uyarıeşiği` ile N uyarıda otomatik timeout,
  M uyarıda otomatik ban ayarlanabilir; `/uyar` eşiği aşınca yaptırımı kendisi uygular.
- **Raid koruması:** `/admin raidkoruma` — katılım-hızı alarmı + minimum hesap
  yaşı kapısı (kick veya yalnız log).
- **`/sicil`** artık sayfalıdır (◀/▶ butonları, sayfa başı 10 kayıt).

### Minecraft moderasyonu (Discord'dan)
`/mcban` `/mcunban` `/mcmute` `/mcunmute` `/mckick` `/mcuyar` `/mconline` `/mcdurum`
`/sunucuperf` `/mcsicil <oyuncu>` `/mcbanlist` `/mcmutelist`

Bu komutlar plugin köprü API'sine gider; oyun içi ban/mute sistemiyle aynı kayıtları
kullanır (süreli cezalar desteklenir: `10dk`, `2sa`, `7g`). `/mcsicil` oyuncunun
kalıcı ceza geçmişini, `/mcbanlist`/`/mcmutelist` aktif cezaları, `/sunucuperf`
TPS/MSPT/bellek/uptime'ı gösterir. Oyun içi ceza/rapor/faz olayları köprü
üzerinden bota gelir (`staff_channel`/`rank_channel` ile yönlendirilir).

### Maç sistemi
- Host oyun içinden maç planlayınca/başlatınca bot **maç kanalına** ayarları içeren
  embed atar (saat TR dilimindedir, ayrıca Discord'un yerel zaman etiketi kullanılır).
- Maç bitince kazanan, süre, katılımcı sayısı ve en çok kill alanlar aynı kanala düşer.
- `/maç bilgi` — aktif maç durumu • `/maç program` — günün 3 maç saati (14:00/16:00/20:00 TR)
- `/maç geçmiş` `/maç detay <no>` — maç arşivi
- `/maç envanter <no> <oyuncu>` — **snapshot sisteminden** oyuncunun ölüm/bitiş anındaki
  envanterini (zırh, hotbar, çanta, ender sandığı, can/açlık/seviye) ayrıntılı gösterir. (Yetkili)
- `/testhost` (oyun içi) akışı TEST etiketli embed'lerle aynı kanala düşer.

### Hesap bağlama (MC ↔ Discord)
- Maça katılmak (host olmak dahil) için hesap bağlama **zorunludur**.
- `/admin dclinkgönder` → bot, link kanalına **Hesap Bağla** butonlu paneli atar.
- Oyuncu oyun içinde `/link` yazar → tıklayınca kopyalanan tek kullanımlık kod alır →
  butona tıklayıp kodu girer → hesaplar bağlanır.
- Zaten bağlıysa `/link` hangi hesapla bağlı olduğunu söyler ve değişiklik için destek
  talebi açmasını ister.
- `/kayıtsil mc <oyuncu>` veya `/kayıtsil dc <@kullanıcı>` ile yetkililer kaydı siler
  (aynı komut oyun içinde de vardır).

### Güvenlik
- **Patlama koruması (anti-nuke):** kısa sürede toplu kanal/rol silme-oluşturma, toplu
  ban/kick, webhook oluşturma → failin tüm rolleri alınır, Kurucu etiketlenerek loglanır.
  Kurucu muaftır. İzinsiz eklenen botlar anında atılır. `/admin koruma aç|kapat|durum`
- **Automod:** spam (5 sn'de 6+ mesaj), yabancı davet linki, toplu etiket → sil + kısa mute.
- **Loglar:** mesaj silme/düzenleme, üye giriş/çıkış, tüm moderasyon işlemleri.
  Log kanalı: `/admin logkanal #kanal`

### Oyuncu profilleri & ELO rank sistemi
- `/profil [oyuncu|@kullanıcı]` — **skin görselli** profil embed'i: ELO + rank kademesi,
  zirve ELO, ladder sırası (#X / toplam), oynanan/kazanılan maç ve galibiyet oranı,
  kill/ölüm/KD, galibiyet serileri, bağlı Discord hesabı ve aktif MC cezaları.
  Parametresiz kullanınca kendi bağlı hesabını gösterir.
- `/sıralama elo|galibiyet|kill` — ilk 10 liderlik tablosu (rank kademeleriyle).
- **Ayarlanabilir rank kademeleri:** `/admin elorank liste|ekle|sil|sıfırla` —
  varsayılan merdiven (plugin EloTier ile birebir): 🟤 Bakır → ⚙️ Demir (1200)
  → 🥇 Altın (1400) → 🟢 Zümrüt (1600) → 💎 Elmas (1800) → ⬛ Netherite (2000).
- **ELO tier → Discord rol senkronu:** `/admin elorank rolkur` 6 tier rolünü
  uygun renklerle (bakır/demir/altın/zümrüt/elmas/netherite tonları) **otomatik
  oluşturur**; `/admin elorank rol <tier> <@rol>` ile elle eşlenebilir. Oyuncunun
  ELO kümesi değişince (plugin `tier_change` eventi) veya hesap bağlanınca rol
  otomatik verilir/alınır; `/admin elorank senkron` bağlı tüm hesaplara toplu uygular.
  Botun rolü tier rollerinin üstünde olmalı; yönetilen/üst roller güvenle atlanır.
- `/sicil @kullanıcı` — botun uyguladığı tüm işlemlerin geçmişi (case kaydı, sayfalı).

### Canlı maç panosu, takımlar & durum panosu
- `/maç canlı` — **Yenile** butonlu canlı maç panosu (faz, süre, hayatta,
  border, senaryolar, hayatta kalanlar).
- `/takımlar` — aktif maçın takım kadroları (hayatta/çevrimdışı bayraklarıyla).
- `/sıra` — maç katılım kuyruğu. `/senaryolar` — tüm UHC senaryoları + aktifler.
- **Oto durum panosu:** `/admin durumkanal #kanal` — bot o kanalda ~60 sn'de bir
  güncellenen sabit bir durum embed'i tutar (sunucu/maç/performans) ve presence'ını
  canlı tutar (maç varsa `⚔️ hayatta/katılımcı — faz`, yoksa oyuncu sayısı).
- **Yeni kanal ayarları:** `/admin staffkanal` (rapor/ceza aynası), `/admin
  rankkanal` (küme değişimi duyuruları), `/admin durumkanal` (durum panosu).

### Süreli ban & kalıcı zamanlayıcı
- `/ban` artık `süre` parametresi alır (`1g`, `12sa`, `1hf`…) — süre dolunca bot
  **otomatik unban** yapar. Zamanlanmış görevler SQLite'ta tutulur, yani bot
  yeniden başlasa bile unban/hatırlatıcı/çekiliş zamanlamaları **kaybolmaz**.

### Destek talebi (ticket) sistemi
- `/admin ticketpanel #kanal` — türe göre select-menu paneli (genel, hesap
  bağlantısı, oyuncu şikâyeti, ceza itirazı, teknik sorun, mağaza/ödeme, diğer).
- Numaralı talepler; yetkili **claim/unclaim**, öncelik (low/normal/high/urgent),
  beklet, not ekle, kullanıcı ekle/çıkar, yeniden aç.
- Kapanışta **tam transcript** (100 mesajla sınırlı değil, tüm mesajlar
  kalıcı depolanır) log kanalına ve açan kişiye DM'lenir; DM'e 1-5 memnuniyet
  puanı butonları eklenir.
- SLA takibi (önceliğe göre ilk yanıt hedefi) ve 48 saat hareketsizlik
  hatırlatması otomatik çalışır. Kanalı silinen talepler restart'ta
  otomatik uzlaştırılır (reconciliation).
- Kara liste: `/destek karaliste ekle|çıkar <kullanıcı>` (Baş Mod+).
- `/destek listele|bilgi|not|ata|öncelik|ekle|çıkar|yenidenaç` — yetkili yönetim komutları.
- Hesap bağlantısı düzeltmeleri ("değişiklik için destek talebi aç") bu akıştan yürür.

### Maç bildirim DM aboneliği
- `/maç-bildirim` — mevcut durumu gösterir, **Aç/Kapat/Vazgeç** butonlarıyla
  onaylı değişiklik yapılır (yalnız komutu kullanan kişiye çalışır, 2 dk TTL).
- Normal maç başlangıcında (test maçları HARİÇ) maçlar kanalındaki duyurunun
  aynısı kişisel DM olarak gelir. DM'i kapalı kullanıcılar diğer aboneleri
  etkilemez; abonelik restartta kalıcıdır.

### Sağlık kontrolü
- `/sağlık` (Rehber+) — bot uptime, DB durumu, plugin köprü erişilebilirliği,
  bekleyen zamanlanmış görev sayısı, açık ticket sayısı, modül aç/kapat durumu.

### Çekiliş, anket, hatırlatıcı
- `/çekiliş başlat <süre> <ödül> [kazanan]` — buton katılımlı; `bitir` ve `yenidençek` ile yönetilir.
- `/anket başlat <soru> <seçenekler;ile;ayrılır> [süre]` — butonlu oylama, canlı sonuç
  çubukları; `bitir` ile sonuç yayınlanır. Oylar kişi başı tektir, değiştirilebilir.
- `/hatırlat <süre> <mesaj>` — süre dolunca seni etiketler (restart'a dayanıklı).

### Sunucu yaşamı
- **Hoş geldin mesajları:** `/admin hoşgeldin #kanal` — üye sayısı + başlangıç rehberi.
- **Rol paneli:** `/admin rolpanel #kanal @rol...` — butonla al/bırak (yetkili roller panelde kullanılamaz).
- **Maç bildirim rolü:** `/admin maçrol @rol` — maç planlandı/başladı duyurularında bu rol
  etiketlenir (rol panelinden aldırılabilir).
- **Automod anahtarı:** `/admin automod aç|kapat`.

### Yardımcı komutlar
`/ping` `/sunucubilgi` `/kullanıcıbilgi` `/avatar` `/yardım`
`/duyuru` (bir kanala normal/embed mesaj) `/embed` (tam embed oluşturucu)

## Kurulum (Coolify)

1. Bu repoyu Coolify'a **Dockerfile** uygulaması olarak ekle.
2. `/app/data` yoluna kalıcı bir **volume** bağla (SQLite verisi).
3. `.env.example` içindeki ortam değişkenlerini ayarla — zorunlular:
   - `DISCORD_TOKEN` — Discord Developer Portal'dan (SERVER MEMBERS + MESSAGE CONTENT
     intent'lerini aç).
   - `BRIDGE_SECRET` — uzun rastgele bir anahtar; plugin `config.yml > bridge.token`
     ile **birebir aynı** olmalı.
   - `MC_API_URL` — Pelican sunucusunun IP'si + plugin köprü portu
     (örn. `http://1.2.3.4:8571`). Pelican'da bu portu **Allocations**'tan ekle.
4. Botun `PORT`'unu (8080) Coolify'da dışarı aç ve domain ver; bu adresi plugin
   `config.yml > bridge.bot-url` alanına yaz.
5. Deploy et. Bot açılışta slash komutlarını otomatik kaydeder.

## Kurulum (Dokploy)

Coolify yerine Dokploy kullanıyorsan akış neredeyse aynıdır:

1. **Projects → Create Project** → içinde **Create Service → Application**.
2. **Provider**: GitHub (private repo `NautilusUHC-Discord`, branch `main`).
3. **Build Type**: **Dockerfile**.
4. **Environment**: `DISCORD_TOKEN`, `BRIDGE_SECRET`, `MC_API_URL` (+ gerekiyorsa
   kanal/rol id'leri). `.env.example`'a bak.
5. **Volumes**: `/app/data` için kalıcı bir volume ekle (SQLite verisi).
6. **Domains**: **Add Domain** → bot domaini, **Container Port** `8080`, HTTPS aç.
   Bu adresi plugin `config.yml > bridge.bot-url` alanına yaz.
7. **Deploy**.

> Site ile birlikte kullanım: sıralama/istatistik web sitesi ayrı bir projedir
> (`../NautilusUHC-Site`) ve plugin'in **token'sız public-stats** API'sini kullanır.
> Bot ise **token'lı** köprüyü kullanır. İkisi aynı veriye bakar; site tarafında
> bot için özel ayar gerekmez. Ayrıntı: [`../NautilusUHC-Site/README.md`](../NautilusUHC-Site/README.md).

### Minecraft tarafı (Pelican Panel)
`NautilusUHC/plugins/NautilusUHC/config.yml`:

```yaml
bridge:
  enabled: true
  port: 8571          # Pelican'da ayrılan ek port
  token: "BRIDGE_SECRET ile aynı"
  bot-url: "https://bot-domainin"  # Coolify'daki bot adresi
```

## Bridge güvenliği (Faz 2)

Köprü artık **HMAC-SHA256** ile imzalanır (`X-Nautilus-Timestamp/Nonce/Signature`),
±300 sn replay penceresi ve nonce tekrar kontrolüyle. Eski `X-Bridge-Secret`
başlığı `BRIDGE_ALLOW_LEGACY=1` (varsayılan) iken geçiş modu olarak hâlâ kabul
edilir. Ayrıntı: [`../docs/INTEGRATION-CONTRACT.md`](../docs/INTEGRATION-CONTRACT.md).

## Geliştirme

```bash
npm install
cp .env.example .env   # değerleri doldur
npm run check          # tüm dosyaların söz dizimini doğrular
npm test               # birim testler (token gerekmez)
npm start
```

Kök dizinden tüm projeleri (plugin + site + bot) tek script ile test etmek için:
`../run-tests.sh bot` — bkz. [`../AGENTS.md`](../AGENTS.md).
