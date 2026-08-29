package cn.wuyantongxing.personal;

import static cn.wuyantongxing.personal.PersonalExportPlugin.SelectedDocumentRecoveryAction.PRESERVE_AND_CLEAR;
import static cn.wuyantongxing.personal.PersonalExportPlugin.SelectedDocumentRecoveryAction.RETAIN_WARNING;
import static cn.wuyantongxing.personal.PersonalExportPlugin.SelectedDocumentVerification.MATCH;
import static cn.wuyantongxing.personal.PersonalExportPlugin.SelectedDocumentVerification.MISMATCH;
import static cn.wuyantongxing.personal.PersonalExportPlugin.SelectedDocumentVerification.UNAVAILABLE;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

public class PersonalExportRecoveryPolicyTest {
    @Test
    public void closedMatchingWriteSurvivesCrashBeforeCompletePhaseCommit() {
        assertEquals(PRESERVE_AND_CLEAR, PersonalExportPlugin.selectedDocumentRecoveryAction("writing", MATCH));
    }

    @Test
    public void replacedOrUnavailableDocumentIsNeverDeletedOrForgottenAutomatically() {
        assertEquals(RETAIN_WARNING, PersonalExportPlugin.selectedDocumentRecoveryAction("writing", MISMATCH));
        assertEquals(RETAIN_WARNING, PersonalExportPlugin.selectedDocumentRecoveryAction("writing", UNAVAILABLE));
    }

    @Test
    public void durablyCompletedWriteOnlyNeedsItsJournalCleared() {
        assertEquals(PRESERVE_AND_CLEAR, PersonalExportPlugin.selectedDocumentRecoveryAction("complete", UNAVAILABLE));
    }

    @Test
    public void unresolvedSingleSlotJournalBlocksEveryLaterExportUntilAcknowledged() {
        assertEquals(false, PersonalExportPlugin.canStartNewExport(true, false, false));
        assertEquals(false, PersonalExportPlugin.canStartNewExport(false, true, false));
        assertEquals(false, PersonalExportPlugin.canStartNewExport(true, true, false));
        assertEquals(false, PersonalExportPlugin.canStartNewExport(false, false, true));
        assertEquals(true, PersonalExportPlugin.canStartNewExport(false, false, false));
    }

    @Test
    public void anInProcessWriterSuppressesPrematureManualCleanupGuidance() {
        assertEquals(false, PersonalExportPlugin.shouldExposeCleanupWarning(true, true));
        assertEquals(true, PersonalExportPlugin.shouldExposeCleanupWarning(false, true));
        assertEquals(false, PersonalExportPlugin.shouldExposeCleanupWarning(false, false));
    }

    @Test
    public void persistedGrantJournalIsRetainedUntilReleaseIsResolved() {
        assertEquals(true, PersonalExportPlugin.permissionReleaseResolved(true, null));
        assertEquals(true, PersonalExportPlugin.permissionReleaseResolved(false, false));
        assertEquals(false, PersonalExportPlugin.permissionReleaseResolved(false, true));
        assertEquals(false, PersonalExportPlugin.permissionReleaseResolved(false, null));
        int readWrite = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        assertEquals(true, PersonalExportPlugin.requestedPermissionStillHeld(readWrite, true, false));
        assertEquals(true, PersonalExportPlugin.requestedPermissionStillHeld(readWrite, false, true));
        assertEquals(false, PersonalExportPlugin.requestedPermissionStillHeld(readWrite, false, false));
        assertEquals(
            android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            PersonalExportPlugin.unresolvedPermissionFlags(readWrite, true, false)
        );
        assertEquals(0, PersonalExportPlugin.unresolvedPermissionFlags(readWrite, true, true));
        assertEquals(true, PersonalExportPlugin.appPrivateHealthPayloadDeletionComplete(true));
        assertEquals(false, PersonalExportPlugin.appPrivateHealthPayloadDeletionComplete(false));
    }

    @Test
    public void importRejectsMalformedUtf8InsideAnOtherwiseJsonLikeString() throws Exception {
        byte[] prefix = "{\"reason\":\"".getBytes(StandardCharsets.UTF_8);
        byte[] suffix = "\"}".getBytes(StandardCharsets.UTF_8);
        byte[] malformed = new byte[prefix.length + 2 + suffix.length];
        System.arraycopy(prefix, 0, malformed, 0, prefix.length);
        malformed[prefix.length] = (byte) 0xc3;
        malformed[prefix.length + 1] = (byte) 0x28;
        System.arraycopy(suffix, 0, malformed, prefix.length + 2, suffix.length);
        try {
            PersonalExportPlugin.decodeUtf8Strict(
                new ByteArrayInputStream(malformed),
                PersonalFilePolicy.MAX_JSON_BYTES
            );
            fail("malformed UTF-8 must not be replaced silently");
        } catch (PersonalExportPlugin.InvalidUtf8Exception expected) {
            assertEquals("备份文件不是有效 UTF-8", expected.getMessage());
        }
    }

    @Test
    public void importAcceptsTheExactByteBoundaryAndRejectsTheFirstExtraByte() throws Exception {
        byte[] exact = "戒a".getBytes(StandardCharsets.UTF_8);
        assertEquals(
            "戒a",
            PersonalExportPlugin.decodeUtf8Strict(new ByteArrayInputStream(exact), exact.length)
        );
        try {
            PersonalExportPlugin.decodeUtf8Strict(new ByteArrayInputStream(exact), exact.length - 1L);
            fail("the first byte beyond the limit must be rejected");
        } catch (PersonalExportPlugin.JsonSizeLimitExceededException expected) {
            assertEquals("JSON exceeds safe byte limit", expected.getMessage());
        }
    }

    @Test
    public void selectedDocumentJournalRejectsWrongTypesAndPartialCommitsFailClosed() {
        Map<String, Object> valid = validSelectedDocumentJournal();
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.VALID,
            PersonalExportPlugin.selectedDocumentJournalStatus(valid)
        );
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.NONE,
            PersonalExportPlugin.selectedDocumentJournalStatus(Collections.emptyMap())
        );

        Map<String, Object> wrongFlagsType = new HashMap<>(valid);
        wrongFlagsType.put(PersonalExportPlugin.SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY, "3");
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.CORRUPT,
            PersonalExportPlugin.selectedDocumentJournalStatus(wrongFlagsType)
        );

        Map<String, Object> wrongByteType = new HashMap<>(valid);
        wrongByteType.put(PersonalExportPlugin.SELECTED_DOCUMENT_EXPECTED_BYTES_KEY, 2);
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.CORRUPT,
            PersonalExportPlugin.selectedDocumentJournalStatus(wrongByteType)
        );

        Map<String, Object> partial = new HashMap<>(valid);
        partial.remove(PersonalExportPlugin.SELECTED_DOCUMENT_URI_KEY);
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.CORRUPT,
            PersonalExportPlugin.selectedDocumentJournalStatus(partial)
        );
    }

    @Test
    public void selectedDocumentJournalRejectsInvalidValuesInsteadOfDefaultingThem() {
        Map<String, Object> invalidPhase = validSelectedDocumentJournal();
        invalidPhase.put(PersonalExportPlugin.SELECTED_DOCUMENT_PHASE_KEY, "future-phase");
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.CORRUPT,
            PersonalExportPlugin.selectedDocumentJournalStatus(invalidPhase)
        );

        Map<String, Object> invalidFlags = validSelectedDocumentJournal();
        invalidFlags.put(PersonalExportPlugin.SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY, 1 << 20);
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.CORRUPT,
            PersonalExportPlugin.selectedDocumentJournalStatus(invalidFlags)
        );

        Map<String, Object> invalidUri = validSelectedDocumentJournal();
        invalidUri.put(PersonalExportPlugin.SELECTED_DOCUMENT_URI_KEY, "file:///private/export.json");
        assertEquals(
            PersonalExportPlugin.SelectedDocumentJournalStatus.CORRUPT,
            PersonalExportPlugin.selectedDocumentJournalStatus(invalidUri)
        );
    }

    @Test
    public void documentPickerPolicyRejectsEveryNonContentOrAuthoritylessUriBeforeIo() {
        assertEquals(true, PersonalExportPlugin.isSupportedDocumentUriString(
            "content://com.android.providers.downloads.documents/document/42"
        ));
        for (String invalid : new String[] {
            null,
            "",
            "file:///data/user/0/cn.wuyantongxing.personal/files/state.json",
            "/data/user/0/cn.wuyantongxing.personal/files/state.json",
            "https://example.invalid/backup.json",
            "CONTENT://documents/backup.json",
            "content://",
            "content:///backup.json",
            "content://bad authority/backup.json"
        }) {
            assertEquals(false, PersonalExportPlugin.isSupportedDocumentUriString(invalid));
        }
    }

    @Test
    public void retryableAuthenticatedStageFailureIsNeverAbortedByThePluginLayer() {
        PersonalPendingOpenJsonStore.StoreException retryable =
            PersonalPendingOpenJsonStore.StoreException.retryable("retry", null);
        PersonalPendingOpenJsonStore.StoreException terminal =
            new PersonalPendingOpenJsonStore.StoreException("DOCUMENT_INVALID_UTF8", "terminal");

        assertEquals(false, PersonalExportPlugin.shouldAbortPendingOpenJsonStageFailure(retryable));
        assertEquals(true, PersonalExportPlugin.shouldAbortPendingOpenJsonStageFailure(terminal));
        assertEquals(true, PersonalExportPlugin.shouldAbortPendingOpenJsonStageFailure(null));
    }

    private static Map<String, Object> validSelectedDocumentJournal() {
        Map<String, Object> values = new HashMap<>();
        values.put(PersonalExportPlugin.SELECTED_DOCUMENT_URI_KEY, "content://documents/export.json");
        values.put(PersonalExportPlugin.SELECTED_DOCUMENT_NAME_KEY, "export.json");
        values.put(PersonalExportPlugin.SELECTED_DOCUMENT_PHASE_KEY, "writing");
        values.put(
            PersonalExportPlugin.SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );
        values.put(PersonalExportPlugin.SELECTED_DOCUMENT_EXPECTED_BYTES_KEY, 2L);
        values.put(PersonalExportPlugin.SELECTED_DOCUMENT_EXPECTED_SHA256_KEY, "0".repeat(64));
        return values;
    }
}
