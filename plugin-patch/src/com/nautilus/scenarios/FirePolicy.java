package com.nautilus.scenarios;
public final class FirePolicy {
 private FirePolicy() {}
 public static boolean protectedCause(String cause) {
  return switch(cause) {case "FIRE","FIRE_TICK","LAVA","HOT_FLOOR" -> true; default -> false;};
 }
}
