# Match Management Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session.

**Goal:** Deliver the requested match, team and voice features in the bot and patched JAR.
**Architecture:** An authenticated reverse-bridge snapshot supplies linked players and authoritative UHC state. A persistent Discord reconciler owns channel IDs. Minecraft GUI and Discord panel share validated team operations.
**Tech Stack:** Java 21, Paper/Leaf 1.21.11 API, discord.js 14, Node 22.
**Spec:** docs/superpowers/specs/2026-10-07-match-management-design.md

## Global Constraints
- Voice category 1522215362857406654; Turkish channel names.
- Preserve original JAR entries outside explicit replacement classes.
- Never print tokens; never use public match events for live testing.
- Execute inline; push completed bot changes and monitor Dokploy.

## Review Focus
- Bridge outage must preserve channels without using stale assignments.
- Renumbered teams must follow authoritative snapshot.
- Unlink must revoke entry permission and remove access to managed voices.
- Duplicate plan/start events must not double ping.
- Personal preferences survive quit and restart; stale date must recover.

### Task 1: Voice reconciliation
Files: src/voicecore.js, src/voice.js, src/index.js; test/voice.test.js.
Interfaces: GET /api/voice -> {enabled,active,matchKey,teams,links:[{discordId,uuid,participant,alive,team}]}; createVoiceManager dependency injection.
- [x] Write and run failing routing, ordering, lifecycle, outage and unlink tests.
- [x] Implement locked channel reconciliation with persistent IDs and serialized polling.
- [x] Run voice tests and bot suite.

### Task 2: JAR management services
Files: plugin-patch/src/com/nautilus/admin/*, scenarios/*, bridge/FeatureBridge.java, BridgePoller.java; plugin-patch/build.py.
Interfaces: GET /api/teamadmin and POST /api/teamadmin authenticate through the existing reverse bridge; body {action,player,team,size,actor}.
- [x] Write failing team-capacity and damage policy tests.
- [x] Implement snapshot, team GUI and validated mutations; patch personal defaults and immediate launch.
- [x] Compile against real API; run policy tests; compare unchanged archive entries.

### Task 3: Discord management and announcements
Files: src/commands/teamadmin.js, src/teamadmin.js, src/components.js, src/mcapi.js, src/httpserver.js; announcement tests.
- [x] Write failing clean-title and announcement ping tests.
- [x] Add admin-only panel with per-interaction checks, edit dialogs and explicit confirmation for destructive actions.
- [x] Update announcement and DM mention behavior; run full suite.

### Task 4: Delivery
- [ ] Review full diff, check bot and JAR.
- [ ] Commit/push to GitHub, deploy through Dokploy and inspect health/logs.
- [ ] Return downloadable JAR and exact runtime limitations.

## Verification record
- 2026-10-07: npm test: 291 passed, 0 failed, 6 existing integration skips (297 tests total).
- Node syntax checks passed. Java policy, UUID preference persistence and launch announcement association tests passed.
- JAR: 23 patched classes, 618 unchanged entries verified byte-for-byte.
- Independent review fixed stale team confirmations/navigation, large roster truncation and planned-start association.
- Execution ruling: user already authorized GitHub updates and Dokploy monitoring; integrate directly into deployment branch main after verification.
