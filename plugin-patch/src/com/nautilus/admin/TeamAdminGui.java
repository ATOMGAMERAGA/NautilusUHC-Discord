package com.nautilus.admin;
import com.google.gson.*;
import com.nautilus.NautilusUHC;
import org.bukkit.*;
import org.bukkit.command.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.inventory.*;
import org.bukkit.inventory.*;
import java.util.*;
import java.util.function.Consumer;

public final class TeamAdminGui implements Listener,CommandExecutor {
 private final NautilusUHC plugin;
 private static final int[] GRID={10,11,12,13,14,15,16,19,20,21,22,23,24,25,28,29,30,31,32,33,34};
 public TeamAdminGui(NautilusUHC p){plugin=p;}
 private boolean allowed(Player p){return p.hasPermission("nautilus.host")&&(plugin.getAuth()==null||plugin.getAuth().isAuthenticated(p));}
 @Override public boolean onCommand(CommandSender s,Command c,String label,String[] args){
  if(!(s instanceof Player p)){s.sendMessage("Bu komut oyun içi panel açar.");return true;}
  if(!allowed(p)){p.sendMessage("§cYetkin yok.");return true;}home(p,0);return true;
 }
 private static final class Page implements InventoryHolder {
  final UUID owner;final Inventory inv;final Map<Integer,Consumer<Player>> actions=new HashMap<>();boolean busy;
  Page(Player p,String title){owner=p.getUniqueId();inv=Bukkit.createInventory(this,54,"§3Takım Yönetimi · "+title);}
  public Inventory getInventory(){return inv;}
 }
 private Page page(Player p,String title){Page v=new Page(p,title);button(v,49,Material.OAK_DOOR,"Kapat",Player::closeInventory);return v;}
 private void button(Page v,int slot,Material m,String label,Consumer<Player> action,String... lore){
  ItemStack x=new ItemStack(m);var meta=x.getItemMeta();meta.setDisplayName("§b"+label);meta.setLore(Arrays.stream(lore).map(s->"§7"+s).toList());x.setItemMeta(meta);v.inv.setItem(slot,x);if(action!=null)v.actions.put(slot,action);
 }
 private void guard(Player p,JsonObject viewed,Runnable action){
  if(!TeamOperations.snapshot(plugin).get("revision").getAsString().equals(viewed.get("revision").getAsString())) {
   p.sendMessage("§cTakımlar değişmiş. Güncel panel açıldı; işlemi yeniden seç.");home(p,0);return;
  }action.run();
 }
 private JsonObject request(JsonObject state,String action){JsonObject b=new JsonObject();b.addProperty("action",action);b.add("revision",state.get("revision"));return b;}
 private void apply(Player p,JsonObject b){
  b.addProperty("actor","minecraft:"+p.getUniqueId()+":"+p.getName());
  String error=TeamOperations.apply(plugin,b);p.sendMessage(error==null?"§aTakımlar güncellendi.":"§c"+error);home(p,0);
 }
 private void confirm(Player p,String title,JsonObject b){Page v=page(p,"Onay");button(v,22,Material.PAPER,title,null,"Takım ve oyuncu atamaları değişebilir.");button(v,30,Material.LIME_DYE,"Onayla",x->apply(x,b));button(v,32,Material.BARRIER,"Vazgeç",x->home(x,0));p.openInventory(v.inv);}
 public void home(Player p,int page){
  JsonObject state=TeamOperations.snapshot(plugin);JsonArray teams=state.getAsJsonArray("teams");Page v=page(p,"Takımlar");
  button(v,4,Material.PLAYER_HEAD,"Takımlar · "+teams.size(),null,"Boyut: "+state.get("teamSize").getAsInt(),"Oyuncu taşıma maç sırasında da kullanılabilir.");
  int last=Math.max(0,(teams.size()-1)/GRID.length);int index=Math.max(0,Math.min(page,last));
  for(int i=0;i<GRID.length&&index*GRID.length+i<teams.size();i++){
   JsonObject t=teams.get(index*GRID.length+i).getAsJsonObject();int n=t.get("number").getAsInt();
   String names=String.join(", ",asNames(t.getAsJsonArray("members")));
   button(v,GRID[i],Material.BLUE_BANNER,"Takım "+n,x->guard(x,state,()->detail(x,n)),names);
  }
  button(v,39,Material.EMERALD,"Takım oluştur",x->players(x,"create",0,0));
  button(v,40,Material.COMPASS,"Oyuncuları yönet",x->players(x,"select",0,0));
  button(v,41,Material.REPEATER,"Rastgele dağıt",x->confirm(x,"Bekleme alanındaki oyuncuları dağıt",request(state,"randomize")));
  button(v,42,Material.BARRIER,"Tüm takımları temizle",x->confirm(x,"Tüm takımları temizle",request(state,"clear")));
  button(v,43,Material.ANVIL,"Takım boyutu",this::size);
  if(index>0)button(v,46,Material.ARROW,"Önceki",x->home(x,index-1));
  if(index<last)button(v,52,Material.ARROW,"Sonraki",x->home(x,index+1));p.openInventory(v.inv);
 }
 private List<String> asNames(JsonArray a){List<String> s=new ArrayList<>();for(JsonElement e:a)s.add(e.getAsJsonObject().get("name").getAsString());return s;}
 private void detail(Player p,int n){
  JsonObject state=TeamOperations.snapshot(plugin);Page v=page(p,"Takım "+n);JsonObject team=null;
  for(JsonElement e:state.getAsJsonArray("teams"))if(e.getAsJsonObject().get("number").getAsInt()==n)team=e.getAsJsonObject();
  if(team==null){home(p,0);return;}
  int i=0;for(JsonElement e:team.getAsJsonArray("members")){
   if(i>=GRID.length)break;var m=e.getAsJsonObject();String id=m.get("uuid").getAsString();button(v,GRID[i++],Material.PLAYER_HEAD,m.get("name").getAsString(),x->playerActions(x,id),"Tıkla: taşı veya Solo yap");
  }
  button(v,39,Material.EMERALD,"Oyuncu ekle",x->guard(x,state,()->players(x,"move",n,0)));
  JsonObject b=request(state,"disband");b.addProperty("team",n);button(v,41,Material.BARRIER,"Takımı dağıt",x->confirm(x,"Takım "+n+" dağıtılacak",b));
  button(v,45,Material.ARROW,"Takımlara dön",x->home(x,0));p.openInventory(v.inv);
 }
 private void players(Player p,String action,int team,int page){
  JsonObject state=TeamOperations.snapshot(plugin);JsonArray all=state.getAsJsonArray("players");Page v=page(p,"Oyuncular");
  int last=Math.max(0,(all.size()-1)/GRID.length),index=Math.max(0,Math.min(page,last));
  for(int i=0;i<GRID.length&&index*GRID.length+i<all.size();i++){
   JsonObject m=all.get(index*GRID.length+i).getAsJsonObject();String id=m.get("uuid").getAsString();
   button(v,GRID[i],Material.PLAYER_HEAD,m.get("name").getAsString(),x->{
    if(action.equals("select")){playerActions(x,id);return;}
    JsonObject b=request(state,action);b.addProperty("player",id);b.addProperty("team",team);apply(x,b);
   },m.has("team")?"Takım "+m.get("team").getAsInt():"Solo",m.get("online").getAsBoolean()?"Çevrimiçi":"Çevrimdışı");
  }
  if(index>0)button(v,46,Material.ARROW,"Önceki",x->guard(x,state,()->players(x,action,team,index-1)));
  if(index<last)button(v,52,Material.ARROW,"Sonraki",x->guard(x,state,()->players(x,action,team,index+1)));button(v,45,Material.ARROW,"Geri",x->home(x,0));p.openInventory(v.inv);
 }
 private void playerActions(Player p,String id){
  JsonObject state=TeamOperations.snapshot(plugin);Page v=page(p,"Oyuncu");
  button(v,20,Material.COMPASS,"Başka takıma taşı",x->targets(x,id,0));JsonObject remove=request(state,"remove");remove.addProperty("player",id);
  button(v,24,Material.FEATHER,"Solo yap",x->apply(x,remove));button(v,45,Material.ARROW,"Geri",x->players(x,"select",0,0));p.openInventory(v.inv);
 }
 private void targets(Player p,String id,int page){
  JsonObject state=TeamOperations.snapshot(plugin);JsonArray teams=state.getAsJsonArray("teams");Page v=page(p,"Hedef takım");
  int last=Math.max(0,(teams.size()-1)/GRID.length),index=Math.max(0,Math.min(page,last));
  for(int i=0;i<GRID.length&&index*GRID.length+i<teams.size();i++){
   int n=teams.get(index*GRID.length+i).getAsJsonObject().get("number").getAsInt();JsonObject b=request(state,"move");b.addProperty("team",n);b.addProperty("player",id);
   button(v,GRID[i],Material.BLUE_BANNER,"Takım "+n,x->apply(x,b));
  }
  if(index>0)button(v,46,Material.ARROW,"Önceki",x->targets(x,id,index-1));if(index<last)button(v,52,Material.ARROW,"Sonraki",x->targets(x,id,index+1));button(v,45,Material.ARROW,"Geri",x->playerActions(x,id));p.openInventory(v.inv);
 }
 private void size(Player p){
  JsonObject state=TeamOperations.snapshot(plugin);Page v=page(p,"Takım boyutu");int current=state.get("teamSize").getAsInt();
  for(int i=1;i<=7;i++){int s=i;JsonObject b=request(state,"size");b.addProperty("size",s);button(v,18+i,Material.PLAYER_HEAD,s==1?"Solo":"To"+s,x->apply(x,b));}
  for(int delta:new int[]{-1,1}){JsonObject b=request(state,"size");b.addProperty("size",current+delta);button(v,delta<0?30:32,Material.ARROW,delta<0?"Boyutu azalt":"Boyutu artır",x->apply(x,b),"Şu an: "+current);}
  button(v,45,Material.ARROW,"Geri",x->home(x,0));p.openInventory(v.inv);
 }
 @EventHandler(priority=EventPriority.HIGHEST)public void click(InventoryClickEvent e){
  if(!(e.getView().getTopInventory().getHolder() instanceof Page v))return;e.setCancelled(true);
  if(!(e.getWhoClicked() instanceof Player p)||!allowed(p)||!v.owner.equals(p.getUniqueId())||v.busy)return;
  var action=v.actions.get(e.getRawSlot());if(action==null)return;v.busy=true;
  Bukkit.getScheduler().runTask(plugin,()->{try{if(p.isOnline()&&allowed(p)&&p.getOpenInventory().getTopInventory()==v.inv)action.accept(p);}finally{v.busy=false;}});
 }
 @EventHandler(priority=EventPriority.HIGHEST)public void drag(InventoryDragEvent e){if(e.getView().getTopInventory().getHolder() instanceof Page)e.setCancelled(true);}
}
