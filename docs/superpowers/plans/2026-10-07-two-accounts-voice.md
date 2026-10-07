# İki hesap ve ses kontrolü uygulama planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Discord başına iki MC hesabı, tek IP oturumu ve global ses/spam kontrolü.
**Architecture:** LinkStoreAccess şeması ve LinkService işlemleri çoklu Discord ilişkisini destekler. Ses köprüsü online durumunu sağlar; bot tek online hesaba yönlendirir ve süreli giriş engelini kalıcı kayıtla yönetir. Ana-thread Minecraft login listener IP oturumunu atomik rezerve eder.
**Tech Stack:** Java21/Paper, SQLite, Node22/discord.js.
**Spec:** docs/superpowers/specs/2026-10-07-two-accounts-voice-design.md

## Global Constraints
- Discord iki hesap, UUID tek Discord.
- Global ses 1522216892658614272; giriş kategorisi 1522215362857406654.
- Onuncu giriş / kayan60s; engel60s. Bot hareketleri sayılmaz.
- Mevcut kayıt/izinler korunur; API kesilince stale yönlendirme yoktur.

## Review Focus
- İki eşzamanlı link isteği üçüncü hesaba yol açmamalı.
- Bir UUID kaldırılırken diğer hesap ve eski kod güvenliği korunmalı.
- İki login arasında online kaydı oluşmadan IP rezervasyonu çalışmalı.
- Restart, engelin sonlanmasını veya eski member izinlerini kaybettirmemeli.
- Bot taşımaları gateway'de gecikmeli geldiğinde spam sayılmamalı.

### Task1: Çoklu link
- [x] LinkStoreAccess/LinkService/LinkBridgeApi ve bot link UI/readback/effects güncelle; gerçek SQLite testleriyle iki başarılı ve üçüncü reddedilen hesap, restart, unlink, replay ve legacy migration doğrula.
### Task2: IP oturumu
- [x] SingleIpSessions ve SingleIpListener ekle, AdminBootstrap'a kayıt yap. Atomik claim/release ve başarısız giriş testi yaz; actual API ile derle.
### Task3: Ses
- [x] FeatureBridge online ekle; voicecore çevrimiçi seçim ve global fallback; VoiceEntryGuard kayan pencere/persisted overwrite expiry ekle. Bot hareketi, timeout/restart/online değişimi testleri yaz.
### Task4: Teslim
- [ ] Yeni JAR derle ve Java/Node suite çalıştır. Bağımsız review bulgularını düzelt. GitHub push, Dokploy sağlık/komut kaydı, MC yedek/deploy ve JAR linki.

## Doğrulama kaydı

Gerçek 1.2.8 JAR + Java/SQLite HTTP köprüsüyle Node328/328PASS, sıfır atlanan test. JAR üzerinde11Java test grubu PASS. Gerçek MC DB kopyasındaki46bağlantı, epoch ve olay kayıtları birebir korundu; SQLite integrity_check başarılı. Bağımsız incelemede bulunan süre bitiminde yeni giriş sayacının kaybolması düzeltildi ve regresyon testi eklendi. Canlı MC oyuncusuz/maçsız durumda yedekle1.2.8'e yükseltildi; açılış ve canlı şema geçişi doğrulandı. GitHub/Dokploy dağıtımı bu commit'in ardından izlenecek.
