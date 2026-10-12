import com.nautilus.admin.*;
import com.nautilus.bridge.*;
import com.nautilus.discordlink.*;
import com.google.gson.*;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.plugin.Plugin;
import org.bukkit.configuration.file.YamlConfiguration;
import java.net.*;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.logging.Logger;
public class BridgeAnnouncementContractTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  List<JsonObject> events=new ArrayList<>();List<Boolean> signed=new ArrayList<>();String secret="contract-test";
  HttpServer http=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
  http.createContext("/api/event",exchange->{
   String body=new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8);
   var headers=exchange.getRequestHeaders();long stamp=Long.parseLong(headers.getFirst("X-Nautilus-Timestamp"));String nonce=headers.getFirst("X-Nautilus-Nonce");
   signed.add(BridgeSignature.sign(secret,stamp,nonce,body).equals(headers.getFirst("X-Nautilus-Signature")));events.add(JsonParser.parseString(body).getAsJsonObject());exchange.sendResponseHeaders(204,-1);exchange.close();
  });http.start();
  try(LinkTestEnv env=new LinkTestEnv("announcement-contract")){
   UUID host=UUID.randomUUID();LinkService links=env.service();String id="123456789012345678";
   check(links.verify(links.issueCode(host,"Alice").code(),id,"alice") instanceof LinkService.VerifyResult.Linked,"host fixture did not link");
   YamlConfiguration config=new YamlConfiguration();config.set("bridge.bot-url","http://127.0.0.1:"+http.getAddress().getPort());config.set("bridge.token",secret);config.set("uhc.teamSize",2);
   Plugin plugin=(Plugin)Proxy.newProxyInstance(Plugin.class.getClassLoader(),new Class<?>[]{Plugin.class},(proxy,method,values)->switch(method.getName()){
    case "getConfig"->config;case "getLogger"->Logger.getAnonymousLogger();case "isEnabled"->false;case "toString"->"AnnouncementContractPlugin";case "hashCode"->System.identityHashCode(proxy);case "equals"->proxy==values[0];default->null;
   });
   BridgeClient bridge=new BridgeClient(plugin);MatchAnnouncementContext context=new MatchAnnouncementContext(host,"Alice",3,List.of("no_fire"),new AnnouncementSettings("VIP + 100 TL",true,false));
   AnnouncementRuntime.withScheduled(context,()->bridge.matchScheduled("12.10.2026 18:00",10000,"Alice",List.of("no_fire"),true));
   bridge.matchStart("Bob",2,List.of("no_fall"),false);
   AnnouncementRuntime.withCompleted(new MatchAnnouncementContext.Completion(context,AnnouncementRuntime.discordId(context),List.of("Alice","Carol")),()->bridge.matchEnd(42,"Team 1",1200,8,List.of(),null,0,false));
   check(events.size()==3,"bridge did not send all three events");check(signed.stream().allMatch(Boolean::booleanValue),"HMAC signature changed");
   JsonObject scheduled=events.get(0),start=events.get(1),end=events.get(2);check(scheduled.get("type").getAsString().equals("match_scheduled")&&!scheduled.get("test").getAsBoolean(),"scheduled event type or test flag changed");
   for(JsonObject event:events){JsonObject data=event.getAsJsonObject("data");for(String field:List.of("host","hostDiscordId","prize","mentionEveryone","mentionHere","teamSize","scenarios"))check(data.has(field),event.get("type")+" missing "+field);}
   JsonObject data=scheduled.getAsJsonObject("data");check(data.get("prize").getAsString().equals("VIP + 100 TL"),"scheduled prize missing");check(data.get("hostDiscordId").getAsString().equals(id),"host linked UUID not resolved to Discord");check(data.get("teamSize").getAsInt()==3,"plan team replaced by server setting");check(data.get("mentionEveryone").getAsBoolean()&&!data.get("mentionHere").getAsBoolean(),"mention switches coupled");
   JsonObject live=start.getAsJsonObject("data");check(live.get("prize").getAsString().isEmpty()&&!live.get("mentionEveryone").getAsBoolean()&&!live.get("mentionHere").getAsBoolean(),"new match leaked previous settings");
   JsonObject ended=end.getAsJsonObject("data");check(ended.get("host").getAsString().equals("Alice")&&ended.get("prize").getAsString().equals("VIP + 100 TL"),"late end leaked replacement host/prize");check(ended.getAsJsonArray("winners").get(1).getAsString().equals("Carol"),"actual winner names missing");check(end.get("matchId").getAsLong()==42,"match ID signature contract changed");
   check(AnnouncementRuntime.completed()==null&&AnnouncementRuntime.scheduled()==null,"scoped callback context leaked");
   System.out.println("Real HTTP bridge announcement payloads, UUID linked host, delayed end and HMAC contract PASS");
  }finally{http.stop(0);}
 }
}
