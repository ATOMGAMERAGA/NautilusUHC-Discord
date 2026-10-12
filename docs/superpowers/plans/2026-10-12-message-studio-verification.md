# Message studio verification — 2026-10-12

Implementation completed from `be5673f247e4d1fd5427369ec8822cb3394439d2` on
`feat/admin-message-studio`.

## Checks

- Full `npm test`, Node22.21.1 with real better-sqlite3; Java integration enabled
  through `NAUTILUS_LINK_IT_JAVA` and `NAUTILUS_LINK_IT_CLASSPATH`: **359 passed,
  zero failures, zero skips**. Includes real bot HTTP bridge ↔ patched JAR + SQLite.
- `npm run check`: all JavaScript modules parse successfully.
- `python plugin-patch/test.py dist/NautilusUHC-1.2.9-message-studio.jar
  --java-bin /tmp/nautilus-jdk/bin --api-dir /tmp/nautilus-api`: **17 Java test
  classes passed** against the built JAR, real Paper1.21.11 API, Java21.
- `git diff --check`: clean.
- JAR CRC, duplicate-entry and removed-entry checks: clean. Base match manager and
  existing FFA cleanup remain byte-identical. Build verifies unchanged entries.
- SHA256: `5d8e73870d18110048678cc79c6b11e53a868bb810599589c748d9167fae7bf3`.

## Fresh review and fixes

- Independent reviewer found a pending future-epoch context surviving an empty
  countdown. Regression reproduced incorrect next-match host/prize/mentions;
  countdown completion now synchronously clears abandoned context. RED→GREEN;
  full Java and bot/integration suites passed afterward.
- Simultaneous self-test clicks could acknowledge before locking and produce two
  DMs. Regression reproduced `sent=2`; lock now acquired before acknowledgment.
  RED→GREEN; whole suite passed afterward. No deferred findings.

## Decisions

- User delegated customization details and then explicitly instructed work to
  begin; implementation continued without additional design approval rounds.
- Existing repo was cloned into this task workspace; a feature branch provides
  isolation. No main-branch merge or live deployment performed.
- Templates contain message data only; loading cannot change recipient selection
  or test mode. Default normal DM audience is self.
- Everyone/here mentions are separate message content because Discord embeds
  cannot send those notification pings. New switches default off.
- `no_fire` and `veinminer` bridge keys render as requested `Fire Resistance` and
  `Vein Miner`; enabled scenarios remain determined by the plugin.
- Node24's locally installed native SQLite addon crashed in unrelated test files.
  Verification used the production Docker runtime family Node22 and rebuilt the
  existing driver locally; package.json/lockfile and production dependencies did
  not change.

Live Discord interaction delivery and a running Paper GUI smoke test were not
performed. Self-only commands and install steps are in `docs/MESSAGE-STUDIO.md`.
