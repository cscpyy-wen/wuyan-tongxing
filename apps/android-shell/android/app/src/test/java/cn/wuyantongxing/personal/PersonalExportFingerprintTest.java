package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class PersonalExportFingerprintTest {
    @Test
    public void streamingFingerprintMatchesTheStoredLengthAndDigest() throws Exception {
        PersonalExportFingerprint actual = PersonalExportFingerprint.read(
            new ByteArrayInputStream("health-data".getBytes(StandardCharsets.UTF_8)),
            1024
        );
        PersonalExportFingerprint restored = PersonalExportFingerprint.stored(actual.bytes(), actual.sha256());

        assertEquals(11L, actual.bytes());
        assertEquals(64, actual.sha256().length());
        assertTrue(actual.matches(restored));
        assertFalse(actual.matches(PersonalExportFingerprint.stored(10L, actual.sha256())));
        assertNull(PersonalExportFingerprint.stored(-1L, actual.sha256()));
    }

    @Test(expected = IOException.class)
    public void rejectsAnExternalDocumentBeyondTheExpectedSafetyLimit() throws Exception {
        PersonalExportFingerprint.read(new ByteArrayInputStream(new byte[5]), 4);
    }
}
