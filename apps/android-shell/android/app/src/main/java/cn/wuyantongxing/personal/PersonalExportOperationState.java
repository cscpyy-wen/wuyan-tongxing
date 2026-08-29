package cn.wuyantongxing.personal;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Tracks the single global file-operation gate and the one operation whose
 * Activity result Capacitor may need to restore after process recreation.
 */
final class PersonalExportOperationState {
    enum Operation {
        EXPORT("export"),
        IMPORT("import"),
        CLEANUP("cleanup");

        private final String persistedKind;

        Operation(String persistedKind) {
            this.persistedKind = persistedKind;
        }

        String persistedKind() {
            return persistedKind;
        }

        static Operation fromPersistedKind(String persistedKind) {
            for (Operation operation : new Operation[] { EXPORT, IMPORT }) {
                if (operation.persistedKind.equals(persistedKind)) return operation;
            }
            return null;
        }
    }

    private final AtomicReference<Operation> activeOperation = new AtomicReference<>();
    private final AtomicReference<Operation> pendingActivityOperation = new AtomicReference<>();

    boolean tryStart(Operation operation) {
        return activeOperation.compareAndSet(null, operation);
    }

    void activityStarted(Operation operation) {
        activeOperation.set(operation);
        pendingActivityOperation.set(operation);
    }

    boolean callbackStarted(Operation operation) {
        // An empty/unknown restored Bundle deliberately leaves both operations
        // unlocked. A callback may claim that empty slot, but it must never
        // displace a different active SAF operation.
        Operation active = activeOperation.get();
        boolean accepted = active == operation
                || (active == null && activeOperation.compareAndSet(null, operation));
        return accepted;
    }

    void callbackRecoveryCommitted(Operation operation) {
        pendingActivityOperation.compareAndSet(operation, null);
    }

    void finish(Operation operation) {
        activeOperation.compareAndSet(operation, null);
        pendingActivityOperation.compareAndSet(operation, null);
    }

    boolean isInFlight(Operation operation) {
        return activeOperation.get() == operation;
    }

    boolean isIdle() {
        return activeOperation.get() == null;
    }

    boolean tryStartCleanup() {
        return tryStart(Operation.CLEANUP);
    }

    void finishCleanup() {
        finish(Operation.CLEANUP);
    }

    String persistedActivityKind() {
        Operation operation = pendingActivityOperation.get();
        return operation == null ? null : operation.persistedKind();
    }

    void restore(String persistedKind) {
        // With a process-scoped coordinator, an Activity recreation can invoke
        // restore while the previous plugin instance is still finishing I/O.
        // Never unlock or replace that live operation. In a true process
        // restart the static coordinator is new and therefore idle here.
        if (!isIdle()) return;
        Operation restored = Operation.fromPersistedKind(persistedKind);
        if (restored == null) return;
        activeOperation.set(restored);
        pendingActivityOperation.set(restored);
    }

    void resetForTesting() {
        activeOperation.set(null);
        pendingActivityOperation.set(null);
    }
}
