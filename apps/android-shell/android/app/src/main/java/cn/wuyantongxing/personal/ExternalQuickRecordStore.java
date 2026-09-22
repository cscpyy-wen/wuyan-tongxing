package cn.wuyantongxing.personal;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Crash-safe queue written by App Widgets and the Quick Settings tile. */
final class ExternalQuickRecordStore {
    enum EntryPoint {
        APP_WIDGET,
        QUICK_SETTINGS_TILE
    }

    enum Status {
        RECORDED,
        APP_NOT_READY,
        TEMPORARILY_BLOCKED,
        QUEUE_FULL,
        STORAGE_ERROR
    }

    static final class Result {
        final Status status;
        final String id;
        final String smokedAt;

        Result(Status status, String id, String smokedAt) {
            this.status = status;
            this.id = id;
            this.smokedAt = smokedAt;
        }

        static Result failure(Status status) {
            return new Result(status, null, null);
        }
    }

    static final class WidgetSnapshot {
        final boolean available;
        final int todayCount;
        final Long lastSmokedAtMillis;

        WidgetSnapshot(boolean available, int todayCount, Long lastSmokedAtMillis) {
            this.available = available;
            this.todayCount = todayCount;
            this.lastSmokedAtMillis = lastSmokedAtMillis;
        }

        static WidgetSnapshot unavailable() {
            return new WidgetSnapshot(false, 0, null);
        }
    }

    private static final String SUMMARY_FIELD = "_androidBootstrapSummary";
    private static final String IMPORT_MARKER_FIELD = "_androidBootstrapImportTransactionId";
    private static final int MAX_EVENTS = 512;
    private static final int MAX_QUEUE_CHARACTERS = 256 * 1024;
    private static final Pattern UUID_V4 = Pattern.compile(
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern DATE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");

    private final WuyanDurableStore store;

    ExternalQuickRecordStore(WuyanDurableStore store) {
        this.store = store;
    }

    /** Same Beijing day/current attempt as the app, including not-yet-merged clicks. */
    WidgetSnapshot widgetSnapshot(long nowMillis) {
        synchronized (WuyanDurableStore.processFileLock()) {
            try {
                if (hasBlockingTransactionLocked()) return WidgetSnapshot.unavailable();
                JSONObject state = eligibleStateLocked();
                if (state == null) return WidgetSnapshot.unavailable();
                String attemptId = state.getJSONObject("plan").getString("id");
                LocalDate today = Instant.ofEpochMilli(nowMillis).atOffset(ZoneOffset.ofHours(8)).toLocalDate();
                Set<String> seen = new HashSet<>();
                Set<String> deleted = new HashSet<>();
                if (state.has("deletedCigaretteIds")) {
                    JSONArray tombstones = state.getJSONArray("deletedCigaretteIds");
                    for (int index = 0; index < tombstones.length(); index++) {
                        Object value = tombstones.get(index);
                        if (!(value instanceof String) || ((String) value).isEmpty()
                            || ((String) value).length() > 128 || !deleted.add((String) value)) {
                            return WidgetSnapshot.unavailable();
                        }
                    }
                }
                int count = 0;
                Long latest = null;
                JSONArray records = state.getJSONArray("cigarettes");
                // Primary records win over pending copies during the commit -> ack window.
                for (int index = 0; index < records.length(); index++) {
                    JSONObject record = records.getJSONObject(index);
                    String id = strictString(record, "id");
                    String recordAttempt = strictString(record, "attemptId");
                    String time = strictString(record, "createdAt");
                    long quantity = exactInteger(record.opt("count"));
                    if (id.isEmpty() || id.length() > 128 || !seen.add(id)
                        || !validInstant(time) || quantity < 1 || quantity > 100) {
                        return WidgetSnapshot.unavailable();
                    }
                    if (deleted.contains(id) || !attemptId.equals(recordAttempt)) continue;
                    Instant instant = Instant.parse(time);
                    if (instant.atOffset(ZoneOffset.ofHours(8)).toLocalDate().equals(today)) count += (int) quantity;
                    // A clock rollback must never produce a negative elapsed timer.
                    if (instant.toEpochMilli() <= nowMillis && (latest == null || instant.toEpochMilli() > latest)) {
                        latest = instant.toEpochMilli();
                    }
                }
                JSONArray[] queues = { readQueueLocked(), readBootstrapQueueLocked() };
                for (JSONArray events : queues) {
                    for (int index = 0; index < events.length(); index++) {
                        JSONObject event = events.getJSONObject(index);
                        String id = strictString(event, "id");
                        // A committed deletion wins even if queue acknowledgement failed or
                        // the process died before it ran, just as it does in the app importer.
                        if (deleted.contains(id) || !seen.add(id)
                            || !attemptId.equals(event.opt("attemptId"))) continue;
                        Instant instant = Instant.parse(strictString(event, "smokedAt"));
                        if (instant.atOffset(ZoneOffset.ofHours(8)).toLocalDate().equals(today)) count++;
                        if (instant.toEpochMilli() <= nowMillis && (latest == null || instant.toEpochMilli() > latest)) {
                            latest = instant.toEpochMilli();
                        }
                    }
                }
                return new WidgetSnapshot(true, count, latest);
            } catch (JSONException | RuntimeException error) {
                return WidgetSnapshot.unavailable();
            }
        }
    }

    private JSONArray readBootstrapQueueLocked() throws JSONException {
        String raw = store.readValue(WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_KEY);
        if (raw == null) return new JSONArray();
        if (raw.length() > 65_536) throw new JSONException("bootstrap queue too large");
        JSONObject wrapper = new JSONObject(raw);
        JSONArray events = wrapper.getJSONArray("data");
        if (wrapper.length() != 1 || events.length() > 20) throw new JSONException("invalid bootstrap queue");
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < events.length(); index++) {
            JSONObject event = events.getJSONObject(index);
            String id = strictString(event, "id");
            String time = strictString(event, "smokedAt");
            String trigger = strictString(event, "trigger");
            long intensity = exactInteger(event.opt("cravingIntensity"));
            if (!validUuid(id) || !ids.add(id) || !validInstant(time)
                || event.has("entryPoint") || intensity < 1 || intensity > 5
                || !Set.of("work", "meal", "toilet", "stress", "social", "alcohol", "exercise",
                    "boredom", "morning", "coffee", "habit").contains(trigger)
                || (event.has("attemptId") && strictString(event, "attemptId").length() > 128)) {
                throw new JSONException("invalid bootstrap event");
            }
        }
        return events;
    }

    private static String strictString(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof String)) throw new JSONException("invalid string field");
        return (String) value;
    }

    Result recordNow(EntryPoint entryPoint) {
        return record(entryPoint, UUID.randomUUID().toString(), Instant.now().toString());
    }

    Result record(EntryPoint entryPoint, String id, String smokedAt) {
        if (entryPoint == null || !validUuid(id) || !validInstant(smokedAt)) {
            return Result.failure(Status.STORAGE_ERROR);
        }
        synchronized (WuyanDurableStore.processFileLock()) {
            try {
                if (hasBlockingTransactionLocked()) {
                    return Result.failure(Status.TEMPORARILY_BLOCKED);
                }
                JSONObject state = eligibleStateLocked();
                if (state == null) return Result.failure(Status.APP_NOT_READY);
                String attemptId = (String) state.getJSONObject("plan").get("id");
                JSONArray events = readQueueLocked();

                JSONObject event = new JSONObject();
                event.put("id", id);
                event.put("smokedAt", smokedAt);
                event.put("attemptId", attemptId);
                event.put("entryPoint", entryPoint.name());

                JSONObject existing = findById(events, id);
                if (existing != null) {
                    return sameEvent(existing, event)
                        ? new Result(Status.RECORDED, id, smokedAt)
                        : Result.failure(Status.STORAGE_ERROR);
                }
                if (events.length() >= MAX_EVENTS) return Result.failure(Status.QUEUE_FULL);
                events.put(event);

                JSONObject wrapper = new JSONObject();
                wrapper.put("data", events);
                String serialized = wrapper.toString();
                if (serialized.length() > MAX_QUEUE_CHARACTERS) {
                    return Result.failure(Status.QUEUE_FULL);
                }
                store.writeValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY, serialized);

                JSONArray verified = readQueueLocked();
                JSONObject committed = findById(verified, id);
                if (committed == null || !sameEvent(committed, event)) {
                    throw new IllegalStateException("WUYAN_EXTERNAL_QUICK_RECORD_VERIFY_FAILED");
                }
                return new Result(Status.RECORDED, id, smokedAt);
            } catch (JSONException | RuntimeException error) {
                return Result.failure(Status.STORAGE_ERROR);
            }
        }
    }

    static void acknowledge(WuyanDurableStore store, String idsJson) {
        if (store == null || idsJson == null || idsJson.length() > MAX_QUEUE_CHARACTERS) {
            throw new IllegalArgumentException("WUYAN_EXTERNAL_QUICK_RECORD_ACK_INVALID");
        }
        synchronized (WuyanDurableStore.processFileLock()) {
            try {
                JSONArray input = new JSONArray(idsJson);
                if (input.length() > MAX_EVENTS) {
                    throw new IllegalArgumentException("WUYAN_EXTERNAL_QUICK_RECORD_ACK_INVALID");
                }
                Set<String> ids = new HashSet<>();
                for (int index = 0; index < input.length(); index++) {
                    Object value = input.get(index);
                    if (!(value instanceof String) || !validUuid((String) value)) {
                        throw new IllegalArgumentException("WUYAN_EXTERNAL_QUICK_RECORD_ACK_INVALID");
                    }
                    ids.add((String) value);
                }
                if (ids.isEmpty()) return;

                ExternalQuickRecordStore queue = new ExternalQuickRecordStore(store);
                JSONArray current = queue.readQueueLocked();
                JSONArray remaining = new JSONArray();
                for (int index = 0; index < current.length(); index++) {
                    JSONObject event = current.getJSONObject(index);
                    if (!ids.contains(event.getString("id"))) remaining.put(event);
                }
                if (remaining.length() == 0) {
                    store.removeValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY);
                } else {
                    JSONObject wrapper = new JSONObject();
                    wrapper.put("data", remaining);
                    store.writeValue(
                        WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY,
                        wrapper.toString()
                    );
                }

                JSONArray verified = queue.readQueueLocked();
                for (int index = 0; index < verified.length(); index++) {
                    if (ids.contains(verified.getJSONObject(index).getString("id"))) {
                        throw new IllegalStateException("WUYAN_EXTERNAL_QUICK_RECORD_ACK_VERIFY_FAILED");
                    }
                }
            } catch (JSONException error) {
                throw new IllegalArgumentException("WUYAN_EXTERNAL_QUICK_RECORD_ACK_INVALID", error);
            }
        }
    }

    private boolean hasBlockingTransactionLocked() {
        return store.hasValue(WuyanDurableStorePolicy.DELETION_IN_PROGRESS_KEY)
            || store.hasValue(WuyanDurableStorePolicy.BACKUP_RESTORE_INTENT_KEY)
            || store.hasValue(WuyanDurableStorePolicy.BOOTSTRAP_IMPORT_JOURNAL_KEY);
    }

    private JSONObject eligibleStateLocked() throws JSONException {
        String raw;
        if (store.hasValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY)) {
            raw = store.readValue(WuyanDurableStorePolicy.CLIENT_STATE_KEY);
        } else if (store.hasValue(WuyanDurableStorePolicy.LAST_KNOWN_GOOD_KEY)) {
            raw = store.readValue(WuyanDurableStorePolicy.LAST_KNOWN_GOOD_KEY);
        } else {
            return null;
        }
        if (raw == null) return null;
        JSONObject state = new JSONObject(raw);
        if (state.has(IMPORT_MARKER_FIELD)
            || !exactInteger(state.opt("version"), 1)
            || !Boolean.TRUE.equals(state.opt("onboarded"))) return null;
        Object settingsValue = state.opt("settings");
        Object planValue = state.opt("plan");
        Object summaryValue = state.opt(SUMMARY_FIELD);
        Object cigarettesValue = state.opt("cigarettes");
        if (!(settingsValue instanceof JSONObject)
            || !(planValue instanceof JSONObject)
            || !(summaryValue instanceof JSONObject)
            || !(cigarettesValue instanceof JSONArray)) return null;
        JSONObject settings = (JSONObject) settingsValue;
        JSONObject plan = (JSONObject) planValue;
        JSONObject summary = (JSONObject) summaryValue;
        if (!Boolean.TRUE.equals(settings.opt("sensitiveHealthData"))) return null;
        Object planIdValue = plan.opt("id");
        Object summaryPlanIdValue = summary.opt("planId");
        Object dateValue = summary.opt("date");
        if (!(planIdValue instanceof String)
            || !(summaryPlanIdValue instanceof String)
            || !(dateValue instanceof String)) return null;
        String planId = (String) planIdValue;
        String summaryPlanId = (String) summaryPlanIdValue;
        String date = (String) dateValue;
        long count = exactInteger(summary.opt("count"));
        if (planId.isEmpty() || planId.length() > 128
            || summary.length() != 4
            || !exactInteger(summary.opt("version"), 1)
            || !planId.equals(summaryPlanId)
            || !validDate(date)
            || count < 0 || count > 5_000_000) return null;
        return state;
    }

    private JSONArray readQueueLocked() throws JSONException {
        if (!store.hasValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY)) {
            return new JSONArray();
        }
        String raw = store.readValue(WuyanDurableStorePolicy.SYSTEM_SHORTCUT_CIGARETTES_KEY);
        if (raw == null || raw.length() > MAX_QUEUE_CHARACTERS) {
            throw new JSONException("queue unavailable");
        }
        JSONObject wrapper = new JSONObject(raw);
        if (wrapper.length() != 1 || !wrapper.has("data")) throw new JSONException("invalid wrapper");
        JSONArray events = wrapper.optJSONArray("data");
        if (events == null || events.length() > MAX_EVENTS) throw new JSONException("invalid queue");
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < events.length(); index++) {
            JSONObject event = events.optJSONObject(index);
            if (!validEvent(event) || !ids.add(event.getString("id"))) {
                throw new JSONException("invalid event");
            }
        }
        return events;
    }

    private static boolean validEvent(JSONObject event) {
        if (event == null || event.length() != 4) return false;
        // JSONObject.optString coerces numbers/booleans; the JS importer does not.
        // Never accept and rewrite a corrupt queue that the app cannot consume.
        for (String field : new String[] { "id", "smokedAt", "attemptId", "entryPoint" }) {
            if (!(event.opt(field) instanceof String)) return false;
        }
        String id = event.optString("id", "");
        String smokedAt = event.optString("smokedAt", "");
        String attemptId = event.optString("attemptId", "");
        String entryPoint = event.optString("entryPoint", "");
        return validUuid(id)
            && validInstant(smokedAt)
            && !attemptId.isEmpty()
            && attemptId.length() <= 128
            && (EntryPoint.APP_WIDGET.name().equals(entryPoint)
                || EntryPoint.QUICK_SETTINGS_TILE.name().equals(entryPoint));
    }

    private static JSONObject findById(JSONArray events, String id) throws JSONException {
        for (int index = 0; index < events.length(); index++) {
            JSONObject event = events.getJSONObject(index);
            if (id.equals(event.getString("id"))) return event;
        }
        return null;
    }

    private static boolean sameEvent(JSONObject left, JSONObject right) {
        return left.length() == 4
            && right.length() == 4
            && left.optString("id", "").equals(right.optString("id", ""))
            && left.optString("smokedAt", "").equals(right.optString("smokedAt", ""))
            && left.optString("attemptId", "").equals(right.optString("attemptId", ""))
            && left.optString("entryPoint", "").equals(right.optString("entryPoint", ""));
    }

    private static boolean validUuid(String value) {
        return value != null && UUID_V4.matcher(value).matches();
    }

    private static boolean validInstant(String value) {
        if (value == null || value.length() > 64) return false;
        try {
            Instant.parse(value);
            return true;
        } catch (DateTimeParseException error) {
            return false;
        }
    }

    private static boolean validDate(String value) {
        if (value == null || !DATE.matcher(value).matches()) return false;
        try {
            return LocalDate.parse(value).toString().equals(value);
        } catch (DateTimeParseException error) {
            return false;
        }
    }

    private static boolean exactInteger(Object value, long expected) {
        return exactInteger(value) == expected;
    }

    private static long exactInteger(Object value) {
        if (!(value instanceof Number)) return Long.MIN_VALUE;
        double candidate = ((Number) value).doubleValue();
        if (!Double.isFinite(candidate)
            || candidate != Math.rint(candidate)
            || candidate < Long.MIN_VALUE
            || candidate > Long.MAX_VALUE) return Long.MIN_VALUE;
        return (long) candidate;
    }
}
