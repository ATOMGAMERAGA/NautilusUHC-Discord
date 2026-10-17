import com.nautilus.admin.*;
import com.nautilus.team.TeamManager;
import com.nautilus.uhcmatch.UhcMatchManager;
import com.google.gson.*;
import java.util.*;

public class TeamOperationsReadinessTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static JsonObject request(ReadinessHarness h,String action){JsonObject b=new JsonObject();b.addProperty("action",action);b.addProperty("actor","readiness-fixture");b.add("revision",TeamOperations.snapshot(h.plugin).get("revision"));return b;}
 static String size(ReadinessHarness h,int size){JsonObject b=request(h,"size");b.addProperty("size",size);return TeamOperations.apply(h.plugin,b);}
 public static void main(String[] args)throws Exception{
  ReadinessHarness h=new ReadinessHarness();UUID first=UUID.randomUUID();
  check(size(h,4)==null,"To4 size mutation rejected");
  JsonObject create=request(h,"create");create.addProperty("player",first.toString());
  check(TeamOperations.apply(h.plugin,create)==null,"To4 team creation rejected");
  int team=h.teams.getTeam(first);
  for(int i=0;i<3;i++){JsonObject move=request(h,"move");move.addProperty("team",team);move.addProperty("player",UUID.randomUUID().toString());check(TeamOperations.apply(h.plugin,move)==null,"To4 open slot rejected");}
  UUID extra=UUID.randomUUID();JsonObject overflow=request(h,"move");overflow.addProperty("team",team);overflow.addProperty("player",extra.toString());
  check(TeamOperations.apply(h.plugin,overflow)!=null,"fifth member accepted");check(h.teams.getTeam(extra)==null,"rejected move changed roster");
  check(size(h,3)!=null&&h.teams.getLimit()==4&&h.teams.memberCount(team)==4,"capacity reduction lost roster or limit");
  TeamManager restarted=new TeamManager((org.bukkit.plugin.Plugin)ReadinessHarness.field(h.teams,TeamManager.class,"plugin"));
  check(restarted.getLimit()==4&&restarted.getMembers(team).equals(h.teams.getMembers(team)),"To4 persistence lost roster");
  h.phase(UhcMatchManager.Phase.RUNNING);
  check(size(h,1)!=null&&h.teams.memberCount(team)==4,"active FFA mutation cleared team");
  JsonObject clear=request(h,"clear");check(TeamOperations.apply(h.plugin,clear)!=null,"active clear allowed");
  JsonObject random=request(h,"randomize");check(TeamOperations.apply(h.plugin,random)!=null,"active randomize allowed");
  JsonObject same=request(h,"move");same.addProperty("team",team);same.addProperty("player",first.toString());check(TeamOperations.apply(h.plugin,same)==null,"active same-team operation rejected");
  JsonObject stale=request(h,"remove");stale.addProperty("player",first.toString());stale.addProperty("revision","stale");check(TeamOperations.apply(h.plugin,stale)!=null&&h.teams.getTeam(first)==team,"stale revision mutated team");
  h.phase(UhcMatchManager.Phase.COUNTDOWN);check(size(h,2)!=null,"countdown size mutation allowed");
  h.phase(UhcMatchManager.Phase.IDLE);check(size(h,1)==null&&h.teams.teamNumbers().isEmpty(),"explicit idle FFA failed");
  System.out.println("Real TeamOperations To4 create/move/full/shrink/persist, active/countdown locks, revision and FFA PASS");
 }
}
