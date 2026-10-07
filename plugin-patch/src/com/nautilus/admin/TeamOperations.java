package com.nautilus.admin;
import com.google.gson.*;
import com.nautilus.NautilusUHC;
import com.nautilus.discordlink.LinkService;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import java.util.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Both admin surfaces share the same capacity, revision and match checks. Main thread only. */
public final class TeamOperations {
 private TeamOperations() {}
 public static JsonObject snapshot(NautilusUHC p) {
  JsonObject o=new JsonObject();var t=p.getTeams();
  o.addProperty("teamSize",t.getLimit());o.addProperty("active",p.getUhcMatch().isStarted());
  JsonArray ts=new JsonArray();Set<UUID> known=new TreeSet<>();
  for(int n:t.teamNumbers()) {JsonObject team=new JsonObject();team.addProperty("number",n);
   JsonArray members=new JsonArray();for(UUID id:t.getMembers(n)) {known.add(id);members.add(player(p,id));}
   team.add("members",members);ts.add(team);
  }
  o.add("teams",ts);
  for(Player x:Bukkit.getOnlinePlayers())known.add(x.getUniqueId());
  JsonArray players=new JsonArray();for(UUID id:known)players.add(player(p,id));o.add("players",players);
  try {o.addProperty("revision",HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
   .digest((t.getLimit()+ts.toString()).getBytes(StandardCharsets.UTF_8))).substring(0,16));}
  catch(Exception ex){throw new IllegalStateException(ex);}
  return o;
 }
 private static JsonObject player(NautilusUHC p,UUID id) {
  JsonObject o=new JsonObject();o.addProperty("uuid",id.toString());
  String name=Bukkit.getOfflinePlayer(id).getName();o.addProperty("name",name==null?id.toString():name);
  Integer team=p.getTeams().getTeam(id);if(team!=null)o.addProperty("team",team);
  o.addProperty("online",Bukkit.getPlayer(id)!=null);o.addProperty("alive",p.getUhcMatch().isAlive(id));return o;
 }
 public static String apply(NautilusUHC p,JsonObject b) {
  if(!Bukkit.isPrimaryThread())throw new IllegalStateException("main thread required");
  String action=text(b,"action"),actor=text(b,"actor");var t=p.getTeams();
  if(actor.isBlank())return "Yetkili bilgisi eksik.";
  if(!snapshot(p).get("revision").getAsString().equals(text(b,"revision"))) return "Takımlar değişmiş. Paneli yenileyip tekrar dene.";
  boolean busy=p.getUhcMatch().isStarted()||p.getUhcMatch().isStartWarmupActive()
   ||(p.getMeetup()!=null&&p.getMeetup().phase()!=com.nautilus.meetup.MeetupManager.Phase.IDLE);
  if(busy&&Set.of("clear","randomize","size").contains(action))return "Toplu takım işlemleri maç veya hazırlık sırasında kilitli.";
  int number=b.has("team")?b.get("team").getAsInt():0;
  if(Set.of("move","disband").contains(action)&&!t.teamNumbers().contains(number))return "Takım bulunamadı.";
  UUID id=null;
  if(Set.of("move","remove","create").contains(action)) {
   try{id=UUID.fromString(text(b,"player"));}catch(Exception ex){return "Oyuncu UUID bilgisi geçersiz.";}
   if(Bukkit.getPlayer(id)==null&&t.getTeam(id)==null&&!Bukkit.getOfflinePlayer(id).hasPlayedBefore())return "Oyuncu bulunamadı.";
  }
  switch(action) {
   case "move" -> {
    Integer before=t.getTeam(id);
    if(!TeamPolicy.canJoin(t.memberCount(number),t.getLimit(),Objects.equals(before,number)))return "Takım dolu veya solo modu açık.";
    // Add first to preserve target numbers while TeamManager compacts empty teams.
    t.addMember(number,id); pruneEmpty(t);
   }
   case "remove" -> t.removeMember(id);
   case "create" -> {
    if(t.getLimit()<=1)return "Önce takım boyutunu en az 2 yap.";
    if(t.getTeam(id)!=null)return "Oyuncu zaten takımda. Önce Solo yap.";
    t.createTeam(List.of(id));
   }
   case "disband" -> {for(UUID member:List.copyOf(t.getMembers(number)))t.removeMember(member);}
   case "size" -> {
    int size=b.has("size")?b.get("size").getAsInt():0;
    if(size<1||size>100)return "Takım boyutu 1–100 arasında olmalı.";
    if(size==1&&!t.teamNumbers().isEmpty())return "Solo moduna geçmeden önce takımları temizle.";
    if(size>1&&t.teamNumbers().stream().anyMatch(n->t.memberCount(n)>size))return "Bir takım yeni boyuttan büyük; önce oyuncuları düzenle.";
    t.setLimit(size);
   }
   case "clear" -> t.clearAssignments();
   case "randomize" -> {
    if(t.getLimit()<=1)return "Solo modunda takım dağıtılamaz.";
    List<UUID> ids=new ArrayList<>();
    for(Player x:Bukkit.getOnlinePlayers())if(p.getUhcHub().isInHub(x))ids.add(x.getUniqueId());
    if(ids.isEmpty())return "UHC bekleme alanında oyuncu yok.";
    Collections.shuffle(ids);t.clearAssignments();
    for(int i=0;i<ids.size();i+=t.getLimit())t.createTeam(List.copyOf(ids.subList(i,Math.min(i+t.getLimit(),ids.size()))));
   }
   default -> {return "Bilinmeyen işlem.";}
  }
  t.save();p.getLogger().info("Takım yönetimi: "+action+"; yetkili="+actor+"; oyuncu="+id+"; takım="+number);
  return null;
 }
 private static void pruneEmpty(com.nautilus.team.TeamManager t) {
  // Moving a last member must trigger the existing lifecycle/renumbering callbacks.
  try {var field=t.getClass().getDeclaredField("teamColors");field.setAccessible(true);
   Map<Integer,?> colors=(Map<Integer,?>)field.get(t);Set<Integer> empty=new HashSet<>();
   for(int n:List.copyOf(colors.keySet()))if(t.memberCount(n)==0){colors.remove(n);empty.add(n);}
   var method=t.getClass().getDeclaredMethod("compactTeams",Set.class);method.setAccessible(true);method.invoke(t,empty);}
  catch(ReflectiveOperationException ex){throw new IllegalStateException("Takım sıralama uyumluluk hatası",ex);}
 }
 public static String text(JsonObject o,String key) {return o.has(key)&&!o.get(key).isJsonNull()?o.get(key).getAsString():"";}
}
