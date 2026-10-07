import com.nautilus.discordlink.LinkService;
import com.nautilus.discordlink.LinkBridgeApi;
import com.nautilus.discordlink.LinkJson;
import com.nautilus.storage.DataStore;
import java.util.*;
import java.util.concurrent.*;
import java.util.logging.Logger;

/** Real SQLite checks for migration, capacity, versioned unlink, replay and legacy writers. */
public final class LinkTwoAccountsTest {
    private static final String DC = "300000000000000001";
    public static void main(String[] args) throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("two-accounts")) {
            UUID a = UUID.randomUUID(), b = UUID.randomUUID(), c = UUID.randomUUID();
            // Start with the actual legacy UNIQUE schema and a preexisting versioned row.
            env.update("ALTER TABLE discord_links ADD COLUMN link_id TEXT");
            env.update("INSERT INTO discord_links VALUES (?, 'Legacy', ?, 'old', 42, 'preserved-id')", a, DC);
            env.update("ALTER TABLE discord_links ADD COLUMN custom_note TEXT DEFAULT 'kept'");
            env.update("CREATE INDEX custom_links_tag ON discord_links(discord_tag)");
            LinkService links = env.service();
            require(links.recordByUuid(a).orElseThrow().linkId().equals("preserved-id"), "migration preserves version");
            require(env.string("SELECT custom_note FROM discord_links WHERE uuid=?", a).equals("kept"), "migration preserves extra columns/data");
            require(env.string("SELECT name FROM sqlite_master WHERE name='custom_links_tag'") != null, "migration preserves indexes");
            String codeB = links.issueCode(b, "Second").code();
            require(links.verify(codeB, DC, "new") instanceof LinkService.VerifyResult.Linked, "second account must link");
            require(links.recordsByDiscord(DC).size() == 2, "public API returns both records");
            require(links.recordByDiscord(DC).orElseThrow().uuid().equals(a), "deterministic oldest representative");
            String codeC = links.issueCode(c, "Third").code();
            require(links.verify(codeC, DC, "new") instanceof LinkService.VerifyResult.DiscordAlreadyLinked, "third account rejected");
            require(env.number("SELECT COUNT(*) FROM discord_links WHERE discord_id=?", DC) == 2, "capacity two");
            links = env.service();
            require(links.verify(codeB, DC, "new") instanceof LinkService.VerifyResult.Linked, "second receipt survives restart");
            var api = new LinkBridgeApi(links, "mc-test", Logger.getAnonymousLogger());
            var info = LinkJson.parseObject(api.handle("GET", "/api/link/v2/info?discord=" + DC, "").json());
            require(info.get("links") instanceof List<?> list && list.size() == 2, "Discord info exposes both links");
            require(links.unlink(new LinkService.UnlinkRequest(LinkService.Selector.BY_DISCORD, DC, null, List.of(), null, null, null, null)) instanceof LinkService.UnlinkResult.Ambiguous,
                    "unqualified Discord unlink is ambiguous");
            String versionB = links.recordByUuid(b).orElseThrow().linkId();
            require(links.unlink(new LinkService.UnlinkRequest(LinkService.Selector.BY_DISCORD, DC, versionB, List.of(), null, null, null, null)) instanceof LinkService.UnlinkResult.Removed,
                    "Discord version selects second account");
            require(links.recordByUuid(a).orElseThrow().linkId().equals("preserved-id"), "other account unchanged");
            require(links.verify(codeB, DC, "new") instanceof LinkService.VerifyResult.InvalidCode, "removed receipt revoked");
            require(links.verify(codeC, DC, "new") instanceof LinkService.VerifyResult.Linked, "freed slot reusable");
            UUID d = UUID.randomUUID();
            env.store.linkCreate(new DataStore.LinkRow(d, "LegacyThird", DC, "legacy", 99));
            require(links.recordByUuid(d).isEmpty(), "legacy writer cannot bypass capacity");
            env.store.linkCreate(new DataStore.LinkRow(a, "Taken", "400000000000000001", "legacy", 99));
            require(links.recordByUuid(a).orElseThrow().discordId().equals(DC), "owner preserved");
            env.store.close();
            try (DataStore reopened = new DataStore(env.database.toFile(), Logger.getAnonymousLogger())) {
                LinkService restarted = new LinkService(reopened);
                require(restarted.recordsByDiscord(DC).size() == 2, "both accounts survive database reopen");
                require(restarted.recordByUuid(a).orElseThrow().linkId().equals("preserved-id"), "version survives database reopen");
                require(restarted.verify(codeC, DC, "new") instanceof LinkService.VerifyResult.Linked, "remaining receipt survives database reopen");
                require(restarted.verify(codeB, DC, "new") instanceof LinkService.VerifyResult.InvalidCode, "removed receipt stays revoked after database reopen");
            }
        }
        try (LinkTestEnv env = new LinkTestEnv("capacity-race")) {
            LinkService one = env.service(), two = env.service();
            UUID a = UUID.randomUUID(), b = UUID.randomUUID(), c = UUID.randomUUID();
            require(one.verify(one.issueCode(a, "One").code(), DC, "race") instanceof LinkService.VerifyResult.Linked, "first links");
            String cb = one.issueCode(b, "Two").code(), cc = one.issueCode(c, "Three").code();
            CountDownLatch start = new CountDownLatch(1);
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<LinkService.VerifyResult> rb = pool.submit(() -> { start.await(); return one.verify(cb, DC, "race"); });
                Future<LinkService.VerifyResult> rc = pool.submit(() -> { start.await(); return two.verify(cc, DC, "race"); });
                start.countDown();
                var results = List.of(rb.get(), rc.get());
                require(results.stream().filter(r -> r instanceof LinkService.VerifyResult.Linked).count() == 1, "only one concurrent slot winner");
                require(env.number("SELECT COUNT(*) FROM discord_links WHERE discord_id=?", DC) == 2, "race respects capacity");
            } finally { pool.shutdownNow(); }
        }
        System.out.println("PASS LinkTwoAccountsTest");
    }
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
