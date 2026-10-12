import com.nautilus.admin.*;
import java.util.*;
import java.lang.reflect.*;
import java.util.function.BooleanSupplier;
/** Reproduces UhcMatchManager's empty-player countdown completion without an epoch increment. */
public class AbandonedCountdownContextTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void complete(Runnable completion,BooleanSupplier started)throws Exception{
  Method hook;
  try{hook=AnnouncementRuntime.class.getMethod("finishCountdown",Runnable.class,BooleanSupplier.class);}catch(NoSuchMethodException missing){completion.run();return;}
  hook.invoke(null,completion,started);
 }
 public static void main(String[] args)throws Exception{
  Field field=AnnouncementRuntime.class.getDeclaredField("active");field.setAccessible(true);
  MatchAnnouncementContext.Tracker tracker=(MatchAnnouncementContext.Tracker)field.get(null);
  try{
   MatchAnnouncementContext alice=new MatchAnnouncementContext(UUID.randomUUID(),"Alice",3,List.of("no_fire"),new AnnouncementSettings("VIP",true,true));
   int[] epoch={4};boolean[] started={true};tracker.bind(epoch[0]+1,alice);
   check(tracker.get(5)==alice,"normal countdown must retain its launch snapshot before completion");
   // Everyone leaves. The base manager returns to IDLE, keeping matchEpoch unchanged.
   complete(()->started[0]=false,()->started[0]);check(epoch[0]==4,"empty countdown unexpectedly incremented epoch");
   // Legacy /uhc forcestart bypasses AnnouncementRuntime.launch and increments to5.
   epoch[0]++;started[0]=true;
   check(tracker.get(epoch[0])==null,"abandoned countdown host/prize/mentions leaked into subsequent legacy launch");
   MatchAnnouncementContext bob=new MatchAnnouncementContext(UUID.randomUUID(),"Bob",2,List.of(),new AnnouncementSettings("New prize",false,true));
   tracker.bind(epoch[0]+1,bob);started[0]=true;
   complete(()->{epoch[0]++;started[0]=true;},()->started[0]);
   check(tracker.get(epoch[0])==bob,"legitimate countdown completion lost new host/settings");
   // Successful zero-second/forced countdown completion must retain its snapshot too.
   tracker.bind(epoch[0]+1,alice);complete(()->{epoch[0]++;started[0]=true;},()->started[0]);
   check(tracker.get(epoch[0])==alice,"successful forced countdown dropped announcement settings");
   System.out.println("Empty countdown clears future epoch before legacy start; successful countdown settings retained PASS");
  }finally{AnnouncementRuntime.clear();}
 }
}
