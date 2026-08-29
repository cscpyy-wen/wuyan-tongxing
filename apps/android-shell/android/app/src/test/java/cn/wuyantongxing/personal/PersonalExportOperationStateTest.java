package cn.wuyantongxing.personal;

import static cn.wuyantongxing.personal.PersonalExportOperationState.Operation.EXPORT;
import static cn.wuyantongxing.personal.PersonalExportOperationState.Operation.IMPORT;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PersonalExportOperationStateTest {
    @Test
    public void restoredExportLocksOnlyExportUntilItsCallbackFinishes() {
        PersonalExportOperationState original = new PersonalExportOperationState();
        assertTrue(original.tryStart(EXPORT));
        original.activityStarted(EXPORT);
        assertEquals("export", original.persistedActivityKind());

        PersonalExportOperationState restored = new PersonalExportOperationState();
        restored.restore(original.persistedActivityKind());

        assertTrue(restored.isInFlight(EXPORT));
        assertFalse(restored.isInFlight(IMPORT));
        assertFalse(restored.tryStart(EXPORT));
        assertFalse(restored.tryStart(IMPORT));
        assertTrue(restored.callbackStarted(EXPORT));
        assertEquals("export", restored.persistedActivityKind());
        restored.callbackRecoveryCommitted(EXPORT);
        assertNull(restored.persistedActivityKind());
        restored.finish(EXPORT);
        assertTrue(restored.tryStart(EXPORT));
    }

    @Test
    public void callbackRemainsRecoverableUntilItsJournalIsCommitted() {
        PersonalExportOperationState state = new PersonalExportOperationState();
        assertTrue(state.tryStart(IMPORT));
        state.activityStarted(IMPORT);
        assertTrue(state.callbackStarted(IMPORT));
        assertTrue(state.isInFlight(IMPORT));
        assertEquals("import", state.persistedActivityKind());
        state.callbackRecoveryCommitted(IMPORT);
        assertNull(state.persistedActivityKind());

        PersonalExportOperationState recreated = new PersonalExportOperationState();
        recreated.restore(state.persistedActivityKind());
        assertTrue(recreated.isIdle());
        assertTrue(recreated.tryStart(EXPORT));
    }

    @Test
    public void sameProcessRestoreCannotUnlockBackgroundIoAfterCallbackConsumption() {
        PersonalExportOperationState state = new PersonalExportOperationState();
        assertTrue(state.tryStart(EXPORT));
        state.activityStarted(EXPORT);
        assertTrue(state.callbackStarted(EXPORT));
        state.callbackRecoveryCommitted(EXPORT);

        state.restore(null);
        assertTrue(state.isInFlight(EXPORT));
        assertFalse(state.tryStart(IMPORT));
        assertFalse(state.tryStartCleanup());
        state.finish(EXPORT);
        assertTrue(state.isIdle());
    }

    @Test
    public void restoredImportLocksOnlyImportUntilItsCallbackFinishes() {
        PersonalExportOperationState state = new PersonalExportOperationState();
        state.restore("import");

        assertFalse(state.isInFlight(EXPORT));
        assertTrue(state.isInFlight(IMPORT));
        assertFalse(state.tryStart(EXPORT));
        assertTrue(state.callbackStarted(IMPORT));
        state.callbackRecoveryCommitted(IMPORT);
        state.finish(IMPORT);
        assertTrue(state.tryStart(IMPORT));
    }

    @Test
    public void emptyOrUnknownRestoreStateDoesNotLockEitherOperation() {
        PersonalExportOperationState state = new PersonalExportOperationState();
        state.restore("future-operation");

        assertFalse(state.isInFlight(EXPORT));
        assertFalse(state.isInFlight(IMPORT));
        assertNull(state.persistedActivityKind());
        assertTrue(state.tryStart(EXPORT));
        assertFalse(state.tryStart(IMPORT));

        state.finish(EXPORT);
        assertTrue(state.tryStart(IMPORT));
        state.finish(IMPORT);
        state.restore(null);
        assertFalse(state.isInFlight(EXPORT));
        assertFalse(state.isInFlight(IMPORT));
    }

    @Test
    public void mismatchedCallbackCannotDisplaceTheActiveFileOperation() {
        PersonalExportOperationState state = new PersonalExportOperationState();
        assertTrue(state.tryStart(EXPORT));
        state.activityStarted(EXPORT);

        assertFalse(state.callbackStarted(IMPORT));
        assertTrue(state.isInFlight(EXPORT));
        assertFalse(state.isInFlight(IMPORT));
        state.finish(IMPORT);
        assertTrue(state.isInFlight(EXPORT));
        state.finish(EXPORT);
        assertTrue(state.isIdle());
    }

    @Test
    public void cleanupAndDocumentActivitiesShareOneGlobalGate() {
        PersonalExportOperationState state = new PersonalExportOperationState();
        assertTrue(state.tryStartCleanup());
        assertFalse(state.tryStart(EXPORT));
        assertFalse(state.tryStart(IMPORT));
        state.finishCleanup();
        assertTrue(state.tryStart(IMPORT));
        assertFalse(state.tryStartCleanup());
        state.finish(IMPORT);
        assertTrue(state.isIdle());
    }
}
