import com.nautilus.bridge.FeatureBridge;
import com.nautilus.schedule.MatchScheduleService;
import com.nautilus.uhcmatch.UhcMatchManager;
import com.nautilus.discordlink.LinkService;
import com.nautilus.NautilusUHC;
import com.google.gson.*;
import org.bukkit.plugin.java.JavaPlugin;
import java.lang.reflect.*;
import java.util.*;

/** API producer contract with real match state methods and real temporary SQLite links. */
public class FeatureBridgeReadinessTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static JsonObject voice(ReadinessHarness h)throws Exception{Method m=FeatureBridge.class.getDeclaredMethod("voice",NautilusUHC.class);m.setAccessible(true);return (JsonObject)m.invoke(null,h.plugin);}
 static JsonObject link(JsonObject state,UUID id){for(var v:state.getAsJsonArray("links")){var o=v.getAsJsonObject();if(o.get("uuid").getAsString().equals(id.toString()))return o;}throw new AssertionError("link missing");}
 public static void main(String[] args)throws Exception{
  ReadinessHarness h=new ReadinessHarness();ReadinessHarness.set(h.plugin,JavaPlugin.class,"dataFolder",h.folder.toFile());
  try(LinkTestEnv env=new LinkTestEnv("voice-producer")){
   LinkService links=env.service();UUID live=UUID.randomUUID(),offline=UUID.randomUUID(),other=UUID.randomUUID();String discord="123456789012345678";
   check(links.verify(links.issueCode(live,"Live").code(),discord,"discord") instanceof LinkService.VerifyResult.Linked,"first fixture link failed");
   check(links.verify(links.issueCode(offline,"Offline").code(),discord,"discord") instanceof LinkService.VerifyResult.Linked,"second fixture link failed");
   h.connect(live);h.teams.setLimit(4);int team=h.teams.createTeam(List.of(live,offline));
   JsonObject idle=voice(h);check(!idle.get("enabled").getAsBoolean()&&!idle.get("active").getAsBoolean()&&idle.get("matchKey").getAsString().isEmpty(),"idle voice contract wrong");
   MatchScheduleService schedule=new MatchScheduleService(h.plugin);ReadinessHarness.set(h.plugin,NautilusUHC.class,"schedule",schedule);
   check(schedule.scheduleDetailed("Host",UUID.randomUUID(),System.currentTimeMillis()+600000,List.of(),1,"",4,false)==null,"To4 schedule fixture rejected");
   JsonObject planned=voice(h);check(planned.get("enabled").getAsBoolean()&&!planned.get("active").getAsBoolean(),"planned match must prepare channels without routing");
   h.phase(UhcMatchManager.Phase.COUNTDOWN);h.members("participants").addAll(List.of(live,other));h.members("alive").addAll(List.of(live,other));ReadinessHarness.set(h.match,UhcMatchManager.class,"matchEpoch",7);
   JsonObject countdown=voice(h);check(countdown.get("enabled").getAsBoolean()&&!countdown.get("active").getAsBoolean()&&countdown.get("matchKey").getAsString().isEmpty(),"countdown must not route before RUNNING");
   h.phase(UhcMatchManager.Phase.RUNNING);JsonObject running=voice(h);String key=running.get("matchKey").getAsString();
   check(key.equals("readiness-fixture:7"),"active match key lost instance or epoch");
   check(running.get("enabled").getAsBoolean()&&running.get("active").getAsBoolean(),"running voice flags wrong");
   check(running.getAsJsonArray("teams").size()==1&&link(running,live).get("team").getAsInt()==team,"team mapping missing");
   check(link(running,live).get("online").getAsBoolean()&&link(running,live).get("participant").getAsBoolean()&&link(running,live).get("alive").getAsBoolean(),"online participant flags wrong");
   check(!link(running,offline).get("online").getAsBoolean()&&!link(running,offline).get("participant").getAsBoolean(),"offline second account gained participant status");
   h.match.markDead(live);JsonObject dead=voice(h);check(!link(dead,live).get("alive").getAsBoolean()&&link(dead,live).get("participant").getAsBoolean(),"death removed participation or retained alive status");
   h.match.markAlive(live);check(link(voice(h),live).get("alive").getAsBoolean(),"revive failed to restore voice status");
   for(Runnable task:List.copyOf(h.tasks))task.run();h.tasks.clear();check(h.match.isRunning(),"same-tick death/revive incorrectly finished match");
   h.teams.removeMember(live);check(!link(voice(h),live).has("team"),"mid-match Solo change did not propagate");
   h.teams.addMember(team,live);check(link(voice(h),live).get("team").getAsInt()==team,"mid-match team change did not propagate");
   h.online.remove(live);check(!link(voice(h),live).get("online").getAsBoolean(),"disconnect not reflected");h.connect(live);
   check(voice(h).get("matchKey").getAsString().equals(key),"death/revive/team/connection changed match identity");
   h.phase(UhcMatchManager.Phase.IDLE);schedule.cancelById(schedule.next().id,UUID.randomUUID(),"fixture complete");JsonObject ended=voice(h);
   check(!ended.get("enabled").getAsBoolean()&&!ended.get("active").getAsBoolean()&&ended.get("matchKey").getAsString().isEmpty(),"ended match flags retained active routing");
   check(!link(ended,live).get("participant").getAsBoolean(),"idle retained active participation");
   System.out.println("Real voice producer: idle/planned/countdown/run/death/revive/team/disconnect/end and two-account contract PASS");
  }
 }
}
