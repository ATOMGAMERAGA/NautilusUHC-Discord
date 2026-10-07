import com.nautilus.admin.LaunchAnnouncement;
public class LaunchAnnouncementTest {
 public static void main(String[] args){
  LaunchAnnouncement.mark(5,true);
  if(!LaunchAnnouncement.matches(5))throw new AssertionError("scheduled start not associated");
  if(LaunchAnnouncement.matches(6))throw new AssertionError("replacement start suppressed");
  LaunchAnnouncement.mark(7,false);if(LaunchAnnouncement.matches(7))throw new AssertionError("unannounced start suppressed");
  System.out.println("Launch announcement association PASS");
 }
}
