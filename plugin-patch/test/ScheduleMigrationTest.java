import com.nautilus.admin.*;
import java.nio.file.*;
import java.util.*;
import java.io.*;
public class ScheduleMigrationTest {
 static void check(boolean b,String message){if(!b)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path path=Files.createTempDirectory("schedule-migration").resolve("schedule.properties");ScheduleBook book=new ScheduleBook(path,0,1);
  ScheduleBook.Plan plan=book.add(0,1000,"Host",UUID.randomUUID(),List.of(),1,"",2,false);
  Properties data=new Properties();try(var in=Files.newInputStream(path)){data.load(in);}data.remove("match.0.prize");data.remove("match.0.mentionEveryone");data.remove("match.0.mentionHere");data.setProperty("match.0.teamLimit","7");
  try(var out=Files.newOutputStream(path)){data.store(out,"legacy file");}
  ScheduleBook.Plan migrated=new ScheduleBook(path,0,1).get(plan.id());check(migrated.teamLimit()==4,"legacy To7 was not capped at To4");check(migrated.announcement().equals(AnnouncementSettings.DEFAULT),"legacy file mentions must default off and prize blank");
  data.setProperty("match.0.teamLimit","-1");try(var out=Files.newOutputStream(path)){data.store(out,"invalid file");}byte[] before=Files.readAllBytes(path);
  try{new ScheduleBook(path,0,1);throw new AssertionError("invalid stored team size was silently converted to solo");}catch(IOException expected){}
  check(Arrays.equals(before,Files.readAllBytes(path)),"failed migration overwrote original file");
  System.out.println("Legacy schedule migration and invalid-file preservation PASS");
 }
}
