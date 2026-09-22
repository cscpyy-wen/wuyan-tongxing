package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.time.Instant;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class ExternalQuickRecordStoreInstrumentedTest {
    private static final String ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    private File testDirectory;
    private WuyanDurableStore durableStore;
    private ExternalQuickRecordStore quickRecordStore;

    @Before
    public void setUp() throws Exception {
        File isolatedCache = InstrumentationRegistry
            .getInstrumentation()
            .getTargetContext()
            .getCacheDir();
        testDirectory = new File(
            isolatedCache,
            "wuyan-external-quick-record-test-" + UUID.randomUUID()
        );
        durableStore = new WuyanDurableStore(testDirectory);
        quickRecordStore = new ExternalQuickRecordStore(durableStore);
        writeEligibleState(true, true);
    }

    @After
    public void tearDown() {
        deleteTree(testDirectory);
    }

    @Test
    public void widgetRecordsOnlyIdentityTimeAttemptAndEntryPoint() throws Exception {
        String id = "11111111-1111-4111-8111-111111111111";
        String smokedAt = "2026-09-19T08:12:34.567Z";

        ExternalQuickRecordStore.Result result = quickRecordStore.record(
            ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
            id,
            smokedAt
        );

        assertEquals(ExternalQuickRecordStore.Status.RECORDED, result.status);
        assertEquals(id, result.id);
        assertEquals(smokedAt, result.smokedAt);
        JSONObject event = queue().getJSONObject(0);
        assertEquals(4, event.length());
        assertEquals(id, event.getString("id"));
        assertEquals(smokedAt, event.getString("smokedAt"));
        assertEquals(ATTEMPT_ID, event.getString("attemptId"));
        assertEquals("APP_WIDGET", event.getString("entryPoint"));
        assertFalse(event.has("trigger"));
        assertFalse(event.has("cravingIntensity"));
    }

    @Test
    public void acknowledgementRemovesOnlyCommittedIds() throws Exception {
        String widgetId = "22222222-2222-4222-8222-222222222222";
        String tileId = "33333333-3333-4333-8333-333333333333";
        assertEquals(
            ExternalQuickRecordStore.Status.RECORDED,
            quickRecordStore.record(
                ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
                widgetId,
                "2026-09-19T08:13:00Z"
            ).status
        );
        assertEquals(
            ExternalQuickRecordStore.Status.RECORDED,
            quickRecordStore.record(
                ExternalQuickRecordStore.EntryPoint.QUICK_SETTINGS_TILE,
                tileId,
                "2026-09-19T08:14:00Z"
            ).status
        );
        ExternalQuickRecordStore.Result duplicateConflict = quickRecordStore.record(
            ExternalQuickRecordStore.EntryPoint.QUICK_SETTINGS_TILE,
            tileId,
            "2026-09-19T08:14:01Z"
        );
        assertEquals(ExternalQuickRecordStore.Status.STORAGE_ERROR, duplicateConflict.status);
        assertEquals(2, queue().length());

        ExternalQuickRecordStore.acknowledge(
            durableStore,
            new JSONArray().put(widgetId).toString()
        );

        JSONArray remaining = queue();
        assertEquals(1, remaining.length());
        assertEquals(tileId, remaining.getJSONObject(0).getString("id"));
        assertEquals("QUICK_SETTINGS_TILE", remaining.getJSONObject(0).getString("entryPoint"));
    }

    @Test
    public void activeDataTransactionsBlockQuickRecording() throws Exception {
        String[] blockers = {
            WuyanDurableStorePolicy.DELETION_IN_PROGRESS_KEY,
            WuyanDurableStorePolicy.BACKUP_RESTORE_INTENT_KEY,
            WuyanDurableStorePolicy.BOOTSTRAP_IMPORT_JOURNAL_KEY,
        };
        for (int index = 0; index < blockers.length; index++) {
            durableStore.writeValue(blockers[index], "{\"version\":1}");
            ExternalQuickRecordStore.Result result = quickRecordStore.record(
                ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
                String.format(Locale.ROOT, "44444444-4444-4444-8444-%012x", index + 1),
                String.format(Locale.ROOT, "2026-09-19T08:15:%02dZ", index)
            );
            assertEquals(ExternalQuickRecordStore.Status.TEMPORARILY_BLOCKED, result.status);
            durableStore.removeValue(blockers[index]);
        }
        assertFalse(durableStore.hasValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY));
    }

    @Test
    public void unfinishedOnboardingOrMissingConsentDoesNotRecord() throws Exception {
        durableStore.removeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY);
        durableStore.removeValue(WuyanDurableStorePolicy.LAST_KNOWN_GOOD_KEY);
        ExternalQuickRecordStore.Result missing = quickRecordStore.record(
            ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
            "55555555-5555-4555-8555-555555555551",
            "2026-09-19T08:16:00Z"
        );
        assertEquals(ExternalQuickRecordStore.Status.APP_NOT_READY, missing.status);

        writeEligibleState(true, false);
        ExternalQuickRecordStore.Result noConsent = quickRecordStore.record(
            ExternalQuickRecordStore.EntryPoint.QUICK_SETTINGS_TILE,
            "55555555-5555-4555-8555-555555555552",
            "2026-09-19T08:17:00Z"
        );
        assertEquals(ExternalQuickRecordStore.Status.APP_NOT_READY, noConsent.status);

        JSONObject wrongTypedState = new JSONObject();
        wrongTypedState.put("version", "1");
        wrongTypedState.put("onboarded", "true");
        wrongTypedState.put("settings", new JSONObject().put("sensitiveHealthData", "true"));
        wrongTypedState.put("plan", new JSONObject().put("id", ATTEMPT_ID));
        wrongTypedState.put("cigarettes", new JSONArray());
        wrongTypedState.put(
            "_androidBootstrapSummary",
            new JSONObject()
                .put("version", "1")
                .put("planId", ATTEMPT_ID)
                .put("date", "2026-09-19")
                .put("count", "0")
        );
        durableStore.writeValue(
            WuyanDurableStorePolicy.CLIENT_STATE_KEY,
            wrongTypedState.toString()
        );
        ExternalQuickRecordStore.Result wrongTypes = quickRecordStore.record(
            ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
            "55555555-5555-4555-8555-555555555553",
            "2026-09-19T08:17:01Z"
        );
        assertEquals(ExternalQuickRecordStore.Status.APP_NOT_READY, wrongTypes.status);
        assertFalse(durableStore.hasValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY));
    }

    @Test
    public void corruptQueueFailsClosedWithoutOverwritingEvidence() {
        String corrupt = "{\"data\":[{\"id\":\"not-a-complete-event\"}]}";
        durableStore.writeValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY, corrupt);

        ExternalQuickRecordStore.Result result = quickRecordStore.record(
            ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
            "66666666-6666-4666-8666-666666666666",
            "2026-09-19T08:18:00Z"
        );

        assertEquals(ExternalQuickRecordStore.Status.STORAGE_ERROR, result.status);
        assertEquals(
            corrupt,
            durableStore.readValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY)
        );
    }

    @Test
    public void concurrentClicksCommitEveryUniqueEventExactlyOnce() throws Exception {
        int clickCount = 32;
        ExecutorService executor = Executors.newFixedThreadPool(clickCount);
        CountDownLatch ready = new CountDownLatch(clickCount);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch finished = new CountDownLatch(clickCount);
        Set<ExternalQuickRecordStore.Status> failures = java.util.Collections.synchronizedSet(
            new HashSet<>()
        );
        for (int index = 0; index < clickCount; index++) {
            final int click = index;
            executor.execute(() -> {
                ready.countDown();
                try {
                    start.await(10, TimeUnit.SECONDS);
                    ExternalQuickRecordStore.Result result = quickRecordStore.record(
                        click % 2 == 0
                            ? ExternalQuickRecordStore.EntryPoint.APP_WIDGET
                            : ExternalQuickRecordStore.EntryPoint.QUICK_SETTINGS_TILE,
                        String.format(Locale.ROOT, "77777777-7777-4777-8777-%012x", click + 1),
                        String.format(Locale.ROOT, "2026-09-19T08:19:%02dZ", click)
                    );
                    if (result.status != ExternalQuickRecordStore.Status.RECORDED) {
                        failures.add(result.status);
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    failures.add(ExternalQuickRecordStore.Status.STORAGE_ERROR);
                } finally {
                    finished.countDown();
                }
            });
        }
        assertTrue(ready.await(10, TimeUnit.SECONDS));
        start.countDown();
        assertTrue(finished.await(30, TimeUnit.SECONDS));
        executor.shutdownNow();

        assertTrue(failures.toString(), failures.isEmpty());
        JSONArray events = queue();
        assertEquals(clickCount, events.length());
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < events.length(); index++) {
            ids.add(events.getJSONObject(index).getString("id"));
        }
        assertEquals(clickCount, ids.size());
    }

    @Test
    public void widgetSnapshotUnionsAppAndBothQueuesWithoutDoubleCounting() throws Exception {
        String first = "88888888-8888-4888-8888-888888888881";
        String pending = "88888888-8888-4888-8888-888888888882";
        String bootstrap = "88888888-8888-4888-8888-888888888883";
        JSONObject state = state();
        state.getJSONArray("cigarettes").put(log(first, "2026-09-19T07:00:00Z", 1, ATTEMPT_ID));
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        quickRecordStore.record(ExternalQuickRecordStore.EntryPoint.APP_WIDGET, first, "2026-09-19T07:00:00Z");
        quickRecordStore.record(ExternalQuickRecordStore.EntryPoint.QUICK_SETTINGS_TILE, pending, "2026-09-19T08:05:00Z");
        durableStore.writeValue(WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_KEY,
            new JSONObject().put("data", new JSONArray().put(new JSONObject()
                .put("id", bootstrap).put("smokedAt", "2026-09-19T08:00:00Z")
                .put("attemptId", ATTEMPT_ID).put("trigger", "work").put("cravingIntensity", 3))).toString());

        ExternalQuickRecordStore.WidgetSnapshot snapshot = quickRecordStore.widgetSnapshot(millis("2026-09-19T08:30:00Z"));
        assertTrue(snapshot.available);
        assertEquals(3, snapshot.todayCount);
        assertEquals(Long.valueOf(millis("2026-09-19T08:05:00Z")), snapshot.lastSmokedAtMillis);
    }

    @Test
    public void everyClickChangesWidgetTotalAndMergeAcknowledgementKeepsItStable() throws Exception {
        JSONArray ids = new JSONArray();
        JSONObject state = state();
        long now = millis("2026-09-19T08:30:00Z");
        for (int index = 1; index <= 12; index++) {
            String id = UUID.randomUUID().toString();
            String time = String.format(Locale.ROOT, "2026-09-19T08:20:%02dZ", index);
            assertEquals(ExternalQuickRecordStore.Status.RECORDED,
                quickRecordStore.record(ExternalQuickRecordStore.EntryPoint.APP_WIDGET, id, time).status);
            ids.put(id);
            state.getJSONArray("cigarettes").put(log(id, time, 1, ATTEMPT_ID));
            assertEquals(index, quickRecordStore.widgetSnapshot(now).todayCount);
        }
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        assertEquals(12, quickRecordStore.widgetSnapshot(now).todayCount);
        ExternalQuickRecordStore.acknowledge(durableStore, ids.toString());
        assertEquals(12, quickRecordStore.widgetSnapshot(now).todayCount);
    }

    @Test
    public void midnightResetsOnlyTodayCountAndIgnoresOtherAttempts() throws Exception {
        JSONObject state = state();
        state.getJSONArray("cigarettes")
            .put(log("old-attempt", "2026-09-19T16:00:00Z", 7, "old"))
            .put(log("last", "2026-09-19T15:59:50Z", 2, ATTEMPT_ID));
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        long before = millis("2026-09-19T15:59:59Z");
        long after = millis("2026-09-19T16:00:01Z");
        assertEquals(2, quickRecordStore.widgetSnapshot(before).todayCount);
        ExternalQuickRecordStore.WidgetSnapshot midnight = quickRecordStore.widgetSnapshot(after);
        assertEquals(0, midnight.todayCount);
        assertEquals(Long.valueOf(millis("2026-09-19T15:59:50Z")), midnight.lastSmokedAtMillis);
        assertEquals(millis("2026-09-19T16:00:00Z"), QuickRecordWidgetUpdater.nextMidnight(before));
        assertEquals(millis("2026-09-20T16:00:00Z"), QuickRecordWidgetUpdater.nextMidnight(after));
    }

    @Test
    public void widgetReflectsEditsRemovalAndFailsClosedDuringSensitiveDataChanges() throws Exception {
        long now = millis("2026-09-19T08:30:00Z");
        JSONObject state = state();
        state.getJSONArray("cigarettes").put(log("edited", "2026-09-18T08:00:00Z", 1, ATTEMPT_ID));
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        assertEquals(0, quickRecordStore.widgetSnapshot(now).todayCount);
        state.getJSONArray("cigarettes").getJSONObject(0).put("createdAt", "2026-09-19T08:00:00Z");
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        assertEquals(1, quickRecordStore.widgetSnapshot(now).todayCount);
        state.put("cigarettes", new JSONArray());
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        assertEquals(0, quickRecordStore.widgetSnapshot(now).todayCount);
        assertNull(quickRecordStore.widgetSnapshot(now).lastSmokedAtMillis);
        durableStore.writeValue(WuyanDurableStorePolicy.DELETION_IN_PROGRESS_KEY, "{\"version\":1}");
        assertFalse(quickRecordStore.widgetSnapshot(now).available);
        durableStore.removeValue(WuyanDurableStorePolicy.DELETION_IN_PROGRESS_KEY);
        writeEligibleState(true, false);
        assertFalse(quickRecordStore.widgetSnapshot(now).available);
        writeEligibleState(true, true);
        durableStore.writeValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY, "{\"data\":[{}]}");
        assertFalse(quickRecordStore.widgetSnapshot(now).available);
    }

    @Test
    public void elapsedTimeSurvivesRebootAndNeverRunsNegativeAfterClockRollback() throws Exception {
        long now = millis("2026-09-19T08:30:00Z");
        assertEquals(-7_140_000, QuickRecordWidgetUpdater.chronometerBase(now, 60_000, now - 7_200_000));
        assertEquals(60_000, QuickRecordWidgetUpdater.chronometerBase(now, 60_000, now + 3_600_000));
        JSONObject state = state();
        state.getJSONArray("cigarettes").put(log("future", "2026-09-19T09:00:00Z", 1, ATTEMPT_ID));
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        assertNull(quickRecordStore.widgetSnapshot(now).lastSmokedAtMillis);
    }

    @Test
    public void remoteWidgetShowsNumbersAndAnActualChronometerWithoutStatusCopy() {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            long now = System.currentTimeMillis();
            long uptime = android.os.SystemClock.elapsedRealtime();
            android.widget.RemoteViews remote = QuickRecordWidgetUpdater.views(context,
                new ExternalQuickRecordStore.WidgetSnapshot(true, 12, now - 125_000), now, uptime);
            android.view.View view = remote.apply(context, new android.widget.FrameLayout(context));
            android.widget.TextView count = view.findViewById(R.id.quick_record_widget_count);
            android.widget.Chronometer timer = view.findViewById(R.id.quick_record_widget_timer);
            assertEquals("12", count.getText().toString());
            assertEquals(android.view.View.VISIBLE, timer.getVisibility());
            assertEquals(uptime - 125_000, timer.getBase());
            assertEquals(android.view.View.GONE, view.findViewById(R.id.quick_record_widget_empty_timer).getVisibility());
            QuickRecordWidgetUpdater.views(context,
                new ExternalQuickRecordStore.WidgetSnapshot(true, 0, null), now, uptime).reapply(context, view);
            assertEquals("0", count.getText().toString());
            assertEquals(android.view.View.GONE, timer.getVisibility());
            assertEquals(android.view.View.VISIBLE, view.findViewById(R.id.quick_record_widget_empty_timer).getVisibility());
        });
    }

    @Test
    public void widgetNeverRevivesDeletedRecordsFromEitherPendingQueue() throws Exception {
        long now = millis("2026-09-19T08:30:00Z");
        String systemId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        String bootstrapId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        quickRecordStore.record(ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
            systemId, "2026-09-19T08:20:00Z");
        JSONObject bootstrap = new JSONObject().put("id", bootstrapId)
            .put("attemptId", ATTEMPT_ID).put("smokedAt", "2026-09-19T08:25:00Z")
            .put("trigger", "work").put("cravingIntensity", 3);
        durableStore.writeValue(WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_KEY,
            new JSONObject().put("data", new JSONArray().put(bootstrap)).toString());
        assertEquals(2, quickRecordStore.widgetSnapshot(now).todayCount);
        JSONObject state = state();
        state.put("deletedCigaretteIds", new JSONArray().put(systemId).put(bootstrapId));
        state.getJSONArray("cigarettes").put(log("kept", "2026-09-19T07:00:00Z", 1, ATTEMPT_ID));
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        ExternalQuickRecordStore.WidgetSnapshot snapshot = quickRecordStore.widgetSnapshot(now);
        assertTrue(snapshot.available);
        assertEquals(1, snapshot.todayCount);
        assertEquals(Long.valueOf(millis("2026-09-19T07:00:00Z")), snapshot.lastSmokedAtMillis);
        // Rendering is read-only: preserve the pending evidence until the app acknowledges it.
        assertEquals(1, queue().length());
        state.put("deletedCigaretteIds", new JSONArray().put(17));
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
        assertFalse(quickRecordStore.widgetSnapshot(now).available);
    }

    @Test
    public void wrongTypedQueueIdentityFailsWithoutCoercionOrMutation() throws Exception {
        for (Object invalid : new Object[] { 42, true, new JSONObject(), JSONObject.NULL }) {
            JSONObject event = new JSONObject()
                .put("id", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
                .put("smokedAt", "2026-09-19T08:00:00Z")
                .put("attemptId", invalid).put("entryPoint", "APP_WIDGET");
            String raw = new JSONObject().put("data", new JSONArray().put(event)).toString();
            durableStore.writeValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY, raw);
            assertFalse(quickRecordStore.widgetSnapshot(millis("2026-09-19T08:30:00Z")).available);
            assertEquals(ExternalQuickRecordStore.Status.STORAGE_ERROR,
                quickRecordStore.record(ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
                    "ffffffff-ffff-4fff-8fff-ffffffffffff", "2026-09-19T08:20:00Z").status);
            assertEquals(raw, durableStore.readValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY));
        }
    }

    private JSONObject state() throws Exception {
        return new JSONObject(durableStore.readValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY));
    }

    private static long millis(String value) {
        return Instant.parse(value).toEpochMilli();
    }

    private static JSONObject log(String id, String time, int count, String attempt) throws Exception {
        return new JSONObject().put("id", id).put("createdAt", time).put("count", count).put("attemptId", attempt);
    }

    private void writeEligibleState(boolean onboarded, boolean consent) throws Exception {
        JSONObject state = new JSONObject();
        state.put("version", 1);
        state.put("onboarded", onboarded);
        state.put("settings", new JSONObject().put("sensitiveHealthData", consent));
        state.put("plan", new JSONObject().put("id", ATTEMPT_ID));
        state.put("cigarettes", new JSONArray());
        state.put(
            "_androidBootstrapSummary",
            new JSONObject()
                .put("version", 1)
                .put("planId", ATTEMPT_ID)
                .put("date", "2026-09-19")
                .put("count", 0)
        );
        durableStore.writeValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY, state.toString());
    }

    private JSONArray queue() throws Exception {
        String raw = durableStore.readValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY);
        assertFalse(raw == null);
        return new JSONObject(raw).getJSONArray("data");
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        if (!file.delete() && file.exists()) {
            throw new AssertionError("Unable to clean isolated quick-record test data");
        }
    }
}
