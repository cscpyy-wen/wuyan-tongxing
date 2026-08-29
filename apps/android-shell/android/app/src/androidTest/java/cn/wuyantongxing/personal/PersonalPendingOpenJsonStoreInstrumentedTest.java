package cn.wuyantongxing.personal;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class PersonalPendingOpenJsonStoreInstrumentedTest {
    private Context context;
    private PersonalPendingOpenJsonStore store;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        store = new PersonalPendingOpenJsonStore(context);
        assertTrue("pre-test pending import cleanup", store.purgeAll());
    }

    @After
    public void tearDown() {
        assertTrue("post-test pending import cleanup", store.purgeAll());
    }

    @Test
    public void stagedUtf8IsReadAsAuthenticatedBoundedChunksAndAcknowledgedIdempotently()
        throws Exception {
        String id = UUID.randomUUID().toString();
        String json = "{\"note\":\"戒烟🙂\",\"padding\":\"" + "a".repeat(300_000) + "\"}";
        byte[] expected = json.getBytes(StandardCharsets.UTF_8);

        store.beginPreparing(id, "wuyan-tongxing-backup-2026-08-29_08-00-00_Beijing.json", 1_787_968_800_000L);
        PersonalPendingOpenJsonStore.Metadata staged = store.stage(
            id,
            new ByteArrayInputStream(expected)
        );
        PersonalPendingOpenJsonStore.Probe probe = store.probe();

        assertTrue(probe.available);
        assertEquals(id, probe.metadata.id);
        assertEquals(expected.length, staged.byteLength);
        assertEquals(staged.sha256, probe.metadata.sha256);
        assertEquals("wuyan-tongxing-backup-2026-08-29_08-00-00_Beijing.json", staged.displayName);
        assertEquals(staged.displayName, probe.metadata.displayName);
        assertEquals(1_787_968_800_000L, probe.metadata.lastModifiedEpochMillis);

        ByteArrayOutputStream reconstructed = new ByteArrayOutputStream(expected.length);
        long offset = 0L;
        int chunks = 0;
        while (offset < staged.byteLength) {
            PersonalPendingOpenJsonStore.Chunk chunk = store.readChunk(id, offset);
            byte[] decoded = Base64.decode(chunk.chunkBase64, Base64.DEFAULT);
            assertTrue(decoded.length > 0);
            assertTrue(decoded.length <= PersonalPendingOpenJsonStore.MAX_CHUNK_BYTES);
            assertEquals(offset, chunk.offset);
            assertEquals(offset + decoded.length, chunk.nextOffset);
            assertEquals(chunk.nextOffset == staged.byteLength, chunk.done);
            PersonalExportFingerprint chunkFingerprint = PersonalExportFingerprint.read(
                new ByteArrayInputStream(decoded),
                PersonalPendingOpenJsonStore.MAX_CHUNK_BYTES
            );
            assertEquals(chunkFingerprint.sha256(), chunk.chunkSha256);
            reconstructed.write(decoded);
            offset = chunk.nextOffset;
            chunks++;
        }
        assertEquals(2, chunks);
        assertArrayEquals(expected, reconstructed.toByteArray());

        assertFalse(store.acknowledge(id).alreadyAcknowledged);
        assertFalse(store.probe().available);
        assertTrue(store.acknowledge(id).alreadyAcknowledged);
    }

    @Test
    public void fingerprintlessPreparingCrashIsSecurelyErasedAndReleased() throws Exception {
        String id = UUID.randomUUID().toString();
        store.beginPreparing(id);
        File directory = store.directoryForTesting();
        assertTrue(directory.mkdirs() || directory.isDirectory());
        File partial = new File(directory, id + PersonalPendingOpenJsonStore.NEW_SUFFIX);
        writeAndSync(partial, "{\"partial\":".getBytes(StandardCharsets.UTF_8));
        assertTrue(PersonalExportPlugin.syncDirectory(directory));

        try {
            store.probe();
            fail("fingerprintless PREPARING must not become available");
        } catch (PersonalPendingOpenJsonStore.StoreException error) {
            assertEquals("PENDING_OPEN_JSON_PREPARING_ABORTED", error.code);
        }

        assertFalse(partial.exists());
        assertFalse(store.probe().available);
    }

    @Test
    public void syncedPreparingFileAndFingerprintRecoverAcrossTheReadyCommitBoundary()
        throws Exception {
        String id = UUID.randomUUID().toString();
        byte[] expected = "{\"restored\":\"进程重启\"}".getBytes(StandardCharsets.UTF_8);
        store.beginPreparing(id);
        File directory = store.directoryForTesting();
        assertTrue(directory.mkdirs() || directory.isDirectory());
        File pending = new File(directory, id + PersonalPendingOpenJsonStore.NEW_SUFFIX);
        writeAndSync(pending, expected);
        assertTrue(PersonalExportPlugin.syncDirectory(directory));
        PersonalExportFingerprint fingerprint = PersonalExportFingerprint.read(
            new ByteArrayInputStream(expected),
            PersonalFilePolicy.MAX_JSON_BYTES
        );
        SharedPreferences preferences = context.getSharedPreferences(
            PersonalPendingOpenJsonStore.PREFS_NAME,
            0
        );
        assertTrue(preferences.edit()
            .putLong(PersonalPendingOpenJsonStore.BYTE_LENGTH_KEY, fingerprint.bytes())
            .putString(PersonalPendingOpenJsonStore.SHA256_KEY, fingerprint.sha256())
            .commit());

        PersonalPendingOpenJsonStore.Probe recovered = store.probe();

        assertTrue(recovered.available);
        assertEquals(id, recovered.metadata.id);
        assertEquals(fingerprint.bytes(), recovered.metadata.byteLength);
        assertFalse(pending.exists());
        assertTrue(new File(directory, id + PersonalPendingOpenJsonStore.FINAL_SUFFIX).isFile());
    }

    @Test
    public void readyCommitFailurePreservesAuthenticatedPayloadForSameIdRestartRetry()
        throws Exception {
        AtomicInteger readyCommits = new AtomicInteger();
        PersonalPendingOpenJsonStore failingOnceStore = new PersonalPendingOpenJsonStore(
            context,
            preferences -> readyCommits.incrementAndGet() > 1
                && preferences.edit()
                    .putString(PersonalPendingOpenJsonStore.PHASE_KEY, PersonalPendingOpenJsonStore.PHASE_READY)
                    .commit()
        );
        String id = UUID.randomUUID().toString();
        byte[] expected = "{\"restored\":\"同一标识重试\"}".getBytes(StandardCharsets.UTF_8);
        failingOnceStore.beginPreparing(id);

        try {
            failingOnceStore.stage(id, new ByteArrayInputStream(expected));
            fail("the injected first READY commit must fail");
        } catch (PersonalPendingOpenJsonStore.StoreException error) {
            assertEquals(PersonalPendingOpenJsonStore.RETRYABLE_STAGE_ERROR, error.code);
            assertTrue(error.preservePendingPayload);
            assertFalse(PersonalExportPlugin.shouldAbortPendingOpenJsonStageFailure(error));
        }

        File committed = new File(
            failingOnceStore.directoryForTesting(),
            id + PersonalPendingOpenJsonStore.FINAL_SUFFIX
        );
        assertTrue("authenticated committed file must remain", committed.isFile());

        // A new instance models process restart. probe() must publish READY for
        // the same UUID and expose exactly the authenticated bytes.
        PersonalPendingOpenJsonStore restarted = new PersonalPendingOpenJsonStore(context);
        PersonalPendingOpenJsonStore.Probe recovered = restarted.probe();
        assertTrue(recovered.available);
        assertEquals(id, recovered.metadata.id);
        assertEquals(expected.length, recovered.metadata.byteLength);
        PersonalPendingOpenJsonStore.Chunk chunk = restarted.readChunk(id, 0L);
        assertArrayEquals(expected, Base64.decode(chunk.chunkBase64, Base64.DEFAULT));
        assertFalse(restarted.acknowledge(id).alreadyAcknowledged);
        assertFalse(restarted.probe().available);
    }

    @Test
    public void acknowledgementRecoversWhenFileDeletionCommittedBeforeJournalCommit()
        throws Exception {
        String id = UUID.randomUUID().toString();
        byte[] payload = "{\"value\":1}".getBytes(StandardCharsets.UTF_8);
        store.beginPreparing(id);
        store.stage(id, new ByteArrayInputStream(payload));
        File directory = store.directoryForTesting();
        File committed = new File(directory, id + PersonalPendingOpenJsonStore.FINAL_SUFFIX);
        assertTrue(committed.delete());
        assertTrue(PersonalExportPlugin.syncDirectory(directory));

        assertFalse(store.acknowledge(id).alreadyAcknowledged);
        assertTrue(store.acknowledge(id).alreadyAcknowledged);
        assertFalse(store.probe().available);
    }

    @Test
    public void privacyPurgeRemovesReadyPayloadAndAcknowledgementHistory() throws Exception {
        String id = UUID.randomUUID().toString();
        store.beginPreparing(id);
        store.stage(id, new ByteArrayInputStream("{\"health\":true}".getBytes(StandardCharsets.UTF_8)));
        assertTrue(store.probe().available);

        assertTrue(store.purgeAll());
        assertFalse(store.probe().available);
        try {
            store.acknowledge(id);
            fail("privacy purge must also remove acknowledgement history");
        } catch (PersonalPendingOpenJsonStore.StoreException error) {
            assertEquals("PENDING_OPEN_JSON_STALE", error.code);
        }
    }

    private static void writeAndSync(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(bytes);
            output.flush();
            output.getFD().sync();
        }
    }
}
