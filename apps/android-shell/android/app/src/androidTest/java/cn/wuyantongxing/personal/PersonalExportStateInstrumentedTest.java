package cn.wuyantongxing.personal;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class PersonalExportStateInstrumentedTest {
    @Before
    public void resetProcessCoordinator() {
        PersonalExportPlugin.resetProcessOperationForTesting();
    }

    @Test
    public void savedPluginBundleContainsOnlyTheOperationKind() {
        PersonalExportPlugin plugin = new PersonalExportPlugin();
        Bundle restored = new Bundle();
        restored.putString(PersonalExportPlugin.STATE_OPERATION_KIND, "import");

        plugin.restoreState(restored);
        Bundle saved = plugin.saveInstanceState();

        assertEquals(2, saved.size());
        assertEquals("import", saved.getString(PersonalExportPlugin.STATE_OPERATION_KIND));
        assertTrue(saved.containsKey(PersonalExportPlugin.STATE_PROCESS_NONCE));
        assertFalse(saved.containsKey("json"));
    }

    @Test
    public void unknownBundleDoesNotBecomeAnExportOrImportLock() {
        PersonalExportPlugin plugin = new PersonalExportPlugin();
        Bundle restored = new Bundle();
        restored.putString(PersonalExportPlugin.STATE_OPERATION_KIND, "future-operation");

        plugin.restoreState(restored);
        Bundle saved = plugin.saveInstanceState();

        assertTrue(saved.isEmpty());
    }

    @Test
    public void staleSameProcessBundleCannotResurrectAFinishedOperation() {
        PersonalExportPlugin original = new PersonalExportPlugin();
        Bundle restored = new Bundle();
        restored.putString(PersonalExportPlugin.STATE_OPERATION_KIND, "export");
        original.restoreState(restored);
        Bundle stale = original.saveInstanceState();

        PersonalExportPlugin.resetProcessOperationForTesting();
        PersonalExportPlugin recreated = new PersonalExportPlugin();
        recreated.restoreState(stale);

        assertTrue(recreated.saveInstanceState().isEmpty());
    }

    @Test
    public void importIntentFiltersMediaWhileKeepingJsonProviderFallbacks() {
        Intent intent = PersonalExportPlugin.createOpenDocumentIntent();

        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("*/*", intent.getType());
        assertArrayEquals(
            new String[] { "application/json", "text/json", "text/plain", "application/octet-stream" },
            intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)
        );
    }

    @Test
    public void exportIntentRequestsTheExactSafWriteAndPersistableGrants() {
        Intent intent = PersonalExportPlugin.createSaveDocumentIntent("unsafe name.json");

        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("application/json", intent.getType());
        assertEquals("unsafe-name.json", intent.getStringExtra(Intent.EXTRA_TITLE));
        int required = Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION;
        assertEquals(required, intent.getFlags() & required);
    }

    @Test
    public void pickerCancellationIsClassifiedWithoutConsumingARecoveryResult() {
        assertTrue(PersonalExportPlugin.isCanceledResult(
            new androidx.activity.result.ActivityResult(Activity.RESULT_CANCELED, null)
        ));
        assertFalse(PersonalExportPlugin.isCanceledResult(
            new androidx.activity.result.ActivityResult(Activity.RESULT_OK, new Intent())
        ));
        assertFalse(PersonalExportPlugin.isCanceledResult(null));
    }

    @Test
    public void streamingImportMaterializesTheExactTwelveMebibyteBridgeBoundary() throws Exception {
        String decoded = PersonalExportPlugin.decodeUtf8Strict(
            new RepeatingAsciiInputStream(PersonalFilePolicy.MAX_JSON_BYTES),
            PersonalFilePolicy.MAX_JSON_BYTES
        );

        assertEquals(PersonalFilePolicy.MAX_JSON_BYTES, decoded.length());
        assertEquals('a', decoded.charAt(0));
        assertEquals('a', decoded.charAt(decoded.length() - 1));
    }

    @Test
    public void streamingExportWritesTheExactTwelveMebibyteBridgeBoundary() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        File directory = new File(context.getCacheDir(), "pending-write-" + UUID.randomUUID());
        assertTrue(directory.mkdir());
        File pending = new File(directory, "exact.pending-json");
        String json = "a".repeat(PersonalFilePolicy.MAX_JSON_BYTES);

        PersonalExportFingerprint fingerprint = PersonalExportPlugin.writeUtf8Strict(
            pending,
            json,
            PersonalFilePolicy.MAX_JSON_BYTES
        );

        assertEquals(PersonalFilePolicy.MAX_JSON_BYTES, fingerprint.bytes());
        assertEquals(PersonalFilePolicy.MAX_JSON_BYTES, pending.length());
        assertEquals(
            PersonalExportPlugin.PendingFileEraseResult.REMOVED,
            PersonalExportPlugin.eraseExistingPendingFile(pending)
        );
        assertTrue(directory.delete());
    }

    @Test
    public void pendingJsonDeletionRunsTheRealAndroidFileAndDirectorySyncBarriers() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        File directory = new File(context.getCacheDir(), "pending-delete-" + UUID.randomUUID());
        assertTrue(directory.mkdir());
        File pending = new File(directory, "sensitive.pending-json");
        try (FileOutputStream output = new FileOutputStream(pending, false)) {
            output.write("private-health-json".getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        }

        assertEquals(
            PersonalExportPlugin.PendingFileEraseResult.REMOVED,
            PersonalExportPlugin.eraseExistingPendingFile(pending)
        );
        assertFalse(pending.exists());
        assertTrue(PersonalExportPlugin.syncDirectory(directory));
        assertTrue(directory.delete());
    }

    private static final class RepeatingAsciiInputStream extends InputStream {
        private long remaining;

        RepeatingAsciiInputStream(long length) {
            remaining = length;
        }

        @Override
        public int read() {
            if (remaining == 0L) return -1;
            remaining--;
            return 'a';
        }

        @Override
        public int read(byte[] buffer, int offset, int length) {
            if (remaining == 0L) return -1;
            int count = (int) Math.min((long) length, remaining);
            java.util.Arrays.fill(buffer, offset, offset + count, (byte) 'a');
            remaining -= count;
            return count;
        }
    }
}
