package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class PersonalPendingOpenJsonStorePolicyTest {
    private static final String ID = "11111111-1111-4111-8111-111111111111";
    private static final String SHA = "a".repeat(64);

    @Test
    public void journalDistinguishesNonePreparingReadyAndCorrupt() {
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.NONE,
            PersonalPendingOpenJsonStore.journalStatus(new HashMap<>())
        );

        Map<String, Object> preparing = new HashMap<>();
        preparing.put(PersonalPendingOpenJsonStore.PHASE_KEY, PersonalPendingOpenJsonStore.PHASE_PREPARING);
        preparing.put(PersonalPendingOpenJsonStore.ID_KEY, ID);
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.PREPARING,
            PersonalPendingOpenJsonStore.journalStatus(preparing)
        );

        Map<String, Object> preparingAfterFileSync = new HashMap<>(preparing);
        preparingAfterFileSync.put(PersonalPendingOpenJsonStore.BYTE_LENGTH_KEY, 7L);
        preparingAfterFileSync.put(PersonalPendingOpenJsonStore.SHA256_KEY, SHA);
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.PREPARING,
            PersonalPendingOpenJsonStore.journalStatus(preparingAfterFileSync)
        );

        Map<String, Object> ready = new HashMap<>(preparingAfterFileSync);
        ready.put(PersonalPendingOpenJsonStore.PHASE_KEY, PersonalPendingOpenJsonStore.PHASE_READY);
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.READY,
            PersonalPendingOpenJsonStore.journalStatus(ready)
        );

        Map<String, Object> incompleteReady = new HashMap<>(preparing);
        incompleteReady.put(PersonalPendingOpenJsonStore.PHASE_KEY, PersonalPendingOpenJsonStore.PHASE_READY);
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
            PersonalPendingOpenJsonStore.journalStatus(incompleteReady)
        );
    }

    @Test
    public void journalRejectsWrongTypesPartialFingerprintsAndUnsafeBounds() {
        Map<String, Object> values = validReady();
        for (Object wrongPhase : new Object[] { 1, true, "future" }) {
            Map<String, Object> candidate = new HashMap<>(values);
            candidate.put(PersonalPendingOpenJsonStore.PHASE_KEY, wrongPhase);
            assertEquals(
                PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
                PersonalPendingOpenJsonStore.journalStatus(candidate)
            );
        }
        for (Object wrongId : new Object[] { 1L, "../escape", "11111111-1111-1111-1111-111111111111" }) {
            Map<String, Object> candidate = new HashMap<>(values);
            candidate.put(PersonalPendingOpenJsonStore.ID_KEY, wrongId);
            assertEquals(
                PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
                PersonalPendingOpenJsonStore.journalStatus(candidate)
            );
        }
        for (Object wrongBytes : new Object[] { 1, 1.0d, "1", 0L, -1L, (long) PersonalFilePolicy.MAX_JSON_BYTES + 1L }) {
            Map<String, Object> candidate = new HashMap<>(values);
            candidate.put(PersonalPendingOpenJsonStore.BYTE_LENGTH_KEY, wrongBytes);
            assertEquals(
                PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
                PersonalPendingOpenJsonStore.journalStatus(candidate)
            );
        }
        for (Object wrongSha : new Object[] { 1, "a".repeat(63), "A".repeat(64), "z".repeat(64) }) {
            Map<String, Object> candidate = new HashMap<>(values);
            candidate.put(PersonalPendingOpenJsonStore.SHA256_KEY, wrongSha);
            assertEquals(
                PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
                PersonalPendingOpenJsonStore.journalStatus(candidate)
            );
        }
        Map<String, Object> partial = new HashMap<>(values);
        partial.remove(PersonalPendingOpenJsonStore.SHA256_KEY);
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
            PersonalPendingOpenJsonStore.journalStatus(partial)
        );
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
            PersonalPendingOpenJsonStore.journalStatus(null)
        );
    }

    @Test
    public void offsetsAcceptOnlyMonotonicSafeIntegerBounds() {
        assertEquals(Long.valueOf(0L), PersonalPendingOpenJsonStore.exactOffset(0));
        assertEquals(Long.valueOf(1L), PersonalPendingOpenJsonStore.exactOffset(1L));
        assertEquals(
            Long.valueOf(PersonalFilePolicy.MAX_JSON_BYTES),
            PersonalPendingOpenJsonStore.exactOffset((double) PersonalFilePolicy.MAX_JSON_BYTES)
        );
        for (Object invalid : new Object[] {
            null, "0", true, -1, 1.5d, Double.NaN, Double.POSITIVE_INFINITY,
            (long) PersonalFilePolicy.MAX_JSON_BYTES + 1L,
        }) {
            assertNull(PersonalPendingOpenJsonStore.exactOffset(invalid));
        }
    }

    @Test
    public void optionalDisplayMetadataIsStrictButBackwardCompatible() {
        Map<String, Object> legacy = validReady();
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.READY,
            PersonalPendingOpenJsonStore.journalStatus(legacy)
        );

        Map<String, Object> withMetadata = new HashMap<>(legacy);
        withMetadata.put(PersonalPendingOpenJsonStore.DISPLAY_NAME_KEY, "戒烟备份.json");
        withMetadata.put(PersonalPendingOpenJsonStore.LAST_MODIFIED_KEY, 1_787_968_923_000L);
        assertEquals(
            PersonalPendingOpenJsonStore.JournalStatus.READY,
            PersonalPendingOpenJsonStore.journalStatus(withMetadata)
        );
        assertEquals("戒烟备份.json", PersonalPendingOpenJsonStore.sanitizeDisplayName(" 戒烟备份.json "));
        assertNull(PersonalPendingOpenJsonStore.sanitizeDisplayName("../backup.json"));

        for (Object invalid : new Object[] { 0L, -1L, 1, "1787968923000" }) {
            Map<String, Object> candidate = new HashMap<>(withMetadata);
            candidate.put(PersonalPendingOpenJsonStore.LAST_MODIFIED_KEY, invalid);
            assertEquals(
                PersonalPendingOpenJsonStore.JournalStatus.CORRUPT,
                PersonalPendingOpenJsonStore.journalStatus(candidate)
            );
        }
    }

    private static Map<String, Object> validReady() {
        Map<String, Object> values = new HashMap<>();
        values.put(PersonalPendingOpenJsonStore.PHASE_KEY, PersonalPendingOpenJsonStore.PHASE_READY);
        values.put(PersonalPendingOpenJsonStore.ID_KEY, ID);
        values.put(PersonalPendingOpenJsonStore.BYTE_LENGTH_KEY, 7L);
        values.put(PersonalPendingOpenJsonStore.SHA256_KEY, SHA);
        return values;
    }
}
