# 17 Ekim 2026 — onay sonrası canlı dağıtım

Kullanıcının açık canlıya alma onayı sonrasında PR #6 birleştirildi. Bot ve Minecraft plugin güncel; ayrıca dosya yüklemek veya kurulum yapmak gerekmiyor.

- GitHub main merge: `5a02b41145e4451b41b62d16076d3b360e104014`.
- Dokploy application: `3ZhnQJkaeCyfjkaX_aR0y`; deployment: `7qubflnP0NtQ8F3oY_Rx1`, **done**. Üretim bot dosyaları GitHub kaynağıyla hash üzerinden eşleştirildi.
- MC: `NautilusUHC v1.2.10` ve `LibertyBans v1.1.4` açılışı doğrulandı; başlangıç21,6sn, son ölçüm20 TPS.
- JAR SHA-256: `cb85055ec8fdba7f2671959a360e119e9c8a251bb29f6b0c1d1c4f54173bf773`.
- Yeni bot runtime: Node22.23.3, Discord.js14.27.0. `/health` bot=true; gerçek outbound `/api/voice` yanıtları200 ve tek kalıcı instance `auto-92b3c1cc` gözlendi.

## Gerçek Discord testi

Üretim guild'inde SDK/REST/Gateway kullanıldı; hareket ettirilen tek hesap **bot hesabıydı**. Ayrı geçici SQLite ve ayrı kanal registry'si kullanıldı; gerçek Minecraft maçı açılmadı, plan/duyuru/@everyone gönderilmedi. Oyun durumları kontrollü sentetik snapshot'lardı; bu test gerçek Minecraft ölüm/scatter/PvP motoru testi değildir.

18 kontrol geçti: gerçek `/testses` manager akışı; linked/unlinked izin politikası; manuel overwrite sapması ve onarımı; team1→spectator→team1→team2→solo→global; iki hesapta online katılımcının seçimi; manager yeniden oluşturulunca gerçek kanal ID'lerinin korunması; köprü outage sırasında silmeme; recovery sonrası en güncel hedef; bitişte yalnız test-owned kanalların temizlenmesi; botun sesten ayrılması; önceden mevcut kanalların korunması.

Toplam9 geçici kanal ve1 geçici rol oluşturulup temizlendi;17 gerçek Gateway voice geçişi gözlendi. Ham secretsiz kanıt: [deployment-live-voice-evidence.json](deployment-live-voice-evidence.json).

## Kalıcı veriler ve yedekler

MC config dosyası ve takım/auth kayıtları değişmedi. Önce/sonra satır sayıları aynı: players2128, matches114, discord_links55, match_participants502, inventories392. Veritabanları sıfırlanmadı; oyuncu envanter ve takım kayıtları korunuyor.

Panel yedekleri: `/root/NautilusUHC/deployment-2026-10-17/`; bot imaj etiketi `nautilusuhc-bot:rollback-20261017`; bot SQLite tutarlı snapshot'ı ve private service config yedeği var. MC yedekleri: `/root/nautilus/deployment-2026-10-17/`; önceki1.2.9 JAR ve plugin-data-before. Private config/DB yedekleri GitHub'a eklenmedi.

## Son durum ve sınır

**CONDITIONAL GO:** Güncelleme canlı ve hizmet kontrolleri sağlıklı; kontrollü bot ses testi geçti. Tam insan oyunculu UHC maçı, seçilecek dünyanın hazır olması ve gerçek maçtaki tüm fazlar uçtan uca denenmedi. Bu sonuç%100 sorunsuzluk veya belirli büyük maç için koşulsuzGO değildir. Maç kapasitesi için önceki80 oyuncu hedefi geçerli tahmindir; bu dağıtımda yük testi tekrarlanmadı.
