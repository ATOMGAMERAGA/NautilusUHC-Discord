import com.nautilus.admin.HostPreferences;
import java.nio.file.*;
import java.util.*;
public class HostPreferencesTest {
 public static void main(String[] args) throws Exception {
  Path dir=Files.createTempDirectory("host-preferences-test");Path path=dir.resolve("settings.properties");
  UUID a=UUID.randomUUID(),b=UUID.randomUUID();
  try {
   HostPreferences first=new HostPreferences(path);first.put(a,Map.of("team","3","scenarios","no_fire,no_fall","world","uhc-1"));first.put(b,Map.of("team","2"));
   HostPreferences restarted=new HostPreferences(path);
   if(!restarted.get(a,"team","").equals("3")||!restarted.get(b,"team","").equals("2"))throw new AssertionError("UUID preferences lost");
   if(!restarted.get(a,"scenarios","").equals("no_fire,no_fall"))throw new AssertionError("scenario preferences lost");
   restarted.put(a,Map.of("team","4"));if(!new HostPreferences(path).get(a,"world","").equals("uhc-1"))throw new AssertionError("partial update lost fields");
   System.out.println("Host preference persistence PASS");
  }finally{Files.deleteIfExists(path);Files.deleteIfExists(dir);}
 }
}
