package com.nautilus.discordlink;

import com.nautilus.stats.EloTier;

import java.math.BigDecimal;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * Hesap bağlama köprü API'si (protokol 2).
 *
 * Bukkit'e bağımlı değildir: BridgePoller ters köprü işlerini doğrudan buraya
 * yönlendirir; Java testleri ve bot entegrasyon harness'ı aynı sınıfı gerçek
 * SQLite ile sürer. Her yanıt yanıtlayan instance kimliğini taşır; bot bunu
 * hedeflediği instance ile karşılaştırır.
 *
 * Loglara ham kod, bridge secret veya Authorization başlığı yazılmaz.
 */
public final class LinkBridgeApi {
    public static final int PROTOCOL_VERSION = 2;
    private static final String V2_PREFIX = "/api/link/v2/";
    private static final Pattern DISCORD_ID = Pattern.compile("[0-9]{1,20}");
    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9_.:-]{1,64}");
    private static final int MAX_PAGE = 25;

    public record Response(int status, String json) { }

    private final LinkService links;
    private final String instanceId;
    private final Logger logger;

    public LinkBridgeApi(LinkService links, String instanceId, Logger logger) {
        this.links = links;
        this.instanceId = instanceId;
        this.logger = logger == null ? Logger.getLogger("NautilusUHC-Link") : logger;
    }

    /** Bu API'nin yanıtladığı yollar (protokol 2 + ters köprüde 1.2.1 uyumlu link uçları). */
    public static boolean handles(String method, String path) {
        String p = pathOnly(path);
        String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        return p.startsWith(V2_PREFIX)
                || ("GET".equals(m) && "/api/link/status".equals(p))
                || ("POST".equals(m) && "/api/link/verify".equals(p))
                || ("DELETE".equals(m) && "/api/link".equals(p));
    }

    public Response handle(String method, String pathWithQuery, String body) {
        String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        String p = pathOnly(pathWithQuery);
        Map<String, String> query = query(pathWithQuery);
        String requestId = null;
        long started = System.nanoTime();
        try {
            Map<String, Object> json = ("POST".equals(m) || "DELETE".equals(m))
                    ? LinkJson.parseObject(body)
                    : Map.of();
            requestId = requestId(json, query);
            if (p.startsWith(V2_PREFIX)) {
                String endpoint = m + " " + p.substring(V2_PREFIX.length());
                return switch (endpoint) {
                    case "POST probe" -> probe(json, requestId);
                    case "POST verify" -> verify(json, requestId, false, started);
                    case "GET operation" -> operation(query, requestId);
                    case "GET info" -> info(query, requestId);
                    case "GET list" -> list(query, requestId);
                    case "GET history" -> history(query, requestId);
                    case "POST unlink" -> unlink(json, requestId, false, started);
                    default -> error(404, "not_found", requestId);
                };
            }
            if ("GET".equals(m) && "/api/link/status".equals(p)) return legacyStatus(query, requestId);
            if ("POST".equals(m) && "/api/link/verify".equals(p)) return verify(json, requestId, true, started);
            if ("DELETE".equals(m) && "/api/link".equals(p)) return unlink(json, requestId, true, started);
            return error(404, "not_found", requestId);
        } catch (ApiError invalid) {
            return error(invalid.status, invalid.code, requestId);
        } catch (LinkService.AmbiguousNameException ambiguous) {
            return ambiguous(ambiguous.candidates(), requestId);
        } catch (IllegalArgumentException invalid) {
            return error(400, "invalid_request", requestId);
        } catch (IllegalStateException unavailable) {
            this.logger.log(Level.WARNING, "[link] rid=" + safe(requestId) + " " + m + " " + p
                    + " depo hatası (" + chain(unavailable) + ") instance=" + this.instanceId);
            return error(503, "store_unavailable", requestId);
        } catch (RuntimeException unexpected) {
            this.logger.log(Level.SEVERE, "[link] rid=" + safe(requestId) + " " + m + " " + p
                    + " beklenmeyen hata instance=" + this.instanceId, unexpected);
            return error(500, "internal_error", requestId);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Uçlar                                                                */
    /* ------------------------------------------------------------------ */

    private Response probe(Map<String, Object> json, String requestId) {
        String code = requireString(json, "code");
        String discordId = optionalDiscordId(json, "discordId");
        LinkService.ProbeResult result = this.links.probe(code, discordId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("holder", result.holder());
        out.put("expired", result.expired());
        return respond(200, out, requestId);
    }

    private Response verify(Map<String, Object> json, String requestId, boolean legacy, long started) {
        String code = requireString(json, "code");
        String discordId = requireDiscordId(json, "discordId");
        String discordTag = optionalString(json, "discordTag");
        LinkService.VerifyResult result = this.links.verify(new LinkService.VerifyRequest(
                code, discordId, discordTag, requestId, legacy ? "bridge_legacy" : "discord"));
        String normalized = LinkService.normalize(code);

        if (result instanceof LinkService.VerifyResult.Linked linked) {
            this.logger.info("[link] rid=" + safe(requestId) + " verify=linked created=" + linked.created()
                    + " replay=" + linked.replay() + " uuid=" + linked.link().uuid() + " discord=" + discordId
                    + " instance=" + this.instanceId + " " + elapsed(started) + "ms");
            Map<String, Object> out = new LinkedHashMap<>();
            if (legacy) out.put("mc", linked.link().displayName());
            out.put("result", "linked");
            out.put("created", linked.created());
            out.put("replay", linked.replay());
            out.put("link", linkJson(linked.link()));
            return respond(200, out, requestId);
        }
        if (result instanceof LinkService.VerifyResult.DiscordAlreadyLinked taken) {
            this.logger.info("[link] rid=" + safe(requestId) + " verify=discord_already_linked discord="
                    + discordId + " mevcut=" + taken.link().uuid() + " instance=" + this.instanceId);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("error", "discord_already_linked");
            out.put("link", linkJson(taken.link()));
            return respond(409, out, requestId);
        }
        String reason = result instanceof LinkService.VerifyResult.InvalidCode invalid ? invalid.reason() : "expired";
        this.logger.warning("[link] rid=" + safe(requestId) + " verify reddedildi: " + reason
                + " (kod uzunluğu=" + normalized.length()
                + ", kapsamlı=" + LinkScope.isScoped(normalized)
                + ", bu sunucuda bekleyen kod=" + this.links.pendingCodeCount()
                + ", instance=" + this.instanceId + ")");
        Map<String, Object> out = new LinkedHashMap<>();
        if (result instanceof LinkService.VerifyResult.ExpiredCode) {
            out.put("error", "expired_code");
        } else {
            out.put("error", "invalid_code");
            out.put("reason", reason);
        }
        return respond(404, out, requestId);
    }

    private Response operation(Map<String, String> query, String requestId) {
        if (requestId == null) throw new ApiError(400, "missing_fields");
        Map<String, Object> out = new LinkedHashMap<>();
        this.links.operation(requestId).ifPresentOrElse(record -> {
            out.put("found", true);
            out.put("action", record.action());
            out.put("result", record.result());
            out.put("link", linkJson(record.link()));
            out.put("occurredAt", record.occurredAt());
        }, () -> out.put("found", false));
        return respond(200, out, requestId);
    }

    private Response info(Map<String, String> query, String requestId) {
        LinkService.LinkRecord link;
        UUID uuid;
        boolean resolved;
        String discordFilter = null;
        List<LinkService.LinkRecord> discordLinks = null;
        if (query.containsKey("uuid")) {
            uuid = LinkService.parseUuid(query.get("uuid"));
            link = this.links.recordByUuid(uuid).orElse(null);
            resolved = true;
        } else if (query.containsKey("discord")) {
            discordFilter = discordValue(query.get("discord"));
            discordLinks = this.links.recordsByDiscord(discordFilter);
            link = discordLinks.isEmpty() ? null : discordLinks.getFirst();
            uuid = link == null ? null : link.uuid();
            resolved = link != null;
        } else if (query.containsKey("name")) {
            LinkService.NameResolution resolution = this.links.resolveName(query.get("name"), List.of());
            if (resolution.ambiguous()) return ambiguous(resolution.candidates(), requestId);
            link = resolution.link();
            uuid = resolution.uuid();
            resolved = resolution.resolved();
        } else {
            throw new ApiError(400, "missing_fields");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("linked", link != null);
        out.put("resolved", resolved);
        out.put("uuid", uuid == null ? null : uuid.toString());
        out.put("link", linkJson(link));
        out.put("links", (discordLinks != null ? discordLinks : link == null ? List.<LinkService.LinkRecord>of() : List.of(link))
                .stream().map(LinkBridgeApi::linkJson).toList());
        if (uuid != null) out.put("epoch", this.links.epoch(uuid));
        List<LinkService.LinkEvent> recent = uuid != null || discordFilter != null
                ? this.links.history(discordFilter == null ? uuid : null, discordFilter, 5, null)
                : List.of();
        out.put("recentEvents", recent.stream().map(LinkBridgeApi::eventJson).toList());
        return respond(200, out, requestId);
    }

    private Response list(Map<String, String> query, String requestId) {
        int offset = intParam(query, "offset", 0, 0, Integer.MAX_VALUE);
        int limit = intParam(query, "limit", 10, 1, MAX_PAGE);
        LinkService.LinkPage page = this.links.listLinks(offset, limit);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", page.total());
        out.put("offset", page.offset());
        out.put("limit", page.limit());
        out.put("order", "linkedAt_desc_uuid_asc");
        out.put("links", page.links().stream().map(LinkBridgeApi::linkJson).toList());
        return respond(200, out, requestId);
    }

    private Response history(Map<String, String> query, String requestId) {
        UUID uuid = query.containsKey("uuid") ? LinkService.parseUuid(query.get("uuid")) : null;
        String discordId = query.containsKey("discord") ? discordValue(query.get("discord")) : null;
        int limit = intParam(query, "limit", 10, 1, MAX_PAGE);
        Long beforeId = query.containsKey("beforeId")
                ? (long) intParam(query, "beforeId", Integer.MAX_VALUE, 1, Integer.MAX_VALUE)
                : null;
        List<LinkService.LinkEvent> events = this.links.history(uuid, discordId, limit, beforeId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("events", events.stream().map(LinkBridgeApi::eventJson).toList());
        out.put("nextBeforeId", events.size() == limit ? events.get(events.size() - 1).id() : null);
        return respond(200, out, requestId);
    }

    private Response unlink(Map<String, Object> json, String requestId, boolean legacy, long started) {
        LinkService.Selector selector;
        String value = requireString(json, "value");
        LinkService.Actor actor;
        String expectedLinkId = null;
        String reason = null;
        if (legacy) {
            String type = optionalString(json, "type");
            selector = "dc".equalsIgnoreCase(type) ? LinkService.Selector.BY_DISCORD : LinkService.Selector.BY_NAME;
            actor = new LinkService.Actor("bridge_legacy", null, null);
        } else {
            selector = switch (requireString(json, "selector").toLowerCase(Locale.ROOT)) {
                case "uuid" -> LinkService.Selector.BY_UUID;
                case "discord" -> LinkService.Selector.BY_DISCORD;
                case "name" -> LinkService.Selector.BY_NAME;
                default -> throw new ApiError(400, "invalid_selector");
            };
            expectedLinkId = optionalString(json, "expectedLinkId");
            reason = optionalString(json, "reason");
            actor = requireStaffActor(json);
        }
        if (selector == LinkService.Selector.BY_DISCORD) value = discordValue(value);

        LinkService.UnlinkResult result = this.links.unlink(new LinkService.UnlinkRequest(
                selector, value, expectedLinkId, List.of(), actor, reason,
                legacy ? "bridge_legacy" : "discord_admin", requestId));
        this.logger.info("[link] rid=" + safe(requestId) + " unlink=" + resultName(result)
                + " selector=" + selector + " actor=" + actor.type() + ":" + safe(actor.id())
                + " instance=" + this.instanceId + " " + elapsed(started) + "ms");

        if (result instanceof LinkService.UnlinkResult.Ambiguous ambiguous) {
            return ambiguous(ambiguous.candidates(), requestId);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (legacy) {
            LinkService.LinkRecord removed = result instanceof LinkService.UnlinkResult.Removed r ? r.link() : null;
            out.put("removed", removed != null);
            if (removed != null) {
                out.put("mc", removed.displayName());
                out.put("discordId", removed.discordId());
                out.put("uuid", removed.uuid().toString());
            }
            return respond(200, out, requestId);
        }
        if (result instanceof LinkService.UnlinkResult.Removed removed) {
            out.put("result", "removed");
            out.put("link", linkJson(removed.link()));
            out.put("epoch", removed.epoch());
            return respond(200, out, requestId);
        }
        if (result instanceof LinkService.UnlinkResult.StaleVersion stale) {
            out.put("error", "stale_version");
            out.put("current", linkJson(stale.current()));
            return respond(409, out, requestId);
        }
        LinkService.UnlinkResult.NotLinked notLinked = (LinkService.UnlinkResult.NotLinked) result;
        out.put("result", "not_linked");
        out.put("resolved", notLinked.resolved());
        out.put("uuid", notLinked.uuid() == null ? null : notLinked.uuid().toString());
        return respond(200, out, requestId);
    }

    private Response legacyStatus(Map<String, String> query, String requestId) {
        LinkService.LinkRecord link;
        if (query.containsKey("discord")) {
            link = this.links.recordByDiscord(discordValue(query.get("discord"))).orElse(null);
        } else if (query.containsKey("uuid")) {
            link = this.links.recordByUuid(LinkService.parseUuid(query.get("uuid"))).orElse(null);
        } else if (query.containsKey("mc")) {
            LinkService.NameResolution resolution = this.links.resolveName(query.get("mc"), List.of());
            if (resolution.ambiguous()) return ambiguous(resolution.candidates(), requestId);
            link = resolution.link();
        } else {
            throw new ApiError(400, "missing_fields");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("linked", link != null);
        if (link != null) {
            out.put("mc", link.displayName());
            out.put("discordId", link.discordId());
            out.put("linkedAt", link.linkedAt());
            out.put("uuid", link.uuid().toString());
            out.put("linkId", link.linkId());
        }
        return respond(200, out, requestId);
    }

    /* ------------------------------------------------------------------ */
    /* JSON                                                                 */
    /* ------------------------------------------------------------------ */

    static Map<String, Object> linkJson(LinkService.LinkRecord link) {
        if (link == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("uuid", link.uuid().toString());
        out.put("mcName", link.mcName());
        out.put("currentName", link.displayName());
        out.put("discordId", link.discordId());
        out.put("discordTag", link.discordTag());
        out.put("linkedAt", link.linkedAt());
        out.put("linkId", link.linkId());
        if (link.elo() != null) {
            out.put("elo", link.elo());
            String tier = tierName(link.elo());
            if (tier != null) out.put("tier", tier);
        }
        return out;
    }

    static Map<String, Object> eventJson(LinkService.LinkEvent event) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", event.id());
        out.put("occurredAt", event.occurredAt());
        out.put("action", event.action());
        out.put("result", event.result());
        out.put("uuid", event.uuid() == null ? null : event.uuid().toString());
        out.put("mcName", event.mcName());
        out.put("discordId", event.discordId());
        out.put("discordTag", event.discordTag());
        out.put("linkId", event.linkId());
        out.put("actorType", event.actorType());
        out.put("actorId", event.actorId());
        out.put("actorName", event.actorName());
        out.put("source", event.source());
        out.put("reason", event.reason());
        out.put("requestId", event.requestId());
        return out;
    }

    private Response ambiguous(List<LinkService.NameCandidate> candidates, String requestId) {
        List<Map<String, Object>> described = new ArrayList<>();
        for (LinkService.NameCandidate candidate : candidates) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("uuid", candidate.uuid().toString());
            item.put("knownNames", candidate.knownNames());
            item.put("linked", candidate.link() != null);
            item.put("link", linkJson(candidate.link()));
            described.add(item);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", "ambiguous_name");
        out.put("candidates", described);
        return respond(409, out, requestId);
    }

    private Response respond(int status, Map<String, Object> body, String requestId) {
        Map<String, Object> out = new LinkedHashMap<>(body);
        out.put("instance", this.instanceId);
        out.put("protocol", PROTOCOL_VERSION);
        if (requestId != null) out.put("requestId", requestId);
        return new Response(status, LinkJson.write(out));
    }

    private Response error(int status, String code, String requestId) {
        Map<String, Object> out = new HashMap<>();
        out.put("error", code);
        return respond(status, new LinkedHashMap<>(out), requestId);
    }

    /* ------------------------------------------------------------------ */
    /* Girdi doğrulama                                                      */
    /* ------------------------------------------------------------------ */

    private static String requestId(Map<String, Object> json, Map<String, String> query) {
        Object raw = json.get("requestId");
        String value = raw instanceof String string ? string : query.get("requestId");
        if (value == null || value.isBlank()) return null;
        if (!REQUEST_ID.matcher(value).matches()) throw new ApiError(400, "invalid_request_id");
        return value;
    }

    private static String requireString(Map<String, Object> json, String key) {
        String value = optionalString(json, key);
        if (value == null) throw new ApiError(400, "missing_fields");
        return value;
    }

    private static String optionalString(Map<String, Object> json, String key) {
        Object value = json.get(key);
        if (value == null) return null;
        if (!(value instanceof String string)) throw new ApiError(400, "invalid_request");
        String trimmed = string.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** Discord ID yalnız JSON string'i olarak kabul edilir; sayı gönderen istemci reddedilir. */
    private static String requireDiscordId(Map<String, Object> json, String key) {
        Object value = json.get(key);
        if (value == null) throw new ApiError(400, "missing_fields");
        if (value instanceof BigDecimal || !(value instanceof String)) throw new ApiError(400, "invalid_discord_id");
        return discordValue((String) value);
    }

    private static String optionalDiscordId(Map<String, Object> json, String key) {
        return json.get(key) == null ? null : requireDiscordId(json, key);
    }

    private static String discordValue(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (!DISCORD_ID.matcher(value).matches()) throw new ApiError(400, "invalid_discord_id");
        return value;
    }

    @SuppressWarnings("unchecked")
    private static LinkService.Actor requireStaffActor(Map<String, Object> json) {
        if (!(json.get("actor") instanceof Map<?, ?> raw)) throw new ApiError(400, "actor_required");
        Map<String, Object> actor = (Map<String, Object>) raw;
        String type = optionalString(actor, "type");
        String id = optionalString(actor, "id");
        if (!"discord_staff".equals(type) || id == null || !DISCORD_ID.matcher(id).matches()) {
            throw new ApiError(400, "actor_required");
        }
        return new LinkService.Actor(type, id, optionalString(actor, "name"));
    }

    private static int intParam(Map<String, String> query, String key, int fallback, int min, int max) {
        String raw = query.get(key);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            long parsed = Long.parseLong(raw.trim());
            return (int) Math.max(min, Math.min(max, parsed));
        } catch (NumberFormatException invalid) {
            throw new ApiError(400, "invalid_request");
        }
    }

    static String pathOnly(String path) {
        if (path == null) return "/";
        int q = path.indexOf('?');
        return q < 0 ? path : path.substring(0, q);
    }

    private static Map<String, String> query(String path) {
        Map<String, String> out = new HashMap<>();
        if (path == null) return out;
        int q = path.indexOf('?');
        if (q < 0) return out;
        for (String part : path.substring(q + 1).split("&")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            out.put(URLDecoder.decode(part.substring(0, eq), StandardCharsets.UTF_8),
                    URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return out;
    }

    private static String tierName(int elo) {
        try {
            return EloTier.of(elo).displayName();
        } catch (LinkageError | RuntimeException unavailable) {
            return null;
        }
    }

    private static String resultName(LinkService.UnlinkResult result) {
        if (result instanceof LinkService.UnlinkResult.Removed) return "removed";
        if (result instanceof LinkService.UnlinkResult.NotLinked) return "not_linked";
        if (result instanceof LinkService.UnlinkResult.StaleVersion) return "stale_version";
        return "ambiguous";
    }

    private static String chain(Throwable error) {
        StringBuilder out = new StringBuilder();
        for (Throwable current = error; current != null && out.length() < 400; current = current.getCause()) {
            if (out.length() > 0) out.append(" <- ");
            out.append(current.getClass().getSimpleName()).append(": ").append(current.getMessage());
        }
        return out.toString();
    }

    private static long elapsed(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000L;
    }

    private static String safe(String value) {
        return value == null ? "-" : value;
    }

    private static final class ApiError extends RuntimeException {
        private final int status;
        private final String code;

        ApiError(int status, String code) {
            super(code, null, false, false);
            this.status = status;
            this.code = code;
        }
    }
}
