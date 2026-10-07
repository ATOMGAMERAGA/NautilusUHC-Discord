package com.nautilus.bridge;
import com.google.gson.*;
import com.nautilus.NautilusUHC;
import com.nautilus.admin.TeamOperations;
import com.nautilus.discordlink.LinkService;
import org.bukkit.Bukkit;
import java.util.concurrent.TimeUnit;

public final class FeatureBridge {
 private FeatureBridge() {}
 public record Response(int status,JsonObject body) {}
 public static boolean handles(String method,String path) {
  return (method.equals("GET")&&(path.equals("/api/voice")||path.equals("/api/teamadmin")))
   ||(method.equals("POST")&&path.equals("/api/teamadmin"));
 }
 public static Response handle(String method,String path,JsonElement body) throws Exception {
  NautilusUHC p=NautilusUHC.getInstance();
  var future=Bukkit.getScheduler().callSyncMethod(p,()->{
   if(path.equals("/api/voice"))return new Response(200,voice(p));
   if(method.equals("POST")) {
    if(body==null||!body.isJsonObject())return error(400,"İşlem verisi eksik.");
    String message=TeamOperations.apply(p,body.getAsJsonObject());
    if(message!=null)return error(409,message);
   }
   return new Response(200,TeamOperations.snapshot(p));
  });
  try {return future.get(6,TimeUnit.SECONDS);}catch(Exception ex){future.cancel(false);throw ex;}
 }
 private static Response error(int status,String message){JsonObject o=new JsonObject();o.addProperty("error","team_operation_rejected");o.addProperty("message",message);return new Response(status,o);}
 public static int matchEpoch(NautilusUHC p) {
  try{var epoch=p.getUhcMatch().getClass().getDeclaredField("matchEpoch");epoch.setAccessible(true);return epoch.getInt(p.getUhcMatch());}
  catch(ReflectiveOperationException ex){throw new IllegalStateException("Maç kimliği okunamadı",ex);}
 }
 private static JsonObject voice(NautilusUHC p) {
  JsonObject o=new JsonObject();var match=p.getUhcMatch();boolean active=match.isRunning();
  boolean planned=p.getSchedule()!=null&&!p.getSchedule().upcoming().isEmpty();
  o.addProperty("enabled",match.isStarted()||planned);o.addProperty("active",active);
  // COUNTDOWN and RUNNING belong to one match; reset to empty only when idle.
  o.addProperty("matchKey",active?BridgeInstance.id(p)+":"+matchEpoch(p):"");
  o.add("teams",TeamOperations.snapshot(p).getAsJsonArray("teams"));
  JsonArray links=new JsonArray();LinkService service=LinkService.primary();
  if(service==null)throw new IllegalStateException("Bağlantı deposu hazır değil");
  for(int offset=0;;) {
   var page=service.listLinks(offset,25);
   for(var link:page.links()) {
    JsonObject x=new JsonObject();x.addProperty("uuid",link.uuid().toString());x.addProperty("discordId",link.discordId());
    x.addProperty("participant",active&&match.isParticipant(link.uuid()));x.addProperty("alive",match.isAlive(link.uuid()));
    Integer team=p.getTeams().getTeam(link.uuid());if(team!=null)x.addProperty("team",team);
    links.add(x);
   }
   offset+=page.links().size();if(page.links().isEmpty()||offset>=page.total())break;
  }
  o.add("links",links);return o;
 }
}
