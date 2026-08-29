package cn.wuyantongxing.personal;

import static cn.wuyantongxing.personal.PersonalExportPlugin.PendingFileEraseResult.REDACTED;
import static cn.wuyantongxing.personal.PersonalExportPlugin.PendingFileEraseResult.REMOVED;
import static cn.wuyantongxing.personal.PersonalExportPlugin.PendingFileEraseResult.RETRY_REQUIRED;
import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class PersonalPendingFileDeletionProtocolTest {
    @Test
    public void successfulDeletionSyncsContentBeforeUnlinkAndParentAfterward() {
        RecordingEraseIo io = new RecordingEraseIo(true, true, true, false);

        assertEquals(REMOVED, PersonalExportPlugin.eraseExistingPendingFile(io));
        assertEquals(Arrays.asList("truncate-sync", "unlink", "parent-sync"), io.calls);
    }

    @Test
    public void failedTruncateNeverAttemptsAnUnsafeUnlink() {
        RecordingEraseIo io = new RecordingEraseIo(false, true, true, false);

        assertEquals(RETRY_REQUIRED, PersonalExportPlugin.eraseExistingPendingFile(io));
        assertEquals(Arrays.asList("truncate-sync"), io.calls);
    }

    @Test
    public void failedUnlinkLeavesDurablyRedactedContentWithoutFalseDirectorySync() {
        RecordingEraseIo io = new RecordingEraseIo(true, false, true, true);

        assertEquals(REDACTED, PersonalExportPlugin.eraseExistingPendingFile(io));
        assertEquals(Arrays.asList("truncate-sync", "unlink", "zero-check"), io.calls);
    }

    @Test
    public void failedParentSyncRequiresJournalledRecoveryAfterUnlink() {
        RecordingEraseIo io = new RecordingEraseIo(true, true, false, false);

        assertEquals(RETRY_REQUIRED, PersonalExportPlugin.eraseExistingPendingFile(io));
        assertEquals(Arrays.asList("truncate-sync", "unlink", "parent-sync"), io.calls);
    }

    private static final class RecordingEraseIo implements PersonalExportPlugin.PendingFileEraseIo {
        private final boolean truncate;
        private final boolean unlink;
        private final boolean parentSync;
        private final boolean zeroLength;
        private final List<String> calls = new ArrayList<>();

        RecordingEraseIo(boolean truncate, boolean unlink, boolean parentSync, boolean zeroLength) {
            this.truncate = truncate;
            this.unlink = unlink;
            this.parentSync = parentSync;
            this.zeroLength = zeroLength;
        }

        @Override
        public boolean truncateAndSync() {
            calls.add("truncate-sync");
            return truncate;
        }

        @Override
        public boolean unlink() {
            calls.add("unlink");
            return unlink;
        }

        @Override
        public boolean syncParentDirectory() {
            calls.add("parent-sync");
            return parentSync;
        }

        @Override
        public boolean isZeroLengthFile() {
            calls.add("zero-check");
            return zeroLength;
        }
    }
}
