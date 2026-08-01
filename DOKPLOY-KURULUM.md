# NautilusUHC Discord Botu — Dokploy Kurulum Rehberi

> Güncel Dokploy arayüzüne göre (2026). Bot bu repodaki `Dockerfile` ile
> deploy edilir; kategori olarak **Application** seçilir (Compose DEĞİL,
> Database DEĞİL — tek konteynerli Dockerfile projesi).

## 0) Önce mimariyi anla — "ters köprü"

Eskiden Minecraft sunucusunda elle bir port açılırdı (Pelican'da ek
allocation, `bridge.port` = 25000) ve bot ile site **oraya** bağlanırdı. O port
internete açık olduğu için doğrudan bir **DDoS hedefiydi**; artık kapalıdır.

Yeni düzende bağlantı yönü **terstir** ve **bot tek public giriş noktasıdır**:

```
plugin  --(dışa HTTPS)-->  bot        POST /api/event            (maç duyuruları)
plugin  --(dışa HTTPS)-->  bot        GET  /api/bridge/jobs      (uzun-yoklama, iş çeker)
plugin  --(dışa HTTPS)-->  bot        POST /api/bridge/jobs/result (sonucu yollar)
site    --(HTTPS)------->  bot        GET  /api/v1/stats/*       (token'sız, salt-okunur)
```

Sonuçları:
- Minecraft sunucusunda **hiçbir port açılmaz**; Pelican'da ek allocation
  GEREKMEZ. Plugin köprüsü yalnız `127.0.0.1` üzerinde dinler.
- Slash komutları (`/mcban`, `/maç bilgi` …) MC verisine bu iş kuyruğu
  üzerinden ulaşır; `MC_API_URL` artık **gerekmez**.
- Site de veriyi bottan alır → **botun alan adı artık zorunludur**, çünkü hem
  plugin hem site ona bağlıdır.

## 1) Servisi oluştur

1. Dokploy panelinde projene gir → sağ üstten **Create Service**.
2. Açılan seçeneklerden **Application** seç (Template/Compose/Database değil).
3. Ad ver: `nautilus-bot` → Create.

## 2) Kaynak (General sekmesi)

1. **Provider**: GitHub (repoyu bağladıysan) veya Git.
2. Repository: `NautilusUHC-Discord`, Branch: `main`.
3. **Build Type**: **Dockerfile** seç. Docker File Path: `./Dockerfile`
   (repo kökünde). Nixpacks/Buildpacks SEÇME — Dockerfile hazır.

## 3) Environment sekmesi (env değişkenleri)

`g` + `e` kısayoluyla ya da **Environment** sekmesinden, aşağıdakileri yapıştır
(değerleri kendine göre doldur; `.env.example` ile birebir aynı isimler):

```env
# ZORUNLU
DISCORD_TOKEN=BURAYA_BOT_TOKEN
BRIDGE_SECRET=plugin_config_bridge_token_ile_AYNI_uzun_rastgele_deger

# ESKİ / OPSİYONEL — ters köprüde BOŞ BIRAK.
# Yalnız plugin ters köprüye bağlı DEĞİLKEN kullanılan doğrudan bağlantı
# yedeğidir; MC portu artık kapalı olduğu için normalde doldurulmaz.
MC_API_URL=

# OPSIYONEL (varsayilanlar koda gomulu)
PORT=25000
DB_PATH=data/bot.db
GUILD_ID=1521979737201836233
MATCH_CHANNEL_ID=1522216307809063154
LINK_CHANNEL_ID=1522335045593858228
LOG_CHANNEL_ID=
```

Notlar:
- **`MC_API_URL` artık BOŞ olmalı.** Bot, plugin uzun-yoklama yaptığı sürece
  (`bridgeQueue.pluginConnected()`) her isteği ters köprü kuyruğuna koyar ve bu
  değişkene hiç bakmaz. Dolu bırakırsan yalnızca plugin köprüye bağlı değilken
  devreye giren **eski doğrudan bağlantı** yedeği olur — MC portu kapalıysa bu
  da başarısız olur. Plugin bağlı değilken kullanıcı temiz bir Türkçe hata
  görür: "Minecraft sunucusu köprüye bağlı değil."
- `PORT` = botun konteyner içinde dinlediği port (varsayılan **25000**). Bunu
  Dokploy'da domaine bağlayacaksın; MC tarafının köprü portuyla ilgisi yoktur.
- `BRIDGE_SECRET` plugin'deki `bridge.token` ile birebir aynı olmalı — hem
  `/api/event` hem de `/api/bridge/jobs*` uçlarının HMAC doğrulaması bunu
  kullanır.
- Çok satırlı değer gerekirse çift tırnakla sarılır (Dokploy kuralı).

## 4) Kalıcı veri (Advanced → Volumes)

Bot SQLite kullanır; redeploy'da silinmemesi için:

1. **Advanced** sekmesi (`g` + `a`) → **Volumes** → Add Volume.
2. Tür: **Volume Mount** · Name: `nautilus-bot-data` · Mount Path: `/app/data`.

## 5) Domain (ZORUNLU — tek public giriş noktası)

Bot artık **hem plugin'in hem de sitenin** bağlandığı tek adrestir, bu yüzden
HTTPS'li bir alan adı **zorunludur** (eskiden "A yolu ya da B yolu" seçeneği
vardı; artık domain yolu tek geçerli kurulumdur):

1. **Domains** sekmesi → **Add Domain**.
2. Host: `bot.nautilusuhc.com` · **Container Port: 25000** · **HTTPS: açık**
   (Let's Encrypt). Traefik yönlendirir, ayrıca **Advanced → Ports** açmana
   gerek yoktur.

Bu adres iki yerde birden kullanılır:

| Nerede | Değer |
|---|---|
| Plugin `config.yml` | `bridge.bot-url: https://bot.nautilusuhc.com` |
| Site env (`NautilusUHC-Site`) | `MC_STATS_API=https://bot.nautilusuhc.com` |

> **Neden geçerli sertifika şart?** Plugin bota Java `HttpClient` ile bağlanır ve
> TLS'i doğrular. Self-signed / eksik zincirli sertifikada loglarda
> `PKIX path building failed` görürsün. Kalıcı çözüm geçerli (Let's Encrypt)
> sertifikadır; geçici olarak plugin'de `bridge.ca-cert` ile PEM dosyasının
> yolunu tanıtabilirsin.

## 6) Plugin tarafı — `config.yml` (ZORUNLU)

`NautilusUHC/plugins/NautilusUHC/config.yml` içinde `bridge:` bölümü aynen
şöyle olmalı (Pelican'da **allocation açma**):

```yaml
bridge:
  enabled: true                 # köprü sunucusu + ters köprü açılır
  mode: outbound                # plugin bota KENDİ bağlanır (önerilen/varsayılan)
  bind: 127.0.0.1               # köprü yalnız konteyner içinden erişilebilir
  port: 25000                   # SADECE konteyner içi; panelde port ayırma
  token: "BOTUN_BRIDGE_SECRET_DEGERI_ILE_BIREBIR_AYNI"
  bot-url: "https://bot.nautilusuhc.com"   # BOŞ BIRAKMA — bkz. Sorun giderme
  public-stats:
    enabled: true               # siteyi besleyen token'sız salt-okunur API
    base-path: "/api/v1/stats"
    cors: "*"
```

Sunucuyu yeniden başlattığında konsolda şunu görmelisin:

```
Ters köprü etkin: https://bot.nautilusuhc.com adresine dışa bağlanılıyor (panelde ek port GEREKMEZ).
Köprü eventleri etkin → https://bot.nautilusuhc.com
```

> `mode: listen` eski davranıştır (köprü portu `0.0.0.0`'a açılır, bot/site
> doğrudan bağlanır). Port internetten görülebildiği için DDoS'a açıktır;
> yalnız güvenlik duvarı arkasındaki özel kurulumlarda kullan.

## 7) Deploy ve doğrulama

1. **Deploy** butonuna bas; **Deployments** sekmesinden build'i izle.
2. **Logs** sekmesinde şunu görmelisin: `[bot] NN slash komutu kaydedildi.`
3. Sağlık kontrolü: `https://bot.nautilusuhc.com/health`.
4. Discord'da `/ping` ve `/komutlar` dene.
5. Minecraft sunucusunu başlat, konsolda "Ters köprü etkin: …" satırını gör.
6. Ters köprünün gerçekten veri taşıdığını doğrula — Discord'da `/sağlık`
   çalıştır ya da siteyi besleyen ucu dene:

   ```bash
   curl "https://bot.nautilusuhc.com/api/v1/stats/leaderboard?topN=5"
   ```
   JSON dönerse zincir tamam. `503 mc_unavailable` dönerse plugin köprüye bağlı
   değildir (bkz. Sorun giderme).
7. Minecraft'ta `/testhost durum` ile köprüyü test et (gerçek duyuru atmaz).

## 8) Otomatik deploy (opsiyonel)

**Deployments** sekmesindeki webhook URL'sini GitHub repo → Settings →
Webhooks'a ekle; `main`'e her push'ta Dokploy yeniden deploy eder.

## Sorun giderme

| Belirti | Sırayla kontrol et |
|---|---|
| **Discord'a maç mesajı gitmiyor** | **1.** Plugin `config.yml → bridge.bot-url` BOŞ mu? Bu, canlıda yaşanan gerçek arızanın kök nedeniydi: değer boşken plugin köprüyü sessizce devre dışı bırakıyor ve logda **tek bir satır bile** yazmıyordu. Artık açılışta `KÖPRÜ EKSİK AYAR: bridge.bot-url BOŞ.` diye **SEVERE** satırı basar — MC konsolunda bunu ara. **2.** `bridge.enabled: true` mi? **3.** `bridge.token` ile botun `BRIDGE_SECRET`'ı birebir aynı mı (token boşsa ayrıca SEVERE basılır)? **4.** Domain HTTPS'i çalışıyor mu (`curl https://bot.nautilusuhc.com/health`)? |
| Bot açılmıyor + `[config] Eksik ortam değişkeni: DISCORD_TOKEN` | Environment sekmesindeki değişkenleri kontrol et, Redeploy. |
| MC konsolunda `Ters köprü bota ulaşamıyor (…)` | Bot ayakta mı, domain doğru mu, TLS geçerli mi? Plugin artan beklemeyle (1→30 sn) kendi kendine yeniden dener; bağlantı dönünce `Ters köprü bağlantısı geri geldi.` yazar. |
| MC konsolunda `PKIX path building failed` / sertifika hatası | `bridge.bot-url` TLS sertifikası doğrulanamıyor. Bot domainine geçerli (Let's Encrypt) sertifika bağla ya da geçici olarak `bridge.ca-cert` ile PEM yolunu tanıt. |
| MC konsolunda `Ters köprü kapalı: bridge.enabled false` | Köprü sunucusu kapalı. `bridge.enabled: true` yapıp sunucuyu yeniden başlat. |
| Slash komutları "Minecraft sunucusu köprüye bağlı değil" diyor | Plugin uzun-yoklama yapmıyor. Yukarıdaki köprü satırlarını kontrol et; MC sunucusu kapalıysa bu mesaj normaldir. |
| Site boş / `503 mc_unavailable` | Plugin'de `bridge.public-stats.enabled: true` mi, ters köprü bağlı mı? Sitedeki `MC_STATS_API` **botun** alan adını mı gösteriyor (MC IP'si DEĞİL)? |
| `better-sqlite3` derleme hatası | Dockerfile `node:22-bookworm-slim` tabanlıdır ve `npm install` sırasında prebuilt binary indirir; build makinesinin internete çıktığından emin ol. |
