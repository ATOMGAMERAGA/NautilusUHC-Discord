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
`/sil` (toplu mesaj silme) `/kilit` `/yavaşmod` `/rolver` `/rolal`

- Tüm cezalar SQLite'ta kayıt altına alınır (case sistemi) ve log kanalına düşer.
- Yetki kademeleri rollere bağlıdır: **Kurucu > Admin > Baş Mod > Mod > Rehber**.
  Kurucu her şeye erişir; kimse kendisiyle aynı/üst kademedeki birine işlem yapamaz.

### Minecraft moderasyonu (Discord'dan)
`/mcban` `/mcunban` `/mcmute` `/mcunmute` `/mckick` `/mcuyar` `/mconline` `/mcdurum`

Bu komutlar plugin köprü API'sine gider; oyun içi ban/mute sistemiyle aynı kayıtları
kullanır (süreli cezalar desteklenir: `10dk`, `2sa`, `7g`).

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
- `/sicil @kullanıcı` — botun uyguladığı tüm işlemlerin geçmişi (case kaydı).

### Süreli ban & kalıcı zamanlayıcı
- `/ban` artık `süre` parametresi alır (`1g`, `12sa`, `1hf`…) — süre dolunca bot
  **otomatik unban** yapar. Zamanlanmış görevler SQLite'ta tutulur, yani bot
  yeniden başlasa bile unban/hatırlatıcı/çekiliş zamanlamaları **kaybolmaz**.

### Destek talebi (ticket) sistemi
- `/admin ticketpanel #kanal` — butonlu panel; `/admin ticketkategori` ile kategori.
- Buton veya `/destek aç` → yalnızca açan kişi + yetkililerin gördüğü özel kanal.
- `/destek kapat` veya kanal içi buton → kapanışta **transcript** (.txt) log kanalına düşer.
- Hesap bağlantısı düzeltmeleri ("değişiklik için destek talebi aç") bu akıştan yürür.

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
