import com.nautilus.auth.SingleIpSessions;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

public final class SingleIpSessionsTest {
    public static void main(String[] args) throws Exception {
        reservesBeforeOnline();
        deniedLoginReleasesOnlyItsOwnReservation();
        lateCleanupDoesNotReleaseReconnectedPlayer();
        concurrentClaimsHaveOneWinner();
        normalizesAddressBytes();
        System.out.println("Single IP sessions PASS (5 cases)");
    }

    private static void reservesBeforeOnline() throws Exception {
        SingleIpSessions sessions = new SingleIpSessions();
        InetAddress address = InetAddress.getByName("192.0.2.1");
        SingleIpSessions.Claim first = sessions.claim(address, UUID.randomUUID());
        check(first != null, "first login must reserve its IP before becoming online");
        check(sessions.claim(address, UUID.randomUUID()) == null,
                "another player must be denied while the first login is pending");
        check(sessions.claim(InetAddress.getByName("192.0.2.2"), UUID.randomUUID()) != null,
                "a different IP may join");
    }

    private static void deniedLoginReleasesOnlyItsOwnReservation() throws Exception {
        SingleIpSessions sessions = new SingleIpSessions();
        InetAddress address = InetAddress.getByName("192.0.2.1");
        SingleIpSessions.Claim first = sessions.claim(address, UUID.randomUUID());
        check(sessions.claim(address, UUID.randomUUID()) == null, "duplicate login denied");
        check(!sessions.release(null), "denied duplicate with no claim cannot release the owner");
        check(sessions.claim(address, UUID.randomUUID()) == null, "owner survives unrelated rejection");
        check(sessions.release(first), "later rejection of the owner releases its reservation");
        check(sessions.claim(address, UUID.randomUUID()) != null, "IP becomes usable after failure");
    }

    private static void lateCleanupDoesNotReleaseReconnectedPlayer() throws Exception {
        SingleIpSessions sessions = new SingleIpSessions();
        InetAddress address = InetAddress.getByName("192.0.2.1");
        UUID samePlayer = UUID.randomUUID();
        SingleIpSessions.Claim old = sessions.claim(address, samePlayer);
        check(sessions.release(old), "old connection closes");
        SingleIpSessions.Claim current = sessions.claim(address, samePlayer);
        check(current != null, "same UUID may reconnect after release");
        check(!sessions.release(old), "late timeout or quit must not release the new generation");
        check(sessions.claim(address, UUID.randomUUID()) == null, "reconnected session still owns IP");
        check(sessions.release(current), "current connection can release its own session");
    }

    private static void concurrentClaimsHaveOneWinner() throws Exception {
        SingleIpSessions sessions = new SingleIpSessions();
        InetAddress address = InetAddress.getByName("192.0.2.1");
        CountDownLatch ready = new CountDownLatch(16), start = new CountDownLatch(1);
        AtomicInteger winners = new AtomicInteger();
        Thread[] threads = new Thread[16];
        for (int i = 0; i < threads.length; i++) {
            threads[i] = new Thread(() -> {
                ready.countDown();
                try { start.await(); } catch (InterruptedException ex) { throw new AssertionError(ex); }
                if (sessions.claim(address, UUID.randomUUID()) != null) winners.incrementAndGet();
            });
            threads[i].start();
        }
        ready.await();
        start.countDown();
        for (Thread thread : threads) thread.join();
        check(winners.get() == 1, "simultaneous claims must have exactly one winner");
    }

    private static void normalizesAddressBytes() throws Exception {
        SingleIpSessions sessions = new SingleIpSessions();
        byte[] mapped = new byte[] {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (byte) 255, (byte) 255,
                (byte) 192, 0, 2, 1};
        check(sessions.claim(InetAddress.getByName("192.0.2.1"), UUID.randomUUID()) != null,
                "IPv4 session accepted");
        check(sessions.claim(Inet6Address.getByAddress(null, mapped, -1), UUID.randomUUID()) == null,
                "IPv4-mapped IPv6 must share the IPv4 reservation");
        check(sessions.claim(InetAddress.getByName("2001:db8::1"), UUID.randomUUID()) != null,
                "IPv6 session accepted");
        check(sessions.claim(InetAddress.getByName("2001:0db8:0:0:0:0:0:0001"), UUID.randomUUID()) == null,
                "compressed and expanded IPv6 must share the same reservation");
        byte[] linkLocal = InetAddress.getByName("fe80::1").getAddress();
        check(sessions.claim(Inet6Address.getByAddress(null, linkLocal, 1), UUID.randomUUID()) != null,
                "scoped IPv6 session accepted");
        check(sessions.claim(Inet6Address.getByAddress(null, linkLocal, 2), UUID.randomUUID()) == null,
                "IPv6 scope must not permit duplicate address bytes");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
