package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class PersonalExportStreamingTest {
    @Test
    public void exportStreamsStrictUtf8AndBuildsTheRecoveryFingerprintInOnePass() throws Exception {
        File file = File.createTempFile("wuyan-export-stream", ".json");
        try {
            PersonalExportFingerprint fingerprint = PersonalExportPlugin.writeUtf8Strict(file, "戒戒", 6L);
            PersonalExportFingerprint reread;
            try (FileInputStream input = new FileInputStream(file)) {
                reread = PersonalExportFingerprint.read(input, 6L);
            }

            assertEquals(6L, fingerprint.bytes());
            assertTrue(fingerprint.matches(reread));
            assertEquals("戒戒", new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } finally {
            Files.deleteIfExists(file.toPath());
        }
    }

    @Test
    public void exportRejectsTheFirstEncodedByteBeyondItsBound() throws Exception {
        File file = File.createTempFile("wuyan-export-bound", ".json");
        try {
            try {
                PersonalExportPlugin.writeUtf8Strict(file, "戒戒a", 6L);
                fail("the first encoded byte beyond the limit must be rejected");
            } catch (PersonalExportPlugin.JsonSizeLimitExceededException expected) {
                assertEquals("JSON exceeds safe byte limit", expected.getMessage());
            }
        } finally {
            Files.deleteIfExists(file.toPath());
        }
    }

    @Test
    public void exportRejectsUnpairedUtf16InsteadOfReplacingIt() throws Exception {
        File file = File.createTempFile("wuyan-export-utf8", ".json");
        try {
            try {
                PersonalExportPlugin.writeUtf8Strict(file, "{\"value\":\"\ud800\"}", 64L);
                fail("unpaired UTF-16 must not become replacement bytes");
            } catch (PersonalExportPlugin.InvalidUtf8Exception expected) {
                assertEquals("备份文件不是有效 UTF-8", expected.getMessage());
            }
        } finally {
            Files.deleteIfExists(file.toPath());
        }
    }

    @Test
    public void oversizedImportStopsAfterTheSingleProbeByte() throws Exception {
        CountingAsciiInputStream input = new CountingAsciiInputStream(1_000_000L);
        try {
            PersonalExportPlugin.decodeUtf8Strict(input, 4L);
            fail("oversized input must be rejected");
        } catch (PersonalExportPlugin.JsonSizeLimitExceededException expected) {
            assertEquals(5L, input.bytesServed);
        }
    }

    private static final class CountingAsciiInputStream extends InputStream {
        private long remaining;
        private long bytesServed;

        CountingAsciiInputStream(long length) {
            remaining = length;
        }

        @Override
        public int read() {
            if (remaining == 0L) return -1;
            remaining--;
            bytesServed++;
            return 'a';
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining == 0L) return -1;
            int count = (int) Math.min((long) length, remaining);
            for (int index = 0; index < count; index++) buffer[offset + index] = 'a';
            remaining -= count;
            bytesServed += count;
            return count;
        }
    }
}
