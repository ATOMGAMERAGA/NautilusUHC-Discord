import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.UUID;

/** Exercises the actual package-private state class from the supplied plugin JAR. */
public class LoginUiStateTest {
    private static final Class<?> STATE;
    private static final Constructor<?> CONSTRUCTOR;
    static {
        try {
            STATE = Class.forName("com.nautilus.auth.LoginUiState");
            CONSTRUCTOR = STATE.getDeclaredConstructor(long.class, boolean.class);
            CONSTRUCTOR.setAccessible(true);
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    public static void main(String[] args) throws Exception {
        movementDoesNotReplaceAnOpenPasswordForm();
        activityStillRecoversMissingInitialLoadEvent();
        actualWorldChangeStillReopensWithFreshSubmission();
        resourcePackReloadStillWaitsUntilReady();
        teleportStillBlocksFormsUntilFinished();
        submittedFormCannotBeReplayed();
        System.out.println("Login UI state: 6 regression scenarios PASS");
    }

    private static void movementDoesNotReplaceAnOpenPasswordForm() throws Exception {
        long now = System.currentTimeMillis();
        Object state = CONSTRUCTOR.newInstance(now - 5000L, true);
        long revision = (long) call(state, "markShown");
        // AuthManager calls this on both position changes and look packets.
        // Some clients continue sending these while the text field has focus.
        for (long offset : new long[]{0L, 999L, 1001L, 5000L, 60000L}) {
            check(!(boolean) call(state, "clientActivity", now + offset),
                "Movement/look activity requested a replacement password dialog at " + offset + "ms");
            check((boolean) call(state, "isShown"), "Open password form lost its shown state");
        }
        check((boolean) call(state, "acceptSubmission", revision),
            "Password submission from the original form became stale during typing");
    }

    private static void activityStillRecoversMissingInitialLoadEvent() throws Exception {
        Object state = CONSTRUCTOR.newInstance(1000L, false);
        check(!(boolean) call(state, "canAdvance", 1200L), "Form opened before client readiness");
        check((boolean) call(state, "clientActivity", 1200L), "Missing initial dialog did not recover");
        check(!(boolean) call(state, "canAdvance", 1349L), "Initial readiness delay was skipped");
        check((boolean) call(state, "canAdvance", 1350L), "Activity failed to establish readiness");
    }

    private static void actualWorldChangeStillReopensWithFreshSubmission() throws Exception {
        Object state = CONSTRUCTOR.newInstance(1000L, true);
        long oldRevision = (long) call(state, "markShown");
        call(state, "worldChanged", 2000L);
        check(!(boolean) call(state, "isShown"), "World transition did not invalidate the old form");
        check(!(boolean) call(state, "acceptSubmission", oldRevision), "Old-world form was accepted");
        check(!(boolean) call(state, "canAdvance", 2249L), "World transition delay was skipped");
        check((boolean) call(state, "canAdvance", 2250L), "World transition never became ready");
        long freshRevision = (long) call(state, "markShown");
        check((boolean) call(state, "acceptSubmission", freshRevision), "Fresh-world form was rejected");
    }

    private static void resourcePackReloadStillWaitsUntilReady() throws Exception {
        Object state = CONSTRUCTOR.newInstance(1000L, true);
        long oldRevision = (long) call(state, "markShown");
        UUID first = new UUID(0, 1), second = new UUID(0, 2);
        call(state, "resourcePackStarted", first, 2000L);
        call(state, "resourcePackStarted", second, 2100L);
        check(!(boolean) call(state, "acceptSubmission", oldRevision), "Pre-pack form was accepted");
        call(state, "clientActivity", 3000L);
        check(!(boolean) call(state, "canAdvance", 3000L), "Movement bypassed pack loading");
        call(state, "resourcePackFinished", first, 3100L);
        check(!(boolean) call(state, "canAdvance", 4000L), "Form opened while another pack was loading");
        call(state, "resourcePackFinished", second, 4100L);
        check(!(boolean) call(state, "canAdvance", 4349L), "Pack completion delay was skipped");
        check((boolean) call(state, "canAdvance", 4350L), "Form failed to recover after packs completed");
    }

    private static void teleportStillBlocksFormsUntilFinished() throws Exception {
        Object state = CONSTRUCTOR.newInstance(1000L, true);
        call(state, "startTeleport");
        call(state, "clientActivity", 2000L);
        check(!(boolean) call(state, "canAdvance", 2000L), "Movement bypassed the in-progress teleport");
        call(state, "finishTeleport", 2100L, false);
        check((boolean) call(state, "needsLobbyTeleport"), "Failed teleport was treated as successful");
        call(state, "startTeleport");
        call(state, "finishTeleport", 3000L, true);
        check(!(boolean) call(state, "needsLobbyTeleport"), "Successful lobby teleport was forgotten");
        check((boolean) call(state, "canAdvance", 3250L), "Form never became ready after teleport");
    }

    private static void submittedFormCannotBeReplayed() throws Exception {
        Object state = CONSTRUCTOR.newInstance(1000L, true);
        long revision = (long) call(state, "markShown");
        check(!(boolean) call(state, "acceptSubmission", revision + 1), "Wrong form revision was accepted");
        check((boolean) call(state, "acceptSubmission", revision), "Current form was rejected");
        check(!(boolean) call(state, "acceptSubmission", revision), "Submitted form was accepted twice");
    }

    private static Object call(Object state, String name, Object... args) throws Exception {
        Class<?>[] types = new Class<?>[args.length];
        for (int i = 0; i < args.length; i++) {
            types[i] = args[i] instanceof Long ? long.class : args[i] instanceof Boolean ? boolean.class : UUID.class;
        }
        Method method = STATE.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(state, args);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
