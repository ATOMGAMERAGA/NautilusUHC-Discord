package com.nautilus.admin;
public final class TeamPolicy {
 private TeamPolicy() {}
 public static boolean canJoin(int members,int limit,boolean sameTeam) {
  return sameTeam || (limit>1 && members<limit);
 }
}
