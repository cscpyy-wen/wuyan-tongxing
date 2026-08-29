package cn.wuyantongxing.personal;

final class LaunchOverlayReleaseWatchdog {
    interface Scheduler {
        void postDelayed(Runnable action, long delayMillis);

        void removeCallbacks(Runnable action);
    }

    private final Scheduler scheduler;
    private final Runnable releaseAction;
    private final long timeoutMillis;
    private final Runnable timeoutAction = this::release;
    private boolean armed;
    private boolean released;

    LaunchOverlayReleaseWatchdog(
        Scheduler scheduler,
        Runnable releaseAction,
        long timeoutMillis
    ) {
        if (scheduler == null || releaseAction == null || timeoutMillis < 0) {
            throw new IllegalArgumentException("Invalid launch-overlay watchdog configuration");
        }
        this.scheduler = scheduler;
        this.releaseAction = releaseAction;
        this.timeoutMillis = timeoutMillis;
    }

    void arm() {
        if (armed || released) return;
        armed = true;
        scheduler.postDelayed(timeoutAction, timeoutMillis);
    }

    void release() {
        if (released) return;
        released = true;
        if (armed) {
            armed = false;
            scheduler.removeCallbacks(timeoutAction);
        }
        releaseAction.run();
    }
}
