/*
 * Decompiled with CFR 0.152.
 */
package com.nautilus.admin;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileAttribute;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;

public final class ScheduleBook {
    public static final ZoneId ZONE = ZoneId.of("Europe/Istanbul");
    private final Path file;
    private final long minLead;
    private final long minInterval;
    private final LinkedHashMap<UUID, Plan> plans = new LinkedHashMap();

    public ScheduleBook(Path path, long l, long l2) throws IOException {
        this.file = path;
        this.minLead = Math.max(0L, l);
        this.minInterval = Math.max(1L, l2);
        if (Files.exists(path, new LinkOption[0])) {
            this.load();
        }
    }

    public static long at(LocalDate localDate, int n, int n2) {
        try {
            return localDate.atTime(n, n2).atZone(ZONE).toInstant().toEpochMilli();
        }
        catch (DateTimeException dateTimeException) {
            throw new IllegalArgumentException("Ge\u00e7ersiz tarih veya saat.", dateTimeException);
        }
    }

    public synchronized String validate(long l, long l2) {
        if (l2 < l || l2 - l < this.minLead) {
            return "Ma\u00e7 en az " + Math.max(1L, this.minLead / 60000L) + " dakika sonras\u0131na planlanmal\u0131.";
        }
        if (l2 - l > 31622400000L) {
            return "En fazla bir y\u0131l sonras\u0131 i\u00e7in ma\u00e7 planlanabilir.";
        }
        for (Plan plan : this.plans.values()) {
            if (plan.status != Status.PLANNED && plan.status != Status.STARTING || Math.abs(plan.startAt - l2) >= this.minInterval) continue;
            return "Bu saate yak\u0131n ba\u015fka ma\u00e7 var. En az " + this.minInterval / 60000L + " dakika ara b\u0131rak.";
        }
        return null;
    }

    public synchronized Plan add(long l, long l2, String string2, UUID uUID, List<String> list, double d, String string3, int n, boolean bl) {
        return add(l,l2,string2,uUID,list,d,string3,n,bl,AnnouncementSettings.DEFAULT);
    }

    public synchronized Plan add(long l,long l2,String string2,UUID uUID,List<String> list,double d,String string3,int n,boolean bl,AnnouncementSettings announcement) {
        String string4 = this.validate(l, l2);
        if (string4 != null) {
            throw new IllegalArgumentException(string4);
        }
        if (uUID == null || string2 == null || string2.isBlank() || string2.length() > 64) {
            throw new IllegalArgumentException("Planlayan bilgisi ge\u00e7ersiz.");
        }
        if (!Double.isFinite(d) || d < 0.1 || d > 100.0) {
            throw new IllegalArgumentException("Ma\u00e7 s\u00fcresi \u00e7arpan\u0131 ge\u00e7ersiz.");
        }
        if (n < 1 || n > 4) {
            throw new IllegalArgumentException("Takım boyutu FFA, To2, To3 veya To4 olmalı.");
        }
        if (string3 == null || !string3.isEmpty() && !string3.matches("[A-Za-z0-9_-]{1,120}")) {
            throw new IllegalArgumentException("Ge\u00e7ersiz d\u00fcnya ad\u0131.");
        }
        if (list == null || list.size() > 50 || list.stream().anyMatch(string -> string == null || !string.matches("[a-zA-Z0-9_-]{1,64}"))) {
            throw new IllegalArgumentException("Ge\u00e7ersiz senaryo.");
        }
        if (this.planned().size() >= 100) {
            throw new IllegalArgumentException("En fazla 100 bekleyen ma\u00e7 olabilir.");
        }
        Plan plan = new Plan(UUID.randomUUID(), l2, string2, uUID, new ArrayList<String>(new LinkedHashSet<String>(list)), d, string3, n, bl, l, Status.PLANNED, "", announcement);
        LinkedHashMap<UUID, Plan> linkedHashMap = new LinkedHashMap<UUID, Plan>(this.plans);
        this.plans.put(plan.id, plan);
        this.persistOrRollback(linkedHashMap);
        return plan;
    }

    public synchronized Plan get(UUID uUID) {
        return this.plans.get(uUID);
    }

    public synchronized List<Plan> all() {
        return this.plans.values().stream().sorted(Comparator.comparingLong(Plan::startAt)).toList();
    }

    public synchronized List<Plan> planned() {
        return this.all().stream().filter(plan -> plan.status == Status.PLANNED).toList();
    }

    public synchronized Plan transition(UUID uUID, Status status, String string) {
        boolean bl;
        Plan plan = this.plans.get(uUID);
        if (plan == null) {
            throw new IllegalArgumentException("Ma\u00e7 bulunamad\u0131.");
        }
        boolean bl2 = bl = plan.status == Status.PLANNED && EnumSet.of(Status.STARTING, Status.CANCELLED, Status.FAILED, Status.MISSED).contains((Object)status) || plan.status == Status.STARTING && (status == Status.STARTED || status == Status.FAILED);
        if (!bl) {
            throw new IllegalArgumentException("Bu ma\u00e7\u0131n durumu art\u0131k de\u011fi\u015fmi\u015f.");
        }
        LinkedHashMap<UUID, Plan> linkedHashMap = new LinkedHashMap<UUID, Plan>(this.plans);
        Plan plan2 = plan.state(status, string == null ? "" : string);
        this.plans.put(uUID, plan2);
        this.persistOrRollback(linkedHashMap);
        return plan2;
    }

    private void persistOrRollback(Map<UUID, Plan> map) {
        try {
            this.save();
        }
        catch (IOException iOException) {
            this.plans.clear();
            this.plans.putAll(map);
            throw new UncheckedIOException("Ma\u00e7 takvimi kaydedilemedi; i\u015flem uygulanmad\u0131.", iOException);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    private void save() throws IOException {
        Files.createDirectories(this.file.toAbsolutePath().getParent(), new FileAttribute[0]);
        Properties properties = new Properties();
        properties.setProperty("format", "1");
        properties.setProperty("count", String.valueOf(this.plans.size()));
        int n = 0;
        for (Plan object : this.plans.values()) {
            String string = "match." + n++ + ".";
            properties.setProperty(string + "id", object.id.toString());
            properties.setProperty(string + "startAt", Long.toString(object.startAt));
            properties.setProperty(string + "hostName", object.hostName);
            properties.setProperty(string + "hostId", object.hostId.toString());
            properties.setProperty(string + "scenarios", String.join((CharSequence)",", object.scenarios));
            properties.setProperty(string + "timeScale", Double.toString(object.timeScale));
            properties.setProperty(string + "world", object.worldName);
            properties.setProperty(string + "teamLimit", Integer.toString(object.teamLimit));
            properties.setProperty(string + "announce", Boolean.toString(object.announce));
            properties.setProperty(string+"prize",object.announcement.prize());
            properties.setProperty(string+"mentionEveryone",Boolean.toString(object.announcement.mentionEveryone()));
            properties.setProperty(string+"mentionHere",Boolean.toString(object.announcement.mentionHere()));
            properties.setProperty(string + "createdAt", Long.toString(object.createdAt));
            properties.setProperty(string + "status", object.status.name());
            properties.setProperty(string + "note", object.note);
        }
        Path path = Files.createTempFile(this.file.toAbsolutePath().getParent(), "schedule-", ".tmp", new FileAttribute[0]);
        try {
            try (FileOutputStream atomicMoveNotSupportedException = new FileOutputStream(path.toFile());){
                properties.store(atomicMoveNotSupportedException, "NautilusUHC admin schedule v1");
                atomicMoveNotSupportedException.getFD().sync();
            }
            try {
                Files.move(path, this.file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            }
            catch (AtomicMoveNotSupportedException atomicMoveNotSupportedException) {
                Files.move(path, this.file, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        finally {
            Files.deleteIfExists(path);
        }
    }

    private void load() throws IOException {
        Properties properties = new Properties();
        try (InputStream inputStream = Files.newInputStream(this.file, new OpenOption[0]);){
            properties.load(inputStream);
        }
        try {
            if (!"1".equals(properties.getProperty("format"))) {
                throw new IllegalArgumentException("Unknown format");
            }
            int n = Integer.parseInt(properties.getProperty("count"));
            if (n < 0 || n > 100000) {
                throw new IllegalArgumentException("Invalid count");
            }
            for (int i = 0; i < n; ++i) {
                String string2 = "match." + i + ".";
                UUID uUID = UUID.fromString(ScheduleBook.required(properties, string2 + "id"));
                Status status = Status.valueOf(ScheduleBook.required(properties, string2 + "status"));
                String string3 = properties.getProperty(string2 + "scenarios", "");
                Plan plan = new Plan(uUID, Long.parseLong(ScheduleBook.required(properties, string2 + "startAt")), ScheduleBook.required(properties, string2 + "hostName"), UUID.fromString(ScheduleBook.required(properties, string2 + "hostId")), string3.isBlank() ? List.of() : List.of(string3.split(",")), Double.parseDouble(ScheduleBook.required(properties, string2 + "timeScale")), properties.getProperty(string2 + "world", ""), storedTeamLimit(ScheduleBook.required(properties, string2 + "teamLimit")), Boolean.parseBoolean(ScheduleBook.required(properties, string2 + "announce")), Long.parseLong(ScheduleBook.required(properties, string2 + "createdAt")), status, properties.getProperty(string2 + "note", ""),new AnnouncementSettings(properties.getProperty(string2+"prize",""),Boolean.parseBoolean(properties.getProperty(string2+"mentionEveryone","false")),Boolean.parseBoolean(properties.getProperty(string2+"mentionHere","false"))));
                if (!Double.isFinite(plan.timeScale) || plan.timeScale < 0.1 || plan.timeScale > 100.0 || plan.teamLimit < 1 || plan.teamLimit > 100 || plan.hostName.isBlank() || !plan.worldName.isEmpty() && !plan.worldName.matches("[A-Za-z0-9_-]{1,120}") || plan.scenarios.stream().anyMatch(string -> !string.matches("[a-zA-Z0-9_-]{1,64}")) || this.plans.containsKey(uUID)) {
                    throw new IllegalArgumentException("Invalid stored match");
                }
                if (status == Status.STARTING) {
                    plan = plan.state(Status.FAILED, "Sunucu ba\u015flang\u0131\u00e7 s\u0131ras\u0131nda kapand\u0131; tekrar otomatik ba\u015flat\u0131lmad\u0131.");
                }
                this.plans.put(uUID, plan);
            }
        }
        catch (RuntimeException runtimeException) {
            this.plans.clear();
            throw new IOException("Ma\u00e7 takvimi okunamad\u0131; dosya korunuyor.", runtimeException);
        }
    }

    private static int storedTeamLimit(String raw){
        int size=Integer.parseInt(raw);if(size<1||size>100)throw new IllegalArgumentException("Invalid stored team size");return TeamPolicy.limit(size);
    }

    private static String required(Properties properties, String string) {
        String string2 = properties.getProperty(string);
        if (string2 == null) {
            throw new IllegalArgumentException("Missing " + string);
        }
        return string2;
    }

    public record Plan(UUID id, long startAt, String hostName, UUID hostId, List<String> scenarios, double timeScale, String worldName, int teamLimit, boolean announce, long createdAt, Status status, String note, AnnouncementSettings announcement) {
        public Plan {
            scenarios = List.copyOf(scenarios);
            announcement = announcement==null?AnnouncementSettings.DEFAULT:announcement;
        }

        public Plan(UUID id,long startAt,String hostName,UUID hostId,List<String> scenarios,double timeScale,String worldName,int teamLimit,boolean announce,long createdAt,Status status,String note){this(id,startAt,hostName,hostId,scenarios,timeScale,worldName,teamLimit,announce,createdAt,status,note,AnnouncementSettings.DEFAULT);}

        Plan state(Status status, String string) {
            return new Plan(this.id, this.startAt, this.hostName, this.hostId, this.scenarios, this.timeScale, this.worldName, this.teamLimit, this.announce, this.createdAt, status, string,this.announcement);
        }
    }

    public static enum Status {
        PLANNED,
        STARTING,
        STARTED,
        CANCELLED,
        FAILED,
        MISSED;

    }
}
