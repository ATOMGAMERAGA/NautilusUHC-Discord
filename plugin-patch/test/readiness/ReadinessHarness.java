import com.nautilus.NautilusUHC;
import com.nautilus.team.TeamManager;
import com.nautilus.uhcmatch.UhcMatchManager;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.scheduler.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import java.util.logging.Logger;
import sun.misc.Unsafe;

/** Real JAR classes with only Bukkit server boundaries replaced; never boots a world. */
final class ReadinessHarness {
 static final Logger LOG=Logger.getAnonymousLogger();
 static final Unsafe UNSAFE;
 static {try{Field f=Unsafe.class.getDeclaredField("theUnsafe");f.setAccessible(true);UNSAFE=(Unsafe)f.get(null);}catch(Exception e){throw new ExceptionInInitializerError(e);}}
 static Object defaults(Class<?> type){if(!type.isPrimitive())return null;if(type==boolean.class)return false;if(type==long.class)return 0L;if(type==double.class)return 0D;if(type==float.class)return 0F;return 0;}
 static <T>T proxy(Class<T> type,InvocationHandler handler){return type.cast(Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},(p,m,a)->switch(m.getName()){case "toString"->type.getSimpleName()+"Fixture";case "hashCode"->System.identityHashCode(p);case "equals"->p==a[0];default->handler.invoke(p,m,a);}));}
 static void set(Object target,Class<?> type,String name,Object value)throws Exception{Field f=type.getDeclaredField(name);f.setAccessible(true);f.set(target,value);}
 static Object field(Object target,Class<?> type,String name)throws Exception{Field f=type.getDeclaredField(name);f.setAccessible(true);return f.get(target);}
 final Map<UUID,Player> online=new LinkedHashMap<>();
 final List<Runnable> tasks=new ArrayList<>();
 final Path folder=Files.createTempDirectory("nautilus-readiness-");
 final YamlConfiguration config=new YamlConfiguration();
 final NautilusUHC plugin;
 final UhcMatchManager match;
 final TeamManager teams;
 ReadinessHarness()throws Exception{
  config.set("uhc.teamSize",4);config.set("bridge.instance-id","readiness-fixture");
  BukkitTask task=proxy(BukkitTask.class,(p,m,a)->defaults(m.getReturnType()));
  BukkitScheduler scheduler=proxy(BukkitScheduler.class,(p,m,a)->{
   if(m.getName().equals("runTask")){tasks.add((Runnable)a[1]);return task;}
   return defaults(m.getReturnType());
  });
  Server server=proxy(Server.class,(p,m,a)->switch(m.getName()){
   case "getName","getVersion","getBukkitVersion"->"ReadinessHarness";
   case "getLogger"->LOG;
   case "isPrimaryThread"->true;
   case "getOnlinePlayers"->List.copyOf(online.values());
   case "getPlayer"->online.get(a[0]);
   case "getScheduler"->scheduler;
   case "getOfflinePlayer"->proxy(OfflinePlayer.class,(x,k,v)->switch(k.getName()){case "getUniqueId"->a[0];case "getName"->"Player-"+a[0].toString().substring(0,8);case "hasPlayedBefore"->true;default->defaults(k.getReturnType());});
   default->defaults(m.getReturnType());
  });
  set(null,Bukkit.class,"server",server);
  Plugin teamPlugin=proxy(Plugin.class,(p,m,a)->switch(m.getName()){case "getDataFolder"->folder.toFile();case "getConfig"->config;case "getLogger"->LOG;default->defaults(m.getReturnType());});
  teams=new TeamManager(teamPlugin);
  plugin=(NautilusUHC)UNSAFE.allocateInstance(NautilusUHC.class);
  match=(UhcMatchManager)UNSAFE.allocateInstance(UhcMatchManager.class);
  set(plugin,JavaPlugin.class,"logger",LOG);set(plugin,JavaPlugin.class,"newConfig",config);
  set(plugin,NautilusUHC.class,"teams",teams);set(plugin,NautilusUHC.class,"uhcMatch",match);set(null,NautilusUHC.class,"instance",plugin);
  set(match,UhcMatchManager.class,"phase",UhcMatchManager.Phase.IDLE);
  set(match,UhcMatchManager.class,"plugin",plugin);set(match,UhcMatchManager.class,"teams",teams);
  set(match,UhcMatchManager.class,"participants",new HashSet<UUID>());set(match,UhcMatchManager.class,"alive",new HashSet<UUID>());
 }
 Player connect(UUID id){Player player=proxy(Player.class,(p,m,a)->switch(m.getName()){case "getUniqueId"->id;case "getName"->"Player-"+id.toString().substring(0,8);case "isOnline"->true;default->defaults(m.getReturnType());});online.put(id,player);return player;}
 @SuppressWarnings("unchecked") Set<UUID> members(String field)throws Exception{return (Set<UUID>)field(match,UhcMatchManager.class,field);}
 void phase(UhcMatchManager.Phase phase)throws Exception{set(match,UhcMatchManager.class,"phase",phase);}
}
