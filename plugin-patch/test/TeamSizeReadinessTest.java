import com.nautilus.admin.*;
import java.nio.file.*;
import java.util.*;

/** Reproduces a configured To4 being reduced by bootstrap, planning and announcements. */
public class TeamSizeReadinessTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception {
  check(TeamPolicy.limit(4)==4,"bootstrap must preserve configured To4 capacity");
  for(int size=1;size<=4;size++) {
   check(TeamPolicy.label(size).equals(size==1?"FFA (Solo)":"To"+size),"wrong admin label for "+size);
   check(TeamPolicy.canJoin(size-1,size,false)==(size>1),"open capacity rejected for "+size);
   check(!TeamPolicy.canJoin(size,size,false),"full team accepted for "+size);
   check(TeamPolicy.canJoin(size,size,true)==(size>1),"same-team idempotence lost for "+size);
  }
  check(!TeamPolicy.canJoin(0,5,false),"unsupported To5 accepted");
  Path path=Files.createTempDirectory("team-size-readiness").resolve("schedule.properties");
  ScheduleBook book=new ScheduleBook(path,0,1);UUID host=UUID.randomUUID();
  var four=book.add(0,1000,"Host",host,List.of(),1,"",4,false);
  check(new ScheduleBook(path,0,1).get(four.id()).teamLimit()==4,"To4 plan changed after restart");
  try{book.add(0,2000,"Host",host,List.of(),1,"",5,false);throw new AssertionError("unsupported To5 scheduled");}catch(IllegalArgumentException expected){}
  var context=new MatchAnnouncementContext(host,"Host",4,List.of(),AnnouncementSettings.DEFAULT);
  check(context.teamSize()==4,"To4 announcement downgraded to trio");
  System.out.println("FFA/To2/To3/To4 capacity, bootstrap normalization, plan restart and announcement PASS");
 }
}
