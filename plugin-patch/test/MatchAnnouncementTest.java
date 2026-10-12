import com.nautilus.admin.ScheduleBook;
import com.nautilus.admin.TeamPolicy;
import com.nautilus.admin.HostPreferences;
import com.nautilus.admin.AnnouncementSettings;
import java.nio.file.*;
import java.util.*;
public class MatchAnnouncementTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path path=Files.createTempDirectory("match-settings-test").resolve("schedule.properties");UUID host=UUID.randomUUID();
  ScheduleBook book=new ScheduleBook(path,0,1);
  try{book.add(0,1000,"Host",host,List.of(),1,"",4,false);throw new AssertionError("To4 was accepted; team sizes must be FFA/To2/To3");}catch(IllegalArgumentException expected){}
  check(!TeamPolicy.canJoin(2,4,false),"oversized team policy accepted To4");
  Class<?> type;
  try{type=Class.forName("com.nautilus.admin.AnnouncementSettings");}catch(ClassNotFoundException ex){throw new AssertionError("per-match prize/mention settings missing",ex);}
  HostPreferences preferences=new HostPreferences(path.resolveSibling("host-preferences.properties"));
  check(AnnouncementSettings.read(preferences,host).equals(AnnouncementSettings.DEFAULT),"new host mention defaults must be OFF");
  preferences.put(host,new AnnouncementSettings("  100 TL + VIP  ",true,false).preferences());
  Object settings=AnnouncementSettings.read(new HostPreferences(path.resolveSibling("host-preferences.properties")),host);
  var add=ScheduleBook.class.getMethod("add",long.class,long.class,String.class,UUID.class,List.class,double.class,String.class,int.class,boolean.class,type);
  ScheduleBook.Plan plan=(ScheduleBook.Plan)add.invoke(book,0L,2000L,"Host",host,List.of("no_fire"),1.0,"",3,true,settings);
  preferences.put(host,new AnnouncementSettings("Other reward",false,true).preferences());
  book.transition(plan.id(),ScheduleBook.Status.STARTING,"preparing");book.transition(plan.id(),ScheduleBook.Status.STARTED,"");
  Object saved=ScheduleBook.Plan.class.getMethod("announcement").invoke(new ScheduleBook(path,0,1).get(plan.id()));
  check(type.getMethod("prize").invoke(saved).equals("100 TL + VIP"),"prize lost on restart/transition");
  check(type.getMethod("mentionEveryone").invoke(saved).equals(true),"everyone setting lost");
  check(type.getMethod("mentionHere").invoke(saved).equals(false),"here setting lost");
  AnnouncementSettings edited=AnnouncementSettings.read(new HostPreferences(path.resolveSibling("host-preferences.properties")),host);
  check(edited.prize().equals("Other reward")&&!edited.mentionEveryone()&&edited.mentionHere(),"host settings did not persist independently from plan");
  Object blank=type.getConstructor(String.class,boolean.class,boolean.class).newInstance(" \t ",false,false);
  check(type.getMethod("prize").invoke(blank).equals(""),"blank prize must disable reward");
  var old=book.add(0,3000,"Other",UUID.randomUUID(),List.of(),1,"",1,false);
  Object defaults=ScheduleBook.Plan.class.getMethod("announcement").invoke(old);
  check(type.getMethod("mentionEveryone").invoke(defaults).equals(false)&&type.getMethod("mentionHere").invoke(defaults).equals(false),"new settings must default off");
  System.out.println("Match prize persistence, independent mention flags and team cap PASS");
 }
}
