package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.UUID;
import org.junit.Test;

public class PersonalFilePolicyTest {
    @Test
    public void filenamesAreSanitizedAndBounded() {
        assertEquals("backup.json", PersonalFilePolicy.safeFilename("backup"));
        assertEquals("secret.json", PersonalFilePolicy.safeFilename("../secret.json"));
        assertEquals(PersonalFilePolicy.DEFAULT_FILENAME, PersonalFilePolicy.safeFilename(" "));
        assertEquals(PersonalFilePolicy.DEFAULT_FILENAME, PersonalFilePolicy.safeFilename("a".repeat(121)));
    }

    @Test
    public void sessionTokensAreStrictUuidShape() {
        String token = UUID.randomUUID().toString();
        assertTrue(PersonalFilePolicy.isValidSessionToken(token));
        assertTrue(PersonalFilePolicy.isValidPendingFilename(token + ".pending-json"));
        assertFalse(PersonalFilePolicy.isValidPendingFilename(token + ".json"));
        assertFalse(PersonalFilePolicy.isValidPendingFilename("../" + token + ".pending-json"));
        assertFalse(PersonalFilePolicy.isValidSessionToken("../../files"));
        assertFalse(PersonalFilePolicy.isValidSessionToken("------------------------------------"));
        assertFalse(PersonalFilePolicy.isValidSessionToken("11111111-1111-1111-1111-111111111111"));
        assertFalse(PersonalFilePolicy.isValidSessionToken(null));
    }

    @Test
    public void jsonLimitCountsUtf8Bytes() {
        assertEquals(12 * 1024 * 1024, PersonalFilePolicy.MAX_JSON_BYTES);
        assertTrue(PersonalFilePolicy.isJsonSizeAllowed("{}"));
        assertTrue(PersonalFilePolicy.isJsonSizeAllowed("a".repeat(PersonalFilePolicy.MAX_JSON_BYTES)));
        assertFalse(PersonalFilePolicy.isJsonSizeAllowed("a".repeat(PersonalFilePolicy.MAX_JSON_BYTES + 1)));
        assertTrue(PersonalFilePolicy.isJsonSizeAllowed("戒".repeat(PersonalFilePolicy.MAX_JSON_BYTES / 3)));
        assertFalse(PersonalFilePolicy.isJsonSizeAllowed("戒".repeat(PersonalFilePolicy.MAX_JSON_BYTES / 3 + 1)));
        assertFalse(PersonalFilePolicy.isJsonSizeAllowed(null));
    }

    @Test
    public void utf8CounterIsStrictAndStopsAtTheBoundWithoutAllocatingEncodedBytes() {
        assertEquals(1L, PersonalFilePolicy.utf8ByteLength("a", 4));
        assertEquals(3L, PersonalFilePolicy.utf8ByteLength("戒", 4));
        assertEquals(4L, PersonalFilePolicy.utf8ByteLength("\ud83d\ude00", 4));
        assertEquals(5L, PersonalFilePolicy.utf8ByteLength("\ud83d\ude00a", 4));
        assertEquals(-1L, PersonalFilePolicy.utf8ByteLength("\ud800", 4));
        assertEquals(-1L, PersonalFilePolicy.utf8ByteLength("\udc00", 4));
    }

    @Test
    public void bridgeEstimatorRejectsWorstEscapeRecoveryButAllowsLowEscapeBundle() {
        String lowEscape = "{\"readStatus\":{},\"primary\":\"" + "A".repeat(1024)
            + "\",\"lastKnownGood\":\"B\",\"_recoveryIntegrity\":{}}";
        long lowRaw = PersonalFilePolicy.utf8ByteLength(lowEscape, PersonalFilePolicy.MAX_JSON_BYTES);
        long lowEnvelope = PersonalFilePolicy.jsonStringEscapedUtf8ByteLength(
            lowEscape,
            PersonalFilePolicy.MAX_SAVE_BRIDGE_ESCAPED_BYTES
        );
        assertTrue(PersonalFilePolicy.isLowEscapeRecoveryBundle(lowEscape, lowRaw, lowEnvelope));

        String worstEscape = "{\"readStatus\":{},\"primary\":\""
            + "\\".repeat(PersonalFilePolicy.MAX_RECOVERY_ESCAPE_OVERHEAD_BYTES + 1)
            + "\",\"lastKnownGood\":\"B\",\"_recoveryIntegrity\":{}}";
        long worstRaw = PersonalFilePolicy.utf8ByteLength(worstEscape, PersonalFilePolicy.MAX_JSON_BYTES);
        long worstEnvelope = PersonalFilePolicy.jsonStringEscapedUtf8ByteLength(
            worstEscape,
            PersonalFilePolicy.MAX_SAVE_BRIDGE_ESCAPED_BYTES
        );
        assertFalse(PersonalFilePolicy.isLowEscapeRecoveryBundle(worstEscape, worstRaw, worstEnvelope));
        assertEquals(-1L, PersonalFilePolicy.jsonStringEscapedUtf8ByteLength("\ud800", 100));
    }
}
