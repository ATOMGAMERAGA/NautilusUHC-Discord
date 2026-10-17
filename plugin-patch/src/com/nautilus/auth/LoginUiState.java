/*
 * Decompiled with CFR 0.152.
 */
package com.nautilus.auth;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

final class LoginUiState {
    private final long joinedAt;
    private final Set<UUID> loadingPacks = new HashSet<UUID>();
    private boolean clientReady;
    private boolean lobbyReady;
    private boolean teleporting;
    private boolean shown;
    private long readyAfter;
    private long revision;
    private long shownAt;

    LoginUiState(long l, boolean bl) {
        this.joinedAt = l;
        this.clientReady = bl;
        this.readyAfter = l + 150L;
    }

    void clientLoaded(long l) {
        if (!this.clientReady) {
            this.clientReady = true;
            this.readyAfter = Math.max(this.readyAfter, l + 150L);
        }
        if (this.shown) {
            this.invalidate(l, 150L);
        }
    }

    void allowMissingLoadEvent(long l) {
        if (!this.clientReady && l - this.joinedAt >= 3000L) {
            this.clientLoaded(l);
        }
    }

    boolean clientActivity(long l) {
        if (!this.clientReady) {
            this.clientLoaded(l);
        }
        // Movement/look packets are not evidence that the dialog was closed.
        // Reopening it while the user types replaces the inputs with empty ones.
        // Actual world/pack transitions and explicit recovery still invalidate it.
        return !this.shown;
    }

    void resourcePackStarted(UUID uUID, long l) {
        this.loadingPacks.add(uUID);
        this.invalidate(l, 250L);
    }

    void resourcePackFinished(UUID uUID, long l) {
        this.loadingPacks.remove(uUID);
        this.invalidate(l, 250L);
    }

    boolean canAdvance(long l) {
        return this.clientReady && this.loadingPacks.isEmpty() && !this.teleporting && l >= this.readyAfter;
    }

    boolean needsLobbyTeleport() {
        return !this.lobbyReady;
    }

    void startTeleport() {
        this.teleporting = true;
        this.shown = false;
        ++this.revision;
    }

    void finishTeleport(long l, boolean bl) {
        this.teleporting = false;
        this.lobbyReady = bl;
        this.invalidate(l, 250L);
    }

    void worldChanged(long l) {
        this.invalidate(l, 250L);
    }

    boolean isShown() {
        return this.shown;
    }

    long markShown() {
        this.shown = true;
        this.shownAt = System.currentTimeMillis();
        return ++this.revision;
    }

    boolean acceptSubmission(long l) {
        if (!this.shown || this.revision != l) {
            return false;
        }
        this.shown = false;
        ++this.revision;
        return true;
    }

    void invalidate(long l, long l2) {
        this.shown = false;
        ++this.revision;
        this.readyAfter = Math.max(this.readyAfter, l + l2);
    }
}
