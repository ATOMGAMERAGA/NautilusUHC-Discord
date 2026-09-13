# Link Code Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `/link` invocation issue a fresh, unique code and make every superseded code immediately invalid across all `LinkService` instances.

**Architecture:** Keep the persisted digest store as the authoritative set of valid pending codes. Issuing a replacement removes every in-memory and persisted pending code for that Minecraft UUID under the existing file lock, and verification must never recreate a code that another instance retired.

**Tech Stack:** Java 21, SQLite-backed `DataStore`, PowerShell JAR patch builder, Node.js test suite.

**Spec:** Current user-approved bounded bug-fix design in this task; no separate specification document.

## Global Constraints

- Use `C:\Users\Atom\Downloads\NautilusUHC-1.2.0.jar` as the immutable upstream base.
- Produce `dist/NautilusUHC-1.2.1-linkfix.jar` with `plugin.yml` version `1.2.1`.
- Never persist raw link codes or Discord IDs.
- Preserve restart recovery, concurrent duplicate verification, and atomic SQLite identity binding.
- Push the verified source change directly to `main`, as requested by the user.

---

### Task 1: Fresh-code issuance and cross-instance revocation

**Files:**
- Create: `plugin-patch/test/LinkServiceRotationTest.java`
- Modify: `plugin-patch/src/com/nautilus/discordlink/LinkService.java`

**Interfaces:**
- Consumes: `LinkService.issueCode(UUID, String)` and `LinkService.verify(String, String, String)`.
- Produces: unchanged public signatures with fresh-code and authoritative-persistence behavior.

- [x] **Step 1: Write the failing regression test**

Add real-`DataStore` scenarios that assert: a stale service cannot verify a code retired by another service, repeated `/link` calls return different codes and invalidate the first, and two UUIDs receive different active codes.

- [x] **Step 2: Run the regression test to verify it fails**

Run Java 21 compilation and `LinkServiceRotationTest` against the unmodified patch source and the supplied 1.2.0 JAR. Expected: failure because a stale instance resurrects the retired code or repeated issuance reuses it.

- [x] **Step 3: Implement the minimal source fix**

Remove the unexpired-code reuse branch, retire raw in-memory codes belonging to the UUID before generation, retain digest collision exclusion, and make verification accept only a digest present in the refreshed persisted store.

- [x] **Step 4: Run focused and existing Java regression tests**

Compile and run `LinkServiceRotationTest` and `LinkServicePersistenceTest`. Expected: both print `PASS`.

### Task 2: Build and verify the 1.2.1 distribution

**Files:**
- Modify: `plugin-patch/build.ps1`
- Modify: `plugin-patch/README.md`
- Create: `dist/NautilusUHC-1.2.1-linkfix.jar`

**Interfaces:**
- Consumes: supplied 1.2.0 upstream JAR plus the patched Java sources.
- Produces: deployable 1.2.1 JAR with upstream 1.2.0 runtime contents preserved outside the patch package; JDK `jar` may normalize the embedded SQLite module descriptor.

- [x] **Step 1: Update release metadata in the build path**

Change the default output filename and embedded `plugin.yml` version to `1.2.1`, and document the new base/output artifacts.

- [x] **Step 2: Build the JAR from the supplied 1.2.0 artifact**

Run `plugin-patch/build.ps1` with the supplied JAR and Java 21 bin directory. Expected: `dist/NautilusUHC-1.2.1-linkfix.jar`.

- [x] **Step 3: Verify the built artifact and the complete repository**

Run both Java regression tests against the built JAR, repeat the rotation test to stress nondeterministic behavior, inspect embedded version/class hashes, run `npm test`, and run `npm run check`.

- [ ] **Step 4: Review, commit, push, and verify the remote commit**

Review the final diff, commit the source/tests/JAR to `main`, push `main`, then confirm `origin/main` resolves to the local commit.
