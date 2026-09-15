import com.nautilus.discordlink.LinkScope;
import com.nautilus.discordlink.LinkService;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Kod kapsamı sözleşmesi. Vektörler bot tarafındaki test/linkrouting.test.js ile
 * birebir aynıdır; plugin ile bot kapsamı farklı hesaplarsa doğrulama yanlış
 * sunucuya değil hiçbir sunucuya gitmez, bu yüzden iki taraf ayrıca kilitlenir.
 */
public final class LinkScopeTest {
    public static void main(String[] args) throws Exception {
        Map<String, String> vectors = new LinkedHashMap<>();
        vectors.put("", "6S");
        vectors.put("mc-live", "9D");
        vectors.put("mc-canli", "ZX");
        vectors.put("mc-test", "4S");
        vectors.put("auto-1a2b3c4d", "RP");
        vectors.put("Türkçe-İd", "EG");
        vectors.put("mc-b", "UN");
        vectors.put("mc-a-559", "UN");
        vectors.forEach((id, scope) -> LinkTestEnv.require(LinkScope.of(id).equals(scope),
                "kapsam vektörü tutmadı: " + id + " → " + LinkScope.of(id) + " (beklenen " + scope + ")"));
        LinkTestEnv.require(LinkScope.of("  mc-live ").equals("9D"), "instance kimliği kırpılarak hesaplanmalı");

        LinkTestEnv.require(LinkScope.isScoped("9DK7QX4M"), "8 karakterli geçerli kod kapsamlı sayılmalı");
        LinkTestEnv.require(!LinkScope.isScoped("K7QX4M"), "6 karakterli eski kod kapsamlı sayılmamalı");
        LinkTestEnv.require(!LinkScope.isScoped("9DK7QX4O"), "alfabede olmayan karakter kapsamlı sayılmamalı");
        LinkTestEnv.require(!LinkScope.isScoped("9dk7qx4m"), "isScoped normalize edilmiş kod bekler");

        try (LinkTestEnv env = new LinkTestEnv("scope")) {
            LinkService links = env.service();
            UUID player = UUID.randomUUID();
            LinkService.PendingCode code = links.issueCode(player, "OyuncuKapsam", "mc-live");
            LinkTestEnv.require(code.code().startsWith("9D") && LinkScope.isScoped(code.code()),
                    "üretilen kod instance kapsamını taşımalı: " + code.code());
            LinkService.VerifyResult result = links.verify(
                    "  " + code.code().toLowerCase(Locale.ROOT) + " ", "424242424242424242", "kapsam#0");
            LinkTestEnv.require(result instanceof LinkService.VerifyResult.Linked,
                    "trim + büyük harf normalizasyonu kapsamlı kodda da çalışmalı: " + result);
        }
        System.out.println("PASS LinkScopeTest");
    }
}
