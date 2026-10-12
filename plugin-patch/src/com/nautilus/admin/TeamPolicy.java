package com.nautilus.admin;
public final class TeamPolicy {
 private TeamPolicy() {}
 public static int limit(int value){return Math.max(1,Math.min(3,value));}
 public static String label(int value){return value<=1?"FFA (Solo)":"To"+limit(value);}
 public static boolean canJoin(int members,int limit,boolean sameTeam) {
  return limit>=2 && limit<=3 && (sameTeam || members<limit);
 }
}
