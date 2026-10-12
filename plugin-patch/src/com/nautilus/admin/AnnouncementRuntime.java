package com.nautilus.admin;
import com.nautilus.NautilusUHC;
import com.nautilus.bridge.FeatureBridge;
import com.nautilus.discordlink.LinkService;
import java.util.*;
/** Bukkit-side adapter; the bridge's public signatures remain unchanged. */
public final class AnnouncementRuntime {
 private static final ThreadLocal<MatchAnnouncementContext> scheduled=new ThreadLocal<>();
 private static final ThreadLocal<MatchAnnouncementContext.Completion> completed=new ThreadLocal<>();
 private static final MatchAnnouncementContext.Tracker active=new MatchAnnouncementContext.Tracker();
 private AnnouncementRuntime(){}
 public static MatchAnnouncementContext scheduled(){return scheduled.get();}
 public static void withScheduled(MatchAnnouncementContext context,Runnable action){
  MatchAnnouncementContext previous=scheduled.get();scheduled.set(context);try{AdminBootstrap.withAnnouncementTeam(context.teamSize(),action);}finally{if(previous==null)scheduled.remove();else scheduled.set(previous);}
 }
 public static void launch(NautilusUHC plugin,MatchAnnouncementContext context,Runnable start){
  // Both immediate preparation and a completed countdown increment the epoch once.
  active.bind(FeatureBridge.matchEpoch(plugin)+1,context);
  try{start.run();if(!plugin.getUhcMatch().isStarted())active.clear();}catch(RuntimeException ex){active.clear();throw ex;}
 }
 /** Clear a countdown snapshot synchronously when completion returns to IDLE without advancing its epoch. */
 public static void finishCountdown(Runnable finish,java.util.function.BooleanSupplier started){
  try{finish.run();}finally{if(!started.getAsBoolean())active.clear();}
 }
 public static MatchAnnouncementContext start(NautilusUHC plugin,String host,Collection<String> scenarios){
  int epoch=FeatureBridge.matchEpoch(plugin);MatchAnnouncementContext context=active.get(epoch);
  if(context==null){context=fallback(plugin,host,scenarios);active.bind(epoch,context);}return context;
 }
 public static MatchAnnouncementContext end(NautilusUHC plugin){return active.get(FeatureBridge.matchEpoch(plugin));}
 public static void clear(){active.clear();}
 public static MatchAnnouncementContext.Completion completed(){return completed.get();}
 public static MatchAnnouncementContext.Completion captureEnd(NautilusUHC plugin,String host,Collection<String> scenarios,List<String> winners){
  MatchAnnouncementContext context=end(plugin);if(context==null)context=fallback(plugin,host,scenarios);
  String id="";try{id=discordId(context);}catch(RuntimeException ex){plugin.getLogger().warning("Duyuru host Discord bağlantısı okunamadı: "+ex.getMessage());}
  MatchAnnouncementContext.Completion completion=new MatchAnnouncementContext.Completion(context,id,winners);active.clear();return completion;
 }
 public static void withCompleted(MatchAnnouncementContext.Completion completion,Runnable action){
  MatchAnnouncementContext.Completion previous=completed.get();completed.set(completion);try{action.run();}finally{if(previous==null)completed.remove();else completed.set(previous);}
 }
 public static MatchAnnouncementContext fallback(NautilusUHC plugin,String host,Collection<String> scenarios){
  org.bukkit.entity.Player online=org.bukkit.Bukkit.getPlayerExact(host);
  UUID id=online==null?null:online.getUniqueId();LinkService links=LinkService.primary();
  try{if(id==null&&links!=null){var row=links.byName(host);if(row.isPresent())id=row.get().uuid();}}catch(RuntimeException ex){plugin.getLogger().warning("Duyuru host hesabı çözümlenemedi: "+ex.getMessage());}
  AnnouncementSettings settings=AnnouncementSettings.DEFAULT;
  if(id!=null)try{settings=AnnouncementSettings.read(new HostPreferences(plugin.getDataFolder().toPath().resolve("host-preferences.properties")),id);}catch(RuntimeException ex){plugin.getLogger().warning("Duyuru ayarları okunamadı: "+ex.getMessage());}
  return new MatchAnnouncementContext(id,host,plugin.getTeams().getLimit(),List.copyOf(scenarios),settings);
 }
 public static String discordId(MatchAnnouncementContext context){
  if(context==null||context.hostId()==null)return "";LinkService links=LinkService.primary();if(links==null)return "";
  return links.recordByUuid(context.hostId()).map(LinkService.LinkRecord::discordId).orElse("");
 }
}
