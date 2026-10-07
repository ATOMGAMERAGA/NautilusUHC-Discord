package com.nautilus.scenarios;
import com.nautilus.NautilusUHC;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.entity.EntityDamageEvent;
public final class NoFireListener extends ScenarioListener {
 @EventHandler(priority=EventPriority.HIGH,ignoreCancelled=true)
 public void onDamage(EntityDamageEvent event) {
  if(!isEnabled(Scenario.NO_FIRE)||!(event.getEntity() instanceof Player p)) return;
  var plugin=NautilusUHC.getInstance();
  boolean playing=plugin.getUhcMatch()!=null&&plugin.getUhcMatch().isParticipant(p.getUniqueId());
  playing|=plugin.getMeetup()!=null&&plugin.getMeetup().aliveSet().contains(p.getUniqueId());
  if(playing&&FirePolicy.protectedCause(event.getCause().name())) {event.setCancelled(true);p.setFireTicks(0);}
 }
}
