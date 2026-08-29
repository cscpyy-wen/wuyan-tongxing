package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class LaunchOverlayReleaseWatchdogTest {
    @Test
    public void watchdogReleasesOverlayWhenWebEvaluatorNeverResponds() {
        FakeScheduler scheduler = new FakeScheduler();
        AtomicInteger releaseCount = new AtomicInteger();
        LaunchOverlayReleaseWatchdog watchdog = new LaunchOverlayReleaseWatchdog(
            scheduler,
            releaseCount::incrementAndGet,
            5_000L
        );

        watchdog.arm();
        assertEquals(0, releaseCount.get());
        assertEquals(5_000L, scheduler.delayMillis);
        assertNotNull(scheduler.pending);

        scheduler.firePending();
        assertEquals(1, releaseCount.get());
        assertNull(scheduler.pending);

        // A late renderer callback is harmless after the independent timeout wins.
        watchdog.release();
        assertEquals(1, releaseCount.get());
    }

    @Test
    public void successfulReleaseCancelsIndependentWatchdog() {
        FakeScheduler scheduler = new FakeScheduler();
        AtomicInteger releaseCount = new AtomicInteger();
        LaunchOverlayReleaseWatchdog watchdog = new LaunchOverlayReleaseWatchdog(
            scheduler,
            releaseCount::incrementAndGet,
            5_000L
        );

        watchdog.arm();
        watchdog.release();
        assertEquals(1, releaseCount.get());
        assertNull(scheduler.pending);

        scheduler.firePending();
        assertEquals(1, releaseCount.get());
    }

    private static final class FakeScheduler
        implements LaunchOverlayReleaseWatchdog.Scheduler {
        private Runnable pending;
        private long delayMillis = -1L;

        @Override
        public void postDelayed(Runnable action, long delayMillis) {
            this.pending = action;
            this.delayMillis = delayMillis;
        }

        @Override
        public void removeCallbacks(Runnable action) {
            if (pending == action) pending = null;
        }

        void firePending() {
            Runnable action = pending;
            pending = null;
            if (action != null) action.run();
        }
    }
}
