package com.nautilus.admin;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.*;
/** One immutable host/settings snapshot belongs to exactly one match epoch. */
public record MatchAnnouncementContext(UUID hostId,String host,int teamSize,List<String> scenarios,AnnouncementSettings announcement) {
 public MatchAnnouncementContext {host=host==null?"Sunucu":host;teamSize=TeamPolicy.limit(teamSize);scenarios=List.copyOf(scenarios);announcement=announcement==null?AnnouncementSettings.DEFAULT:announcement;}
 public void addTo(JsonObject data,String hostDiscordId){
  data.addProperty("host",host);data.addProperty("hostDiscordId",hostDiscordId==null?"":hostDiscordId);data.addProperty("teamSize",teamSize);
  JsonArray keys=new JsonArray();for(String key:scenarios)keys.add(key);data.add("scenarios",keys);
  data.addProperty("prize",announcement.prize());data.addProperty("mentionEveryone",announcement.mentionEveryone());data.addProperty("mentionHere",announcement.mentionHere());
 }
 public record Completion(MatchAnnouncementContext context,String hostDiscordId,List<String> winners) {
  public Completion {winners=List.copyOf(winners);hostDiscordId=hostDiscordId==null?"":hostDiscordId;}
  public void addTo(JsonObject data){context.addTo(data,hostDiscordId);JsonArray names=new JsonArray();for(String name:winners)names.add(name);data.add("winners",names);}
 }
 public static final class Tracker {
  private int epoch=Integer.MIN_VALUE;private MatchAnnouncementContext context;
  public synchronized void bind(int launchEpoch,MatchAnnouncementContext value){epoch=launchEpoch;context=value;}
  public synchronized MatchAnnouncementContext get(int currentEpoch){return currentEpoch==epoch?context:null;}
  public synchronized void clear(){epoch=Integer.MIN_VALUE;context=null;}
 }
}
