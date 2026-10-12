# Message Studio Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the main implementation; independently owned Java and announcement tasks use superpowers:dispatching-parallel-agents. Steps use checkbox syntax.

**Goal:** Özelleştirilebilir mesaj paneli ve plugin ile uyumlu yeni maç bildirimleri teslim et.
**Architecture:** Saf mesaj üreticisi + SQLite şablon deposu + süreli özel Discord paneli.
Java tarafında mevcut kaynak yamaları JAR'a uygulanır; köprüye eklemeli alanlar gelir.
**Tech Stack:** Node >=20, discord.js 14, SQLite; Java21, Paper1.21.11.
**Spec:** `docs/superpowers/specs/2026-10-12-message-studio-design.md`

## Global Constraints

- Her adminin her sunucuda en fazla 5 kalıcı şablonu vardır.
- Test teslimatı yalnız komutu kullanan kişinin DM'ine gider.
- Kullanıcının %etiket% yer tutucusu alıcıya göre değiştirilir.
- En fazla 25 embed alanı, 5 URL butonu; FFA/To2/To3, maksimum 3.
- Köprü mevcut method ve event adlarını korur; canlı bot başlatılmaz.

## Review Focus

- Yüklenen şablon test modunu veya hedefleri değiştiremez.
- Hedef üyeler fetch edilemezse kısmi cache'e toplu gönderim yapılmaz.
- Aynı onay veya değiştirilmiş taslak çift gönderim üretemez.
- Yer tutucu genişlemesi Discord sınırını aşarsa gönderim başlamaz.
- Planlanan maçın ödülü sonraki host değişiklikleriyle değişmez.

### Task 1: Message model, storage and delivery

Files: `src/messagecore.js`, `src/messagetemplates.js`, `src/messagedelivery.js`, `test/messagestudio.test.js`.
Produces: `renderMessage(draft, recipient, context) -> payload`, `validateDraft(draft)`,
`messageTemplates.list/save/remove(guildId, ownerId, ...)`, `deliverMessage(options)`.
- [x] Write tests for recipient placeholders, complete embeds/buttons, limits, isolated five-template persistence, test target isolation and delivery failures.
- [x] Run `node --test test/messagestudio.test.js`; observe missing feature failures.
- [x] Implement core and persistence with existing `getSetting/setSetting`.
- [x] Run focused tests, then `npm test`; commit with complete delivery.

### Task 2: Private studio UI and commands

Files: `src/messagestudio.js`, `src/components.js`, `src/commands/admin.js`, `test/messagepanel.test.js`.
Consumes Task1 payloads and templates. Produces `openMessageStudio(interaction, options)` and `handleMessageStudio(interaction)`.
- [x] Write interaction tests for owner/tier/TTL, test mode loading, frozen confirmations, duplicate clicks and actual slash serialization.
- [x] Observe failures; implement modal/select/button flows, DM target selection and channel editor.
- [x] Register `/admin dm`, `/admin macmesajtest`, and adapt `/embed` to panel.
- [x] Run focused tests, full suite, syntax checks; commit with complete delivery.

### Task 3: Match embed rendering (independent worker)

Files: `src/matchannouncements.js`, `src/httpserver.js`, announcement tests.
Produces `sampleMatchAnnouncements(hostDiscordId, options) -> [{type,payload}]`.
- [x] Update tests to requested copy/date/prize/mentions and observe failures.
- [x] Implement shared production/test renderer and backward-compatible data fallback.
- [x] Run focused and full tests. Root reviews; commit with complete delivery.

### Task 4: Plugin panels and event metadata (independent worker)

Files: `plugin-patch/src`, Java tests, build tools; `dist/NautilusUHC-1.2.9-message-studio.jar`.
Produces bridge fields `prize`, `mentionEveryone`, `mentionHere`, `hostDiscordId`, `host`, `teamSize`, `scenarios`.
- [x] Write and run failing persistence/context/team tests.
- [x] Implement immutable per-plan/active-match metadata, FFA and notification panel controls.
- [x] Build against real Paper API/JDK21 and supplied JAR. Verify unrelated entries byte-identical.
- [x] Run Java tests; root reviews; commit with complete delivery.

### Task 5: Integration, documentation and delivery

- [x] Verify full bot suite, real Discord payload serialization, Java suites and JAR integrity.
- [x] Fresh code review of whole branch; fix material findings and retest.
- [ ] Write usage/installation guide, commit, push feature branch and return downloadable JAR.
