package com.nautilus.admin;
import java.util.Map;
import java.util.UUID;
/** Immutable values copied into each plan/launch; no live preference references. */
public record AnnouncementSettings(String prize, boolean mentionEveryone, boolean mentionHere) {
 public static final AnnouncementSettings DEFAULT = new AnnouncementSettings("",false,false);
 public AnnouncementSettings {prize=prize==null?"":prize.strip().replaceAll("[\\p{Cntrl}§]","");if(prize.length()>240)throw new IllegalArgumentException("Ödül en fazla 240 karakter olabilir.");}
 public static AnnouncementSettings read(HostPreferences preferences,UUID host){return new AnnouncementSettings(preferences.get(host,"prize",""),Boolean.parseBoolean(preferences.get(host,"mentionEveryone","false")),Boolean.parseBoolean(preferences.get(host,"mentionHere","false")));}
 public Map<String,String> preferences(){return Map.of("prize",prize,"mentionEveryone",String.valueOf(mentionEveryone),"mentionHere",String.valueOf(mentionHere));}
}
