import com.nautilus.admin.TeamPolicy;
import com.nautilus.scenarios.FirePolicy;
public class ManagementPolicyTest {
 public static void main(String[] args) {
  if(TeamPolicy.canJoin(2,2,false)) throw new AssertionError("full team accepted");
  if(!TeamPolicy.canJoin(2,2,true)) throw new AssertionError("same team rejected");
  if(!TeamPolicy.canJoin(1,2,false)) throw new AssertionError("open team rejected");
  for(String c:new String[]{"FIRE","FIRE_TICK","LAVA","HOT_FLOOR"}) if(!FirePolicy.protectedCause(c)) throw new AssertionError(c);
  for(String c:new String[]{"ENTITY_ATTACK","FALL","VOID"}) if(FirePolicy.protectedCause(c)) throw new AssertionError(c);
  System.out.println("Management policies PASS");
 }
}
