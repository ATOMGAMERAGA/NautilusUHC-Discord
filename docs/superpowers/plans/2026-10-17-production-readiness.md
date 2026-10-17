# NautilusUHC Production Readiness Implementation Plan

**Goal:** Fix demonstrated voice and team-management defects and produce evidence for a safe UHC launch.
**Architecture:** Preserve existing bridge/API and match state. Isolate per-member Discord failures, reconcile actual owned permissions, use gateway cache with bounded discovery and targeted fetch. Add report-only preflight; rebuild verified patched JAR separately.
**Spec:** docs/readiness-request-2026-10-17.md
**Constraints:** No live deployment, match start/stop, player movement, secret rotation or database reset. Baseline d01ead02fde07af466a271e5e3828febdbf4a13c; input JAR SHA-256 5d8e73870d18110048678cc79c6b11e53a868bb810599589c748d9167fae7bf3. Existing working APIs and state remain compatible.
**Execution:** Parallel independent Java, bridge/contracts and preflight tasks; primary implements voice orchestration. User's explicit instruction to perform minimal fixes and tests supersedes additional workflow approval gates.

## Review focus

User API failure versus configuration failure; stale gateway/cache evidence; role access versus Administrator bypass; category capacity during old/new team overlap; in-flight movement during match change.

- [x] Baseline: npm ci, npm run check, npm test; run Java test runner against input JAR. Record dependency/environment limitations separately.
- [x] Voice: failing tests for role/move 403/429 isolation and safe retry, actual permission drift and unchanged no-op, target fetch on cache miss, category transition, concurrent movement/cleanup. Implement src/voice.js minimally and validate existing demo/entry scenarios.
- [x] Bridge: validate complete voice authority without breaking legacy optional fields; prove duplicate-instance and outage/recovery behavior; isolate spam permission failures.
- [x] Java: inspect actual 1.2.9 lifecycle and TeamManager; prove/fix To4 inconsistency across commands/GUIs; build 1.2.10 artifact and verify class inclusion and archive preservation.
- [x] Preflight: pure report-only evaluator plus safe CLI; distinguish PASS/FAIL/UNVERIFIED and cover listed runtime requirements with tests.
- [x] Integrate: full Node/Java checks; independent review; Turkish A–F readiness report with GO decision, live manual checks, deployment/rollback evidence. Push review branch only; never production branch/deploy.
