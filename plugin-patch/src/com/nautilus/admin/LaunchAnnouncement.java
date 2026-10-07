package com.nautilus.admin;
/** A schedule announcement belongs to exactly one launch epoch, never another match by the same host. */
public final class LaunchAnnouncement {
 private static int epoch=Integer.MIN_VALUE;
 private static boolean announced;
 private LaunchAnnouncement(){}
 public static void mark(int launchedEpoch,boolean wasAnnounced){epoch=launchedEpoch;announced=wasAnnounced;}
 public static boolean matches(int currentEpoch){return announced&&epoch==currentEpoch;}
}
