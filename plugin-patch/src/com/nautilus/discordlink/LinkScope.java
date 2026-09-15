package com.nautilus.discordlink;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Bağlantı kodunun hangi köprü instance'ı tarafından üretildiğini taşıyan kapsam.
 *
 * Kod biçimi: 2 karakter kapsam + 6 karakter güvenli rastgele = 8 karakter.
 * Kapsam instance kimliğinden türetilir; bot aynı hesabı yaparak doğrulamayı
 * yalnız kodu üreten instance'a gönderir. Kapsam kod SAHİPLİĞİNİ kanıtlamaz —
 * sahiplik yalnız o instance'ın kalıcı deposundaki özetle kanıtlanır. Kapsam
 * yalnız isteğin başka bağımsız bir depoya hiç gitmemesini sağlar.
 */
public final class LinkScope {
    public static final String ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    public static final int SCOPE_LENGTH = 2;
    public static final int RANDOM_LENGTH = 6;
    public static final int LEGACY_CODE_LENGTH = RANDOM_LENGTH;
    public static final int SCOPED_CODE_LENGTH = SCOPE_LENGTH + RANDOM_LENGTH;
    private static final String DOMAIN = "nautilus-link-scope-v1:";

    private LinkScope() {
    }

    /** Instance kimliğinin 2 karakterlik kapsamı (bot: src/linkrouting.js ile birebir). */
    public static String of(String instanceId) {
        String id = instanceId == null ? "" : instanceId.trim();
        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-256")
                    .digest((DOMAIN + id).getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 kullanılamıyor", impossible);
        }
        int value = ((digest[0] & 0xff) << 8) | (digest[1] & 0xff);
        return new String(new char[] {
                ALPHABET.charAt((value >>> 11) & 31),
                ALPHABET.charAt((value >>> 6) & 31)
        });
    }

    /** Normalize edilmiş kod kapsamlı (8 karakter, geçerli alfabe) mi? */
    public static boolean isScoped(String normalizedCode) {
        return normalizedCode != null
                && normalizedCode.length() == SCOPED_CODE_LENGTH
                && inAlphabet(normalizedCode);
    }

    static boolean inAlphabet(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (ALPHABET.indexOf(value.charAt(i)) < 0) return false;
        }
        return true;
    }
}
