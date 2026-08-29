package cn.wuyantongxing.personal;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class WuyanDurableStorePolicyTest {
    @Test
    public void onlyExactKeysMapToFixedFilenames() {
        assertEquals(
            "client-state-v1.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.CLIENT_STATE_KEY
            )
        );
        assertEquals(
            "client-state-v1-last-known-good.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.LAST_KNOWN_GOOD_KEY
            )
        );
        assertEquals(
            "client-state-v1-deletion-in-progress.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.DELETION_IN_PROGRESS_KEY
            )
        );
        assertEquals(
            "android-bootstrap-cigarettes-v1.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_KEY
            )
        );
        assertEquals(
            "android-bootstrap-cigarettes-quarantine-v1.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_QUARANTINE_KEY
            )
        );
        assertEquals(
            "android-bootstrap-cigarettes-corrupt-v1.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_CORRUPT_KEY
            )
        );
        assertEquals(
            "android-bootstrap-import-journal-v1.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.BOOTSTRAP_IMPORT_JOURNAL_KEY
            )
        );
        assertEquals(
            "android-backup-restore-intent-v1.json",
            WuyanDurableStorePolicy.filenameForKey(
                WuyanDurableStorePolicy.BACKUP_RESTORE_INTENT_KEY
            )
        );

        assertThrows(
            IllegalArgumentException.class,
            () -> WuyanDurableStorePolicy.filenameForKey(null)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WuyanDurableStorePolicy.filenameForKey("")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WuyanDurableStorePolicy.filenameForKey("../client-state-v1")
        );
        assertThrows(
            IllegalArgumentException.class,
            () ->
                WuyanDurableStorePolicy.filenameForKey(
                    WuyanDurableStorePolicy.CLIENT_STATE_KEY + "/extra"
                )
        );
    }

    @Test
    public void jsonValidationIsStrictAndRejectsEmptyInput() {
        String[] validValues = {
            "{}",
            "[]",
            "null",
            "true",
            "\"戒烟\"",
            "-1.25e+3",
            "{\"state\":[1,false,null,{\"escaped\":\"a\\\\b\\n\"}]}"
        };
        for (String value : validValues) {
            assertArrayEquals(
                value.getBytes(StandardCharsets.UTF_8),
                WuyanDurableStorePolicy.encodeJsonValue(value)
            );
        }

        String[] invalidValues = {
            "",
            "   ",
            "{",
            "{'state':1}",
            "[1,]",
            "01",
            "true false",
            "NaN",
            "\"line\nfeed\""
        };
        for (String value : invalidValues) {
            assertThrows(
                IllegalArgumentException.class,
                () -> WuyanDurableStorePolicy.encodeJsonValue(value)
            );
        }
        assertThrows(
            IllegalArgumentException.class,
            () -> WuyanDurableStorePolicy.encodeJsonValue(null)
        );
    }

    @Test
    public void utf8LimitAllowsExactlyFourMibAndRejectsOneByteMore() {
        String exact = "\"" + "a".repeat(WuyanDurableStorePolicy.MAX_VALUE_BYTES - 2) + "\"";
        assertEquals(
            WuyanDurableStorePolicy.MAX_VALUE_BYTES,
            WuyanDurableStorePolicy.encodeJsonValue(exact).length
        );

        String oversized = exact.substring(0, exact.length() - 1) + "a\"";
        IllegalArgumentException error = assertThrows(
            IllegalArgumentException.class,
            () -> WuyanDurableStorePolicy.encodeJsonValue(oversized)
        );
        assertEquals("WUYAN_DURABLE_STORE_VALUE_TOO_LARGE", error.getMessage());
    }
}
