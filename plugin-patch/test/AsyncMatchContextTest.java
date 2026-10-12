import com.nautilus.admin.*;
import com.google.gson.*;
import java.util.*;
public class AsyncMatchContextTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Class<?> completion;
  try{completion=Class.forName("com.nautilus.admin.MatchAnnouncementContext$Completion");}catch(ClassNotFoundException ex){throw new AssertionError("asynchronous end callback has no immutable completion snapshot",ex);}
  MatchAnnouncementContext old=new MatchAnnouncementContext(UUID.randomUUID(),"Alice",3,List.of("no_fire"),new AnnouncementSettings("VIP",true,false));
  List<String> names=new ArrayList<>(List.of("Alice","Carol"));Object done=completion.getConstructor(MatchAnnouncementContext.class,String.class,List.class).newInstance(old,"123456789012345678",names);
  names.clear();MatchAnnouncementContext.Tracker tracker=new MatchAnnouncementContext.Tracker();tracker.bind(5,old);tracker.bind(6,new MatchAnnouncementContext(UUID.randomUUID(),"Bob",1,List.of(),AnnouncementSettings.DEFAULT));
  JsonObject data=new JsonObject();completion.getMethod("addTo",JsonObject.class).invoke(done,data);
  check(data.get("host").getAsString().equals("Alice"),"new match replaced completed host");check(data.get("prize").getAsString().equals("VIP"),"new draft replaced completed prize");
  check(data.get("mentionEveryone").getAsBoolean()&&!data.get("mentionHere").getAsBoolean(),"mention switches coupled");
  check(data.get("hostDiscordId").getAsString().equals("123456789012345678"),"captured linked ID lost");
  check(data.getAsJsonArray("winners").size()==2,"winner names not snapshotted");check(data.get("teamSize").getAsInt()==3,"completed team missing");check(data.getAsJsonArray("scenarios").get(0).getAsString().equals("no_fire"),"completed scenarios missing");
  System.out.println("Delayed end callback keeps original host, prize, settings and winner names PASS");
 }
}
