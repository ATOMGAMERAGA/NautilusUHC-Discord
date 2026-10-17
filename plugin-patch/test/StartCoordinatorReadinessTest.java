import com.nautilus.admin.*;
import java.nio.file.*;
import java.util.*;

/** Executes real coordinator + schedule persistence; substitutes world/match boundaries. */
public class StartCoordinatorReadinessTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static final class Port implements StartCoordinator.Port {
  String prepareError;boolean accept=true,active,running;int apply,restore,cancel,close,prepare;Runnable onStart=()->{};
  public String prepare(){prepare++;return prepareError;}
  public void apply(){apply++;}
  public boolean start(){onStart.run();active=accept;running=accept;return accept;}
  public boolean active(){return active;}
  public boolean running(){return running;}
  public void cancel(){cancel++;active=false;running=false;}
  public void restore(){restore++;}
  public void closeGate(){close++;}
 }
 static final class Fixture {
  final Path path=Files.createTempDirectory("nautilus-start-readiness-").resolve("schedule.properties");
  final ScheduleBook book=new ScheduleBook(path,0,1);
  final ScheduleBook.Plan plan=book.add(0,1000,"Host",UUID.randomUUID(),List.of(),1,"",4,false);
  Fixture()throws Exception{}
  void breakPersistence(){try{Files.delete(path);Files.createDirectory(path);Files.writeString(path.resolve("keep"),"fixture");}catch(Exception e){throw new RuntimeException(e);}}
 }
 public static void main(String[] args)throws Exception{
  Fixture ok=new Fixture();Port accepted=new Port();var result=StartCoordinator.execute(ok.book,ok.plan,accepted);
  check(result.accepted()&&!result.stopScheduler()&&accepted.apply==1&&accepted.close==1&&accepted.restore==0&&accepted.cancel==0,"accepted start changed running settings");
  check(new ScheduleBook(ok.path,0,1).get(ok.plan.id()).status()==ScheduleBook.Status.STARTED,"accepted start not persisted");
  Fixture unavailable=new Fixture();Port blocked=new Port();blocked.prepareError="world not ready";result=StartCoordinator.execute(unavailable.book,unavailable.plan,blocked);
  check(!result.accepted()&&blocked.apply==0&&blocked.restore==0&&unavailable.book.get(unavailable.plan.id()).status()==ScheduleBook.Status.FAILED,"preflight failure mutated match");
  Fixture rejected=new Fixture();Port refused=new Port();refused.accept=false;result=StartCoordinator.execute(rejected.book,rejected.plan,refused);
  check(!result.accepted()&&refused.apply==1&&refused.restore==1&&refused.close==0,"engine refusal failed to restore idle settings");
  Fixture before=new Fixture();before.breakPersistence();Port untouched=new Port();result=StartCoordinator.execute(before.book,before.plan,untouched);
  check(!result.accepted()&&result.stopScheduler()&&untouched.prepare==0&&untouched.apply==0&&untouched.restore==0,"failed STARTING write still started match");
  Fixture after=new Fixture();Port running=new Port();running.onStart=after::breakPersistence;result=StartCoordinator.execute(after.book,after.plan,running);
  check(result.accepted()&&result.stopScheduler()&&running.running&&running.restore==0&&running.cancel==0,"failed final write cancelled or restored an accepted match");
  check(after.book.get(after.plan.id()).status()==ScheduleBook.Status.STARTING,"failed final write corrupted in-memory recovery state");
  System.out.println("Scheduled coordinator real persistence: accepted/preflight/refused/write-before/write-after safety PASS (5 scenarios)");
 }
}
