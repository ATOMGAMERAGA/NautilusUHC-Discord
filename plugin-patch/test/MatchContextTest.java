import java.util.*;
public class MatchContextTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Class<?> settings,context,tracker;
  try{settings=Class.forName("com.nautilus.admin.AnnouncementSettings");context=Class.forName("com.nautilus.admin.MatchAnnouncementContext");tracker=Class.forName("com.nautilus.admin.MatchAnnouncementContext$Tracker");}
  catch(ClassNotFoundException ex){throw new AssertionError("match-scoped announcement context missing",ex);}
  Object a=settings.getConstructor(String.class,boolean.class,boolean.class).newInstance("VIP",true,false);
  Object ctx=context.getConstructor(UUID.class,String.class,int.class,List.class,settings).newInstance(UUID.randomUUID(),"Alice",3,new ArrayList<>(List.of("no_fire")),a);
  Object t=tracker.getConstructor().newInstance();var bind=tracker.getMethod("bind",int.class,context);var get=tracker.getMethod("get",int.class);
  bind.invoke(t,5,ctx);check(get.invoke(t,5)==ctx,"launch context lost before end");
  check(get.invoke(t,6)==null,"cancelled/replaced epoch leaked stale host/prize");
  check(get.invoke(t,5)==ctx,"a lookup must not erase a still active match");
  Object b=settings.getConstructor(String.class,boolean.class,boolean.class).newInstance("",false,true);
  Object next=context.getConstructor(UUID.class,String.class,int.class,List.class,settings).newInstance(UUID.randomUUID(),"Bob",1,List.of(),b);
  bind.invoke(t,7,next);check(get.invoke(t,5)==null,"old match survived replacement");check(get.invoke(t,7)==next,"new host/settings not selected");
  tracker.getMethod("clear").invoke(t);check(get.invoke(t,7)==null,"ended context retained");
  System.out.println("Match context epoch isolation and replacement PASS");
 }
}
