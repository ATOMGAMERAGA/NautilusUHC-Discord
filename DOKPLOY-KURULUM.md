# NautilusUHC Discord Botu — Dokploy Kurulum Rehberi

> Güncel Dokploy arayüzüne göre (2026). Bot bu repodaki `Dockerfile` ile
> deploy edilir; kategori olarak **Application** seçilir (Compose DEĞİL,
> Database DEĞİL — tek konteynerli Dockerfile projesi).

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
MC_API_URL=http://MINECRAFT_SUNUCU_IP:25000

# OPSIYONEL (varsayilanlar koda gomulu)
PORT=25000
DB_PATH=data/bot.db
GUILD_ID=1521979737201836233
MATCH_CHANNEL_ID=1522216307809063154
LINK_CHANNEL_ID=1522335045593858228
LOG_CHANNEL_ID=
```

Notlar:
- `MC_API_URL` = Pelican'daki Minecraft sunucusunun IP'si + plugin köprü portu
  (plugin `config.yml → bridge.port`, varsayılan **25000**). Yol ekleme.
- `BRIDGE_SECRET` plugin'deki `bridge.token` ile birebir aynı olmalı.
- Çok satırlı değer gerekirse çift tırnakla sarılır (Dokploy kuralı).

## 4) Kalıcı veri (Advanced → Volumes)

Bot SQLite kullanır; redeploy'da silinmemesi için:

1. **Advanced** sekmesi (`g` + `a`) → **Volumes** → Add Volume.
2. Tür: **Volume Mount** · Name: `nautilus-bot-data` · Mount Path: `/app/data`.

## 5) Port / erişim (plugin → bot eventleri)

Plugin, bota `POST /api/event` atar; botun 25000 portuna dışarıdan erişim gerekir.
İki yol var — birini seç:

- **A. Domain (önerilen):** **Domains** sekmesi → Add Domain →
  Host: `bot.nautilusuhc.com`, **Container Port: 25000**, HTTPS: açık
  (Let's Encrypt). Plugin tarafında `bridge.bot-url: https://bot.nautilusuhc.com`.
- **B. Doğrudan port:** **Advanced → Ports** → Add Port:
  Published Port `25000`, Target Port `25000`, Protocol TCP. Plugin tarafında
  `bridge.bot-url: http://DOKPLOY_SUNUCU_IP:25000`. (Sunucu güvenlik
  duvarında 25000/TCP'yi açmayı unutma.)

Domain kullanıyorsan Ports adımı gerekmez (Traefik yönlendirir).

## 6) Deploy ve doğrulama

1. **Deploy** butonuna bas; **Deployments** sekmesinden build'i izle.
2. **Logs** sekmesinde şunu görmelisin: `[bot] NN slash komutu kaydedildi.`
3. Sağlık kontrolü: `https://bot.nautilusuhc.com/health` (veya `http://IP:25000/health`).
4. Discord'da `/ping` ve `/komutlar` dene.
5. Minecraft'ta `/testhost durum` ile köprüyü test et (gerçek duyuru atmaz).

## 7) Otomatik deploy (opsiyonel)

**Deployments** sekmesindeki webhook URL'sini GitHub repo → Settings →
Webhooks'a ekle; `main`'e her push'ta Dokploy yeniden deploy eder.

## Sorun giderme

- Bot açılmıyor + `[config] Eksik ortam değişkeni: DISCORD_TOKEN` → Environment
  sekmesindeki değişkenleri kontrol et, Redeploy.
- Plugin eventleri düşmüyor → `BRIDGE_SECRET` eşleşmesi, `bridge.bot-url`
  doğruluğu ve 25000 erişimi (yol A/B) sırayla kontrol.
- `better-sqlite3` derleme hatası görürsen: Dockerfile `node:22-bookworm-slim`
  tabanlıdır ve `npm install` sırasında prebuilt binary indirir; build makinesinin
  internete çıktığından emin ol.
