package com.nautilus.auth;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** In-memory IP reservations, including connections which have not joined yet. */
public final class SingleIpSessions {
    private final Map<String, Claim> owners = new HashMap<>();

    /** Identity is the session generation; UUID alone is unsafe after a reconnect. */
    public static final class Claim {
        private final String address;
        private final UUID player;

        private Claim(String address, UUID player) {
            this.address = address;
            this.player = player;
        }
    }

    public synchronized Claim claim(InetAddress address, UUID player) {
        Objects.requireNonNull(player, "player");
        String key = normalize(address);
        if (owners.containsKey(key)) return null;
        Claim claim = new Claim(key, player);
        owners.put(key, claim);
        return claim;
    }

    public synchronized boolean release(Claim claim) {
        if (claim == null || owners.get(claim.address) != claim) return false;
        owners.remove(claim.address);
        return true;
    }

    private static String normalize(InetAddress address) {
        byte[] bytes = Objects.requireNonNull(address, "address").getAddress();
        // Treat IPv4-mapped IPv6 as the same host as native IPv4. Address bytes
        // also ignore IPv6 formatting and interface scope, without DNS lookup.
        if (bytes.length == 16) {
            boolean mapped = bytes[10] == (byte) 0xff && bytes[11] == (byte) 0xff;
            for (int i = 0; i < 10 && mapped; i++) mapped = bytes[i] == 0;
            if (mapped) bytes = Arrays.copyOfRange(bytes, 12, 16);
        }
        return HexFormat.of().formatHex(bytes);
    }
}
