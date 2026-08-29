package cn.wuyantongxing.personal;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static cn.wuyantongxing.personal.PersonalExportOperationState.Operation.EXPORT;
import static cn.wuyantongxing.personal.PersonalExportOperationState.Operation.IMPORT;

@CapacitorPlugin(name = "PersonalExport")
public class PersonalExportPlugin extends Plugin {
    enum SelectedDocumentVerification { MATCH, MISMATCH, UNAVAILABLE }
    enum SelectedDocumentRecoveryAction { PRESERVE_AND_CLEAR, RETAIN_WARNING }
    enum ExportOutcomeStatus { NONE, VALID, CORRUPT }
    enum SelectedDocumentJournalStatus { NONE, VALID, CORRUPT }
    enum PendingFileEraseResult { REMOVED, REDACTED, RETRY_REQUIRED }
    interface PendingFileEraseIo {
        boolean truncateAndSync();
        boolean unlink();
        boolean syncParentDirectory();
        boolean isZeroLengthFile();
    }
    interface PendingOpenJsonAction {
        void run() throws PersonalPendingOpenJsonStore.StoreException;
    }
    static final class OpenJsonDocumentMetadata {
        final String displayName;
        final long lastModifiedEpochMillis;

        OpenJsonDocumentMetadata(String displayName, long lastModifiedEpochMillis) {
            this.displayName = displayName;
            this.lastModifiedEpochMillis = lastModifiedEpochMillis;
        }
    }
    static final String STATE_OPERATION_KIND = "operation_kind";
    static final String STATE_PROCESS_NONCE = "process_nonce";
    private static final String PENDING_SUFFIX = ".pending-json";
    private static final String CLEANUP_PREFS = "personal_export_cleanup";
    private static final String CLEANUP_WARNING_KEY = "pending_sensitive_cleanup";
    private static final String CLEANUP_FILES_KEY = "pending_sensitive_cleanup_files";
    static final String SELECTED_DOCUMENT_URI_KEY = "selected_document_uri";
    static final String SELECTED_DOCUMENT_NAME_KEY = "selected_document_name";
    static final String SELECTED_DOCUMENT_PHASE_KEY = "selected_document_phase";
    static final String SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY = "selected_document_persisted_permission_flags";
    static final String SELECTED_DOCUMENT_EXPECTED_BYTES_KEY = "selected_document_expected_bytes";
    static final String SELECTED_DOCUMENT_EXPECTED_SHA256_KEY = "selected_document_expected_sha256";
    private static final String LAST_EXPORT_OUTCOME_ID_KEY = "last_export_outcome_id";
    private static final String LAST_EXPORT_OUTCOME_FILENAME_KEY = "last_export_outcome_filename";
    private static final String CALL_EXPECTED_BYTES_KEY = "expected_bytes";
    private static final String CALL_EXPECTED_SHA256_KEY = "expected_sha256";
    private static final String DOCUMENT_PHASE_WRITING = "writing";
    private static final String DOCUMENT_PHASE_COMPLETE = "complete";
    private static final int STREAM_BUFFER_BYTES = 32 * 1024;
    private static final int STREAM_BUFFER_CHARS = 16 * 1024;
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private static final String PROCESS_NONCE = UUID.randomUUID().toString();
    // Activity/plugin recreation must not create a second writer or cleanup
    // worker while the previous instance still owns an in-process SAF write.
    private static final PersonalExportOperationState operationState = new PersonalExportOperationState();
    private static final Object EXPORT_OUTCOME_LOCK = new Object();
    private static final ExecutorService exportExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "wuyan-personal-export");
        thread.setDaemon(false);
        return thread;
    });

    static void resetProcessOperationForTesting() {
        operationState.resetForTesting();
    }

    static SelectedDocumentRecoveryAction selectedDocumentRecoveryAction(
        String phase,
        SelectedDocumentVerification verification
    ) {
        return DOCUMENT_PHASE_COMPLETE.equals(phase) || verification == SelectedDocumentVerification.MATCH
            ? SelectedDocumentRecoveryAction.PRESERVE_AND_CLEAR
            : SelectedDocumentRecoveryAction.RETAIN_WARNING;
    }

    static boolean canStartNewExport(
        boolean unresolvedSelectedDocument,
        boolean unresolvedLocalFile,
        boolean unacknowledgedOutcome
    ) {
        return !unresolvedSelectedDocument && !unresolvedLocalFile && !unacknowledgedOutcome;
    }

    static boolean shouldExposeCleanupWarning(boolean exportInFlight, boolean warningPending) {
        return warningPending && !exportInFlight;
    }

    static boolean permissionReleaseResolved(boolean releaseSucceeded, Boolean permissionStillHeld) {
        return releaseSucceeded || Boolean.FALSE.equals(permissionStillHeld);
    }

    static boolean requestedPermissionStillHeld(int permissionFlags, boolean heldRead, boolean heldWrite) {
        return ((permissionFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0 && heldRead)
            || ((permissionFlags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 && heldWrite);
    }

    static int unresolvedPermissionFlags(int permissionFlags, boolean readResolved, boolean writeResolved) {
        int unresolved = 0;
        if ((permissionFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0 && !readResolved) {
            unresolved |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
        }
        if ((permissionFlags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 && !writeResolved) {
            unresolved |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }
        return unresolved;
    }

    static boolean isSupportedDocumentUriString(String value) {
        if (value == null || !value.startsWith("content://")) return false;
        int authorityStart = "content://".length();
        int authorityEnd = value.length();
        for (char delimiter : new char[] {'/', '?', '#'}) {
            int index = value.indexOf(delimiter, authorityStart);
            if (index >= 0 && index < authorityEnd) authorityEnd = index;
        }
        if (authorityEnd <= authorityStart) return false;
        for (int index = authorityStart; index < authorityEnd; index += 1) {
            char character = value.charAt(index);
            if (Character.isWhitespace(character) || Character.isISOControl(character)) return false;
        }
        return true;
    }

    static boolean shouldAbortPendingOpenJsonStageFailure(
        PersonalPendingOpenJsonStore.StoreException error
    ) {
        return error == null || !error.preservePendingPayload;
    }

    static SelectedDocumentJournalStatus selectedDocumentJournalStatus(Map<String, ?> values) {
        if (values == null) return SelectedDocumentJournalStatus.CORRUPT;
        boolean hasUri = values.containsKey(SELECTED_DOCUMENT_URI_KEY);
        boolean hasName = values.containsKey(SELECTED_DOCUMENT_NAME_KEY);
        boolean hasPhase = values.containsKey(SELECTED_DOCUMENT_PHASE_KEY);
        boolean hasFlags = values.containsKey(SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY);
        boolean hasBytes = values.containsKey(SELECTED_DOCUMENT_EXPECTED_BYTES_KEY);
        boolean hasSha256 = values.containsKey(SELECTED_DOCUMENT_EXPECTED_SHA256_KEY);
        if (!hasUri && !hasName && !hasPhase && !hasFlags && !hasBytes && !hasSha256) {
            return SelectedDocumentJournalStatus.NONE;
        }
        if (!hasUri || !hasName || !hasPhase || !hasFlags || !hasBytes || !hasSha256) {
            return SelectedDocumentJournalStatus.CORRUPT;
        }

        Object uriValue = values.get(SELECTED_DOCUMENT_URI_KEY);
        Object nameValue = values.get(SELECTED_DOCUMENT_NAME_KEY);
        Object phaseValue = values.get(SELECTED_DOCUMENT_PHASE_KEY);
        Object flagsValue = values.get(SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY);
        Object bytesValue = values.get(SELECTED_DOCUMENT_EXPECTED_BYTES_KEY);
        Object sha256Value = values.get(SELECTED_DOCUMENT_EXPECTED_SHA256_KEY);
        if (!(uriValue instanceof String)
            || !isSupportedDocumentUriString((String) uriValue)
            || !(nameValue instanceof String)
            || !nameValue.equals(PersonalFilePolicy.safeFilename((String) nameValue))
            || !(phaseValue instanceof String)
            || (!DOCUMENT_PHASE_WRITING.equals(phaseValue) && !DOCUMENT_PHASE_COMPLETE.equals(phaseValue))
            || !(flagsValue instanceof Integer)
            || !(bytesValue instanceof Long)
            || !(sha256Value instanceof String)) {
            return SelectedDocumentJournalStatus.CORRUPT;
        }
        int flags = (Integer) flagsValue;
        int allowedFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        long expectedBytes = (Long) bytesValue;
        if (flags < 0
            || (flags & ~allowedFlags) != 0
            || expectedBytes < 0L
            || expectedBytes > PersonalFilePolicy.MAX_JSON_BYTES
            || PersonalExportFingerprint.stored(expectedBytes, (String) sha256Value) == null) {
            return SelectedDocumentJournalStatus.CORRUPT;
        }
        return SelectedDocumentJournalStatus.VALID;
    }

    static boolean appPrivateHealthPayloadDeletionComplete(boolean localPendingFilesDeleted) {
        return localPendingFilesDeleted;
    }

    static boolean appPrivateHealthPayloadDeletionComplete(
        boolean localPendingExportFilesDeleted,
        boolean pendingImportFilesDeleted
    ) {
        return localPendingExportFilesDeleted && pendingImportFilesDeleted;
    }

    static boolean isCanceledResult(ActivityResult result) {
        return result != null && result.getResultCode() == Activity.RESULT_CANCELED;
    }

    static PendingFileEraseResult eraseExistingPendingFile(PendingFileEraseIo io) {
        if (!io.truncateAndSync()) return PendingFileEraseResult.RETRY_REQUIRED;
        if (io.unlink()) {
            return io.syncParentDirectory()
                ? PendingFileEraseResult.REMOVED
                : PendingFileEraseResult.RETRY_REQUIRED;
        }
        return io.isZeroLengthFile()
            ? PendingFileEraseResult.REDACTED
            : PendingFileEraseResult.RETRY_REQUIRED;
    }

    static PendingFileEraseResult eraseExistingPendingFile(File file) {
        return eraseExistingPendingFile(new PendingFileEraseIo() {
            @Override
            public boolean truncateAndSync() {
                return truncateAndSyncFile(file);
            }

            @Override
            public boolean unlink() {
                return file.delete() || !file.exists();
            }

            @Override
            public boolean syncParentDirectory() {
                return syncDirectory(file.getParentFile());
            }

            @Override
            public boolean isZeroLengthFile() {
                return file.isFile() && file.length() == 0L;
            }
        });
    }

    static String decodeUtf8Strict(InputStream input, long maximumBytes) throws IOException {
        if (input == null || maximumBytes < 0L || maximumBytes > PersonalFilePolicy.MAX_JSON_BYTES) {
            throw new IOException("invalid UTF-8 stream limit");
        }
        Reader reader = new InputStreamReader(
            new BoundedInputStream(input, maximumBytes),
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
        );
        StringBuilder decoded = new StringBuilder((int) Math.min(64 * 1024L, maximumBytes));
        char[] buffer = new char[STREAM_BUFFER_CHARS];
        try {
            int count;
            while ((count = reader.read(buffer)) != -1) decoded.append(buffer, 0, count);
        } catch (CharacterCodingException error) {
            throw new InvalidUtf8Exception(error);
        }
        return decoded.toString();
    }

    static PersonalExportFingerprint writeUtf8Strict(
        File file,
        String value,
        long maximumBytes
    ) throws IOException {
        if (file == null || value == null || maximumBytes < 0L || maximumBytes > PersonalFilePolicy.MAX_JSON_BYTES) {
            throw new IOException("invalid UTF-8 write limit");
        }
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IOException("SHA-256 unavailable", error);
        }

        BoundedDigestOutputStream checkedOutput;
        try (FileOutputStream fileOutput = new FileOutputStream(file, false)) {
            checkedOutput = new BoundedDigestOutputStream(fileOutput, digest, maximumBytes);
            try (Writer writer = new OutputStreamWriter(
                new BufferedOutputStream(checkedOutput, STREAM_BUFFER_BYTES),
                StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
            )) {
                char[] buffer = new char[STREAM_BUFFER_CHARS];
                for (int offset = 0; offset < value.length();) {
                    int count = Math.min(buffer.length, value.length() - offset);
                    value.getChars(offset, offset + count, buffer, 0);
                    writer.write(buffer, 0, count);
                    offset += count;
                }
                writer.flush();
                fileOutput.getFD().sync();
            } catch (CharacterCodingException error) {
                throw new InvalidUtf8Exception(error);
            }
        }
        PersonalExportFingerprint fingerprint = PersonalExportFingerprint.stored(
            checkedOutput.bytesWritten(),
            checkedOutput.digestHex()
        );
        if (fingerprint == null) throw new IOException("invalid export fingerprint");
        return fingerprint;
    }

    static final class JsonSizeLimitExceededException extends IOException {
        JsonSizeLimitExceededException() {
            super("JSON exceeds safe byte limit");
        }
    }

    static final class InvalidUtf8Exception extends IOException {
        InvalidUtf8Exception(Throwable cause) {
            super("备份文件不是有效 UTF-8", cause);
        }
    }

    private static final class SelectedDocumentJournal {
        final SelectedDocumentJournalStatus status;
        final String uri;
        final String name;
        final String phase;
        final int permissionFlags;
        final PersonalExportFingerprint expectedFingerprint;

        private SelectedDocumentJournal(
            SelectedDocumentJournalStatus status,
            String uri,
            String name,
            String phase,
            int permissionFlags,
            PersonalExportFingerprint expectedFingerprint
        ) {
            this.status = status;
            this.uri = uri;
            this.name = name;
            this.phase = phase;
            this.permissionFlags = permissionFlags;
            this.expectedFingerprint = expectedFingerprint;
        }

        static SelectedDocumentJournal empty(SelectedDocumentJournalStatus status) {
            return new SelectedDocumentJournal(status, null, null, null, 0, null);
        }
    }

    private static final class BoundedInputStream extends FilterInputStream {
        private final long maximumBytes;
        private long bytesRead;
        private boolean endOfInput;

        BoundedInputStream(InputStream input, long maximumBytes) {
            super(input);
            this.maximumBytes = maximumBytes;
        }

        @Override
        public int read() throws IOException {
            if (bytesRead >= maximumBytes) return probeAfterLimit();
            int value = super.read();
            if (value == -1) {
                endOfInput = true;
                return -1;
            }
            bytesRead++;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (buffer == null) throw new NullPointerException("buffer");
            if (offset < 0 || length < 0 || length > buffer.length - offset) {
                throw new IndexOutOfBoundsException();
            }
            if (length == 0) return 0;
            if (bytesRead >= maximumBytes) return probeAfterLimit();
            int allowed = (int) Math.min((long) length, maximumBytes - bytesRead);
            int count = super.read(buffer, offset, allowed);
            if (count == -1) {
                endOfInput = true;
                return -1;
            }
            bytesRead += count;
            return count;
        }

        private int probeAfterLimit() throws IOException {
            if (endOfInput) return -1;
            if (super.read() == -1) {
                endOfInput = true;
                return -1;
            }
            throw new JsonSizeLimitExceededException();
        }
    }

    private static final class BoundedDigestOutputStream extends OutputStream {
        private final OutputStream output;
        private final MessageDigest digest;
        private final long maximumBytes;
        private long bytesWritten;

        BoundedDigestOutputStream(OutputStream output, MessageDigest digest, long maximumBytes) {
            this.output = output;
            this.digest = digest;
            this.maximumBytes = maximumBytes;
        }

        @Override
        public void write(int value) throws IOException {
            ensureCapacity(1);
            output.write(value);
            digest.update((byte) value);
            bytesWritten++;
        }

        @Override
        public void write(byte[] buffer, int offset, int length) throws IOException {
            if (buffer == null) throw new NullPointerException("buffer");
            if (offset < 0 || length < 0 || length > buffer.length - offset) {
                throw new IndexOutOfBoundsException();
            }
            ensureCapacity(length);
            output.write(buffer, offset, length);
            digest.update(buffer, offset, length);
            bytesWritten += length;
        }

        @Override
        public void flush() throws IOException {
            output.flush();
        }

        @Override
        public void close() throws IOException {
            output.close();
        }

        long bytesWritten() {
            return bytesWritten;
        }

        String digestHex() {
            byte[] bytes = digest.digest();
            char[] hex = new char[bytes.length * 2];
            for (int index = 0; index < bytes.length; index++) {
                int value = bytes[index] & 0xff;
                hex[index * 2] = HEX[value >>> 4];
                hex[index * 2 + 1] = HEX[value & 0x0f];
            }
            return new String(hex);
        }

        private void ensureCapacity(int count) throws JsonSizeLimitExceededException {
            if ((long) count > maximumBytes - bytesWritten) throw new JsonSizeLimitExceededException();
        }
    }

    @Override
    protected void handleOnStart() {
        scheduleOrphanCleanup();
    }

    @Override
    protected void handleOnResume() {
        scheduleOrphanCleanup();
    }

    @Override
    protected Bundle saveInstanceState() {
        Bundle state = new Bundle();
        String operationKind = operationState.persistedActivityKind();
        if (operationKind != null) {
            state.putString(STATE_OPERATION_KIND, operationKind);
            state.putString(STATE_PROCESS_NONCE, PROCESS_NONCE);
        }
        return state;
    }

    @Override
    protected void restoreState(Bundle state) {
        if (state != null && PROCESS_NONCE.equals(state.getString(STATE_PROCESS_NONCE))) {
            // Same-process Activity recreation must trust the process-scoped
            // coordinator. A stale Bundle may outlive a callback that already
            // completed; replaying it would create an operation with no owner.
            return;
        }
        operationState.restore(state == null ? null : state.getString(STATE_OPERATION_KIND));
    }

    @PluginMethod
    public void saveJson(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("缺少要导出的 JSON 数据");
            return;
        }
        if (!operationState.tryStart(EXPORT)) {
            call.reject("已有一个数据操作正在进行，请先完成或取消");
            return;
        }

        boolean unresolvedSelected;
        boolean corruptSelected;
        boolean unresolvedLocal;
        boolean unresolvedOutcome;
        try {
            SharedPreferences preferences = cleanupPreferences();
            SelectedDocumentJournalStatus selectedStatus = selectedDocumentJournal(preferences).status;
            unresolvedSelected = selectedStatus != SelectedDocumentJournalStatus.NONE;
            corruptSelected = selectedStatus == SelectedDocumentJournalStatus.CORRUPT;
            unresolvedLocal = hasPendingLocalFiles();
            ExportOutcomeStatus outcomeStatus = lastExportOutcomeStatus(preferences);
            if (outcomeStatus == ExportOutcomeStatus.CORRUPT) {
                operationState.finish(EXPORT);
                call.reject("上一次导出结果无法读取，请先核对", "EXPORT_OUTCOME_CORRUPTED");
                return;
            }
            unresolvedOutcome = outcomeStatus == ExportOutcomeStatus.VALID;
        } catch (RuntimeException error) {
            operationState.finish(EXPORT);
            call.reject("无法读取上一次导出结果", "EXPORT_OUTCOME_READ_FAILED", error);
            return;
        }
        if (!canStartNewExport(unresolvedSelected, unresolvedLocal, unresolvedOutcome)) {
            operationState.finish(EXPORT);
            String name = selectedDocumentName();
            if (unresolvedOutcome) {
                call.reject("上一次导出结果仍待应用确认，请返回应用后重试", "EXPORT_OUTCOME_PENDING");
            } else if (corruptSelected) {
                call.reject("上一次导出恢复记录已损坏，请先核对并确认清理", "EXPORT_JOURNAL_CORRUPTED");
            } else if (unresolvedSelected && unresolvedLocal) {
                call.reject(
                    "上一次导出的文件“" + name + "”与本机暂存仍待清理，请先完成清理",
                    "EXPORT_CLEANUP_FAILED"
                );
            } else if (unresolvedSelected) {
                call.reject(
                    "上一次导出的文件“" + name + "”仍待确认或删除，请先完成清理",
                    "PARTIAL_DOCUMENT_CLEANUP_FAILED"
                );
            } else {
                call.reject("上一次导出的本机暂存仍待清理，请先完成清理", "LOCAL_TEMP_CLEANUP_FAILED");
            }
            return;
        }

        Object recoveryValue = call.getData().opt("recovery");
        if (call.getData().has("recovery") && !(recoveryValue instanceof Boolean)) {
            operationState.finish(EXPORT);
            call.reject("导出类型无效", "EXPORT_MODE_INVALID");
            return;
        }
        boolean recovery = Boolean.TRUE.equals(recoveryValue);
        long maximumJsonBytes = recovery
            ? PersonalFilePolicy.MAX_JSON_BYTES
            : PersonalFilePolicy.MAX_ORDINARY_EXPORT_BYTES;
        long jsonBytes = PersonalFilePolicy.utf8ByteLength(json, maximumJsonBytes);
        if (jsonBytes < 0L) {
            operationState.finish(EXPORT);
            call.reject("导出数据包含无法编码为 UTF-8 的字符", "EXPORT_INVALID_UTF8");
            return;
        }
        if (jsonBytes > maximumJsonBytes) {
            operationState.finish(EXPORT);
            call.reject(
                recovery ? "恢复副本超过 12 MiB 安全上限" : "数据副本超过 4 MiB 安全上限",
                "EXPORT_TOO_LARGE"
            );
            return;
        }
        long escapedBytes = PersonalFilePolicy.jsonStringEscapedUtf8ByteLength(
            json,
            PersonalFilePolicy.MAX_SAVE_BRIDGE_ESCAPED_BYTES
        );
        if (escapedBytes < 0L || escapedBytes > PersonalFilePolicy.MAX_SAVE_BRIDGE_ESCAPED_BYTES) {
            operationState.finish(EXPORT);
            call.reject("导出数据的桥接封装超过安全上限", "EXPORT_BRIDGE_ENVELOPE_TOO_LARGE");
            return;
        }
        if (recovery && !PersonalFilePolicy.isLowEscapeRecoveryBundle(json, jsonBytes, escapedBytes)) {
            operationState.finish(EXPORT);
            call.reject(
                "恢复副本不是可安全桥接的低转义格式",
                "RECOVERY_EXPORT_ENVELOPE_UNSAFE"
            );
            return;
        }
        // Never retain sensitive JSON in Capacitor's saved PluginCall/Bundle state.
        try {
            String filename = PersonalFilePolicy.safeFilename(
                call.getString("filename", PersonalFilePolicy.DEFAULT_FILENAME)
            );
            String token = UUID.randomUUID().toString();
            call.getData().remove("json");
            call.getData().remove("recovery");
            call.getData().put("token", token);
            call.getData().put("filename", filename);
            exportExecutor.execute(() -> prepareExport(call, json, jsonBytes, token, filename));
        } catch (RuntimeException error) {
            operationState.finish(EXPORT);
            call.reject("无法启动数据导出", "EXPORT_START_FAILED", error);
        }
    }

    @PluginMethod
    public void openJson(PluginCall call) {
        if (!operationState.tryStart(IMPORT)) {
            call.reject("已有一个数据操作正在进行，请先完成或取消");
            return;
        }
        try {
            pendingOpenJsonStore().ensureCanStartSelection();
        } catch (PersonalPendingOpenJsonStore.StoreException error) {
            operationState.finish(IMPORT);
            call.reject(error.getMessage(), error.code, error);
            return;
        } catch (RuntimeException error) {
            operationState.finish(IMPORT);
            call.reject("无法读取备份暂存状态", "PENDING_OPEN_JSON_PROBE_FAILED", error);
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            operationState.finish(IMPORT);
            call.reject("当前页面已关闭，请重新导入");
            return;
        }
        try {
            activity.runOnUiThread(() -> {
                if (activity.isFinishing() || activity.isDestroyed()) {
                    operationState.finish(IMPORT);
                    call.reject("当前页面已关闭，请重新导入", "ACTIVITY_UNAVAILABLE");
                    return;
                }
                try {
                    operationState.activityStarted(IMPORT);
                    startActivityForResult(call, createOpenDocumentIntent(), "openResult");
                } catch (RuntimeException error) {
                    operationState.finish(IMPORT);
                    call.reject("无法打开系统文件选择器", "DOCUMENT_PICKER_FAILED", error);
                }
            });
        } catch (RuntimeException error) {
            operationState.finish(IMPORT);
            call.reject("无法打开系统文件选择器", "DOCUMENT_PICKER_FAILED", error);
        }
    }

    /** Returns false only when there is no staged import. Preparing/corrupt is an explicit error. */
    @PluginMethod
    public void probePendingOpenJson(PluginCall call) {
        executePendingOpenJsonCall(call, () -> {
            PersonalPendingOpenJsonStore.Probe probe = pendingOpenJsonStore().probe();
            JSObject response = new JSObject();
            response.put("available", probe.available);
            if (probe.available) putPendingOpenJsonMetadata(response, probe.metadata);
            call.resolve(response);
        });
    }

    /** Reads at most 256 KiB of exact staged bytes; JSON text is never materialized here. */
    @PluginMethod
    public void readPendingOpenJsonChunk(PluginCall call) {
        String id = call.getString("id");
        Object offset = call.getData().opt("offset");
        executePendingOpenJsonCall(call, () -> {
            PersonalPendingOpenJsonStore.Chunk chunk = pendingOpenJsonStore().readChunk(id, offset);
            JSObject response = new JSObject();
            putPendingOpenJsonMetadata(response, chunk.metadata);
            response.put("offset", chunk.offset);
            response.put("nextOffset", chunk.nextOffset);
            response.put("done", chunk.done);
            response.put("chunkBase64", chunk.chunkBase64);
            response.put("chunkSha256", chunk.chunkSha256);
            call.resolve(response);
        });
    }

    /**
     * Token-bound acknowledgement. Repeating the last successful token is an
     * idempotent success; a different/malformed token never touches a file.
     */
    @PluginMethod
    public void acknowledgePendingOpenJson(PluginCall call) {
        String id = call.getString("id");
        executePendingOpenJsonCall(call, () -> {
            PersonalPendingOpenJsonStore.Acknowledgement acknowledgement =
                pendingOpenJsonStore().acknowledge(id);
            JSObject response = new JSObject();
            response.put("acknowledged", true);
            response.put("alreadyAcknowledged", acknowledgement.alreadyAcknowledged);
            call.resolve(response);
        });
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            call.reject("当前页面已关闭，请重新打开通知设置", "ACTIVITY_UNAVAILABLE");
            return;
        }
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        try {
            activity.startActivity(intent);
            JSObject response = new JSObject();
            response.put("opened", true);
            call.resolve(response);
        } catch (RuntimeException notificationSettingsError) {
            try {
                Intent fallback = new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                activity.startActivity(fallback);
                JSObject response = new JSObject();
                response.put("opened", true);
                call.resolve(response);
            } catch (RuntimeException fallbackError) {
                fallbackError.addSuppressed(notificationSettingsError);
                call.reject("无法打开系统通知设置", "SETTINGS_UNAVAILABLE", fallbackError);
            }
        }
    }

    static Intent createOpenDocumentIntent() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // Keep photos, audio and video out of the picker while retaining the
        // text/octet-stream fallbacks used by document providers that do not
        // index a .json file as application/json. Selection is still capped at
        // 12 MiB and strictly decoded before it can replace local state.
        // Android's multi-MIME contract requires */* as the base type. The
        // explicit allow-list keeps JSON files that providers label as plain
        // text or octet-stream visible while media remains non-selectable.
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
            "application/json",
            "text/json",
            "text/plain",
            "application/octet-stream"
        });
        return intent;
    }

    static Intent createSaveDocumentIntent(String filename) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        intent.putExtra(Intent.EXTRA_TITLE, PersonalFilePolicy.safeFilename(filename));
        return intent;
    }

    @PluginMethod
    public void purgePendingExports(PluginCall call) {
        if (!operationState.tryStartCleanup()) {
            call.reject("请先完成或取消当前数据操作");
            return;
        }
        try {
            exportExecutor.execute(() -> {
                try {
                    if (purgeAllPendingFiles()) call.resolve();
                    else call.reject("无法清理尚未完成的数据导出，请稍后重试");
                } catch (RuntimeException error) {
                    call.reject("无法清理尚未完成的数据导出", "LOCAL_TEMP_CLEANUP_FAILED", error);
                } finally {
                    operationState.finishCleanup();
                }
            });
        } catch (RuntimeException error) {
            operationState.finishCleanup();
            call.reject("无法启动本机暂存清理", "LOCAL_TEMP_CLEANUP_FAILED", error);
        }
    }

    /**
     * Privacy deletion only owns files inside this application's private
     * directory. A SAF document selected by the user lives outside that
     * boundary and may be offline or have lost permission; it must never keep
     * the app's own health database alive.
     */
    @PluginMethod
    public void purgeAppPrivatePendingExports(PluginCall call) {
        if (!operationState.tryStartCleanup()) {
            call.reject("请先完成或取消当前数据操作");
            return;
        }
        try {
            exportExecutor.execute(() -> {
                try {
                    boolean localFilesDeleted = purgeLocalPendingFiles();
                    boolean pendingImportDeleted = pendingOpenJsonStore().purgeAll();
                    boolean selectedJournalCleared;
                    boolean outcomeCleared;
                    try { selectedJournalCleared = clearSelectedDocumentJournal(); }
                    catch (RuntimeException ignored) { selectedJournalCleared = false; }
                    try { outcomeCleared = clearLastExportOutcomeForDeletion(); }
                    catch (RuntimeException ignored) { outcomeCleared = false; }
                    try {
                        if (selectedJournalCleared && outcomeCleared) refreshCleanupWarning();
                        else setCleanupWarning(true);
                    } catch (RuntimeException ignored) {
                        // Only the app-private pending JSON can contain health
                        // payload. Provider grants and outcome metadata remain
                        // a best-effort, payload-free cleanup intent.
                    }
                    if (appPrivateHealthPayloadDeletionComplete(localFilesDeleted, pendingImportDeleted)) call.resolve();
                    else call.reject("无法清理本机私有导出状态", "LOCAL_TEMP_CLEANUP_FAILED");
                } catch (RuntimeException error) {
                    call.reject("无法清理本机私有导出暂存", "LOCAL_TEMP_CLEANUP_FAILED", error);
                } finally {
                    operationState.finishCleanup();
                }
            });
        } catch (RuntimeException error) {
            operationState.finishCleanup();
            call.reject("无法启动本机暂存清理", "LOCAL_TEMP_CLEANUP_FAILED", error);
        }
    }

    @PluginMethod
    public void getCleanupWarning(PluginCall call) {
        try {
            SharedPreferences preferences = cleanupPreferences();
            SelectedDocumentJournal selectedJournal = selectedDocumentJournal(preferences);
            boolean selectedPending = selectedJournal.status != SelectedDocumentJournalStatus.NONE;
            boolean localPending = hasPendingLocalFiles();
            ExportOutcomeStatus outcomeStatus = lastExportOutcomeStatus(preferences);
            JSObject response = new JSObject();
            boolean pending = selectedPending
                || localPending
                || outcomeStatus == ExportOutcomeStatus.CORRUPT
                || cleanupWarningPending(preferences);
            if (!shouldExposeCleanupWarning(operationState.isInFlight(EXPORT), pending)) {
                response.put("pending", false);
                call.resolve(response);
                return;
            }
            response.put("pending", pending);
            if (pending) {
                if (outcomeStatus == ExportOutcomeStatus.CORRUPT) {
                    response.put("issue", "export-outcome");
                } else if (selectedJournal.status == SelectedDocumentJournalStatus.VALID
                    && DOCUMENT_PHASE_COMPLETE.equals(selectedJournal.phase)) {
                    response.put("filename", selectedDocumentName());
                    response.put("issue", "saved-local-temporary");
                } else if (selectedPending && localPending) {
                    response.put("filename", selectedDocumentName());
                    response.put("issue", "both");
                } else if (selectedPending) {
                    response.put("filename", selectedDocumentName());
                    response.put("issue", "selected-document");
                } else {
                    response.put("issue", "local-temporary");
                }
            }
            call.resolve(response);
        } catch (RuntimeException error) {
            call.reject("无法读取导出清理状态", "CLEANUP_STATUS_FAILED", error);
        }
    }

    @PluginMethod
    public void forgetCorruptExportOutcome(PluginCall call) {
        synchronized (EXPORT_OUTCOME_LOCK) {
            try {
                SharedPreferences preferences = cleanupPreferences();
                ExportOutcomeStatus status = lastExportOutcomeStatus(preferences);
                if (status == ExportOutcomeStatus.VALID) {
                    call.reject("仍有可确认的导出结果", "EXPORT_OUTCOME_STILL_VALID");
                    return;
                }
                if (status == ExportOutcomeStatus.NONE) {
                    call.resolve();
                    return;
                }
                if (!preferences.edit()
                    .remove(LAST_EXPORT_OUTCOME_ID_KEY)
                    .remove(LAST_EXPORT_OUTCOME_FILENAME_KEY)
                    .commit()) {
                    call.reject("导出异常状态无法释放", "EXPORT_OUTCOME_ACK_FAILED");
                    return;
                }
                refreshCleanupWarning();
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("导出异常状态无法释放", "EXPORT_OUTCOME_ACK_FAILED", error);
            }
        }
    }

    /** At-least-once handoff for a save that outlived its original WebView. */
    @PluginMethod
    public void getLastExportOutcome(PluginCall call) {
        synchronized (EXPORT_OUTCOME_LOCK) {
            try {
                SharedPreferences preferences = cleanupPreferences();
                JSObject response = new JSObject();
                if (!hasLastExportOutcome(preferences)) {
                    response.put("available", false);
                    call.resolve(response);
                    return;
                }
                String id = preferences.getString(LAST_EXPORT_OUTCOME_ID_KEY, null);
                String filename = preferences.getString(LAST_EXPORT_OUTCOME_FILENAME_KEY, null);
                if (!PersonalFilePolicy.isValidSessionToken(id) || filename == null) {
                    call.reject("导出完成状态无法读取", "EXPORT_OUTCOME_CORRUPTED");
                    return;
                }
                response.put("available", true);
                response.put("saved", true);
                response.put("id", id);
                response.put("filename", PersonalFilePolicy.safeFilename(filename));
                call.resolve(response);
            } catch (RuntimeException error) {
                call.reject("无法读取导出完成状态", "EXPORT_OUTCOME_READ_FAILED", error);
            }
        }
    }

    @PluginMethod
    public void acknowledgeLastExportOutcome(PluginCall call) {
        String requestedId = call.getString("id");
        if (!PersonalFilePolicy.isValidSessionToken(requestedId)) {
            call.reject("导出完成状态标识无效", "EXPORT_OUTCOME_ACK_FAILED");
            return;
        }
        synchronized (EXPORT_OUTCOME_LOCK) {
            try {
                SharedPreferences preferences = cleanupPreferences();
                if (!hasLastExportOutcome(preferences)) {
                    call.resolve();
                    return;
                }
                String currentId = preferences.getString(LAST_EXPORT_OUTCOME_ID_KEY, null);
                if (!requestedId.equals(currentId)) {
                    call.reject("导出完成状态已经变化", "EXPORT_OUTCOME_ACK_STALE");
                    return;
                }
                if (!preferences.edit()
                    .remove(LAST_EXPORT_OUTCOME_ID_KEY)
                    .remove(LAST_EXPORT_OUTCOME_FILENAME_KEY)
                    .commit()) {
                    call.reject("导出完成状态无法确认", "EXPORT_OUTCOME_ACK_FAILED");
                    return;
                }
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("导出完成状态无法确认", "EXPORT_OUTCOME_ACK_FAILED", error);
            }
        }
    }

    @PluginMethod
    public void acknowledgeSelectedDocumentCleanup(PluginCall call) {
        if (!operationState.tryStartCleanup()) {
            call.reject("请先完成或取消当前数据操作");
            return;
        }
        try {
            exportExecutor.execute(() -> {
                try {
                    if (!acknowledgeSelectedDocumentJournal()) {
                        call.reject("文件清理确认无法保存，请稍后重试", "CLEANUP_ACK_FAILED");
                        return;
                    }
                    refreshCleanupWarning();
                    call.resolve();
                } catch (RuntimeException error) {
                    call.reject("文件清理确认失败", "CLEANUP_ACK_FAILED", error);
                } finally {
                    operationState.finishCleanup();
                }
            });
        } catch (RuntimeException error) {
            operationState.finishCleanup();
            call.reject("无法启动文件清理确认", "CLEANUP_ACK_FAILED", error);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (!operationState.callbackStarted(EXPORT)) {
            if (call != null) {
                File mismatchedPending = pendingFile(call.getString("token"));
                rejectAfterPendingCleanup(
                    call,
                    mismatchedPending,
                    "导出结果与当前数据操作不匹配",
                    "CONFLICTING_DOCUMENT_RESULT",
                    null
                );
            }
            return;
        }
        if (call == null) {
            // The Activity result has been consumed and will not be replayed.
            // Persisted picker recovery must be released before asynchronous
            // cleanup, otherwise a process death here permanently restores a
            // file-operation gate with no future callback.
            operationState.callbackRecoveryCommitted(EXPORT);
            try {
                exportExecutor.execute(() -> {
                    try {
                        purgeAllPendingFiles();
                    } finally {
                        operationState.finish(EXPORT);
                    }
                });
            } catch (RuntimeException ignored) {
                operationState.finish(EXPORT);
            }
            return;
        }
        String token = call.getString("token");
        File pendingFile = pendingFile(token);
        if (pendingFile == null) {
            operationState.callbackRecoveryCommitted(EXPORT);
            try {
                exportExecutor.execute(() -> {
                    try {
                        boolean purged = purgeAllPendingFiles();
                        if (purged) call.reject("导出会话已失效", "INVALID_EXPORT_SESSION");
                        else call.reject("导出会话已失效，且本机私有导出暂存未能清理", "LOCAL_TEMP_CLEANUP_FAILED");
                    } catch (RuntimeException error) {
                        call.reject("导出会话已失效，清理状态无法确认", "LOCAL_TEMP_CLEANUP_FAILED", error);
                    } finally {
                        operationState.finish(EXPORT);
                    }
                });
            } catch (RuntimeException error) {
                operationState.finish(EXPORT);
                call.reject("导出会话已失效", "INVALID_EXPORT_SESSION", error);
            }
            return;
        }

        if (isCanceledResult(result)) {
            operationState.callbackRecoveryCommitted(EXPORT);
            try {
                exportExecutor.execute(() -> {
                    try {
                        boolean pendingCleaned = deletePendingFile(pendingFile);
                        if (!pendingCleaned) {
                            call.reject("本机私有导出暂存未能清理，请重启应用后重试", "LOCAL_TEMP_CLEANUP_FAILED");
                            return;
                        }
                        JSObject response = new JSObject();
                        response.put("saved", false);
                        call.resolve(response);
                    } catch (RuntimeException error) {
                        call.reject("无法取消数据导出", "EXPORT_CANCEL_FAILED", error);
                    } finally {
                        operationState.finish(EXPORT);
                    }
                });
            } catch (RuntimeException error) {
                operationState.finish(EXPORT);
                rejectAfterPendingCleanup(call, pendingFile, "无法取消数据导出", "EXPORT_CANCEL_FAILED", error);
            }
            return;
        }
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            operationState.callbackRecoveryCommitted(EXPORT);
            executeExportCleanupRejection(
                call,
                pendingFile,
                "系统文件选择器未返回有效结果",
                "INVALID_DOCUMENT_RESULT",
                null
            );
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            operationState.callbackRecoveryCommitted(EXPORT);
            executeExportCleanupRejection(
                call,
                pendingFile,
                "系统未返回可写入的文件位置",
                "INVALID_DOCUMENT_URI",
                null
            );
            return;
        }
        if (!isSupportedDocumentUriString(uri.toString())) {
            operationState.callbackRecoveryCommitted(EXPORT);
            executeExportCleanupRejection(
                call,
                pendingFile,
                "系统文件选择器返回了不受支持的位置",
                "INVALID_DOCUMENT_URI",
                null
            );
            return;
        }

        String filename = PersonalFilePolicy.safeFilename(call.getString("filename", PersonalFilePolicy.DEFAULT_FILENAME));
        int resultFlags = result.getData().getFlags();
        PersonalExportFingerprint expectedFingerprint = PersonalExportFingerprint.stored(
            call.getData().optLong(CALL_EXPECTED_BYTES_KEY, -1L),
            call.getData().optString(CALL_EXPECTED_SHA256_KEY, null)
        );
        if (expectedFingerprint == null) {
            operationState.callbackRecoveryCommitted(EXPORT);
            try {
                exportExecutor.execute(() -> {
                    try {
                        rejectJournalFailureNow(call, pendingFile, uri, filename);
                    } catch (RuntimeException error) {
                        call.reject("导出恢复信息已失效，清理状态无法确认", "LOCAL_TEMP_CLEANUP_FAILED", error);
                    } finally {
                        operationState.finish(EXPORT);
                    }
                });
            } catch (RuntimeException error) {
                operationState.finish(EXPORT);
                call.reject("导出恢复信息已失效", "INVALID_EXPORT_SESSION", error);
            }
            return;
        }
        if (!rememberSelectedDocument(uri, filename, resultFlags, expectedFingerprint)) {
            operationState.callbackRecoveryCommitted(EXPORT);
            try {
                exportExecutor.execute(() -> {
                    try {
                        rejectJournalFailureNow(call, pendingFile, uri, filename);
                    } catch (RuntimeException error) {
                        call.reject("无法建立导出恢复记录，清理状态无法确认", "LOCAL_TEMP_CLEANUP_FAILED", error);
                    } finally {
                        operationState.finish(EXPORT);
                    }
                });
            } catch (RuntimeException error) {
                operationState.finish(EXPORT);
                call.reject("无法建立导出恢复记录", "EXPORT_JOURNAL_FAILED", error);
            }
            return;
        }
        operationState.callbackRecoveryCommitted(EXPORT);

        try {
            exportExecutor.execute(() -> writeToSelectedDocument(call, pendingFile, uri, filename));
        } catch (RuntimeException error) {
            operationState.finish(EXPORT);
            rejectJournalFailureNow(call, pendingFile, uri, filename);
        }
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        if (!operationState.callbackStarted(IMPORT)) {
            if (call != null) call.reject("导入结果与当前数据操作不匹配", "CONFLICTING_DOCUMENT_RESULT");
            return;
        }
        if (isCanceledResult(result)) {
            operationState.callbackRecoveryCommitted(IMPORT);
            operationState.finish(IMPORT);
            if (call != null) {
                JSObject response = new JSObject();
                response.put("selected", false);
                call.resolve(response);
            }
            return;
        }
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            operationState.callbackRecoveryCommitted(IMPORT);
            operationState.finish(IMPORT);
            if (call != null) call.reject("系统文件选择器未返回有效文件", "INVALID_DOCUMENT_RESULT");
            return;
        }
        Uri uri = result.getData().getData();
        if (!isSupportedDocumentUriString(uri.toString())) {
            operationState.callbackRecoveryCommitted(IMPORT);
            operationState.finish(IMPORT);
            if (call != null) call.reject("系统文件选择器返回了不受支持的文件", "INVALID_DOCUMENT_URI");
            return;
        }
        String id = UUID.randomUUID().toString();
        OpenJsonDocumentMetadata documentMetadata = readOpenJsonDocumentMetadata(uri);
        try {
            // Persist PREPARING before releasing Capacitor's callback recovery.
            // A process death can therefore never expose an unstaged payload as
            // a successful result or silently turn it into "unavailable".
            pendingOpenJsonStore().beginPreparing(
                id,
                documentMetadata.displayName,
                documentMetadata.lastModifiedEpochMillis
            );
        } catch (PersonalPendingOpenJsonStore.StoreException error) {
            operationState.finish(IMPORT);
            if (call != null) call.reject(error.getMessage(), error.code, error);
            return;
        } catch (RuntimeException error) {
            operationState.finish(IMPORT);
            if (call != null) {
                call.reject("无法建立备份暂存恢复记录", "PENDING_OPEN_JSON_JOURNAL_FAILED", error);
            }
            return;
        }
        operationState.callbackRecoveryCommitted(IMPORT);
        try {
            exportExecutor.execute(() -> stageSelectedJson(call, uri, id));
        } catch (RuntimeException error) {
            operationState.finish(IMPORT);
            boolean cleaned = pendingOpenJsonStore().abortPreparing(id);
            if (call != null) {
                call.reject(
                    cleaned ? "无法读取备份文件" : "无法读取备份文件，且暂存清理未完成",
                    cleaned ? "DOCUMENT_READ_FAILED" : "PENDING_OPEN_JSON_CLEANUP_FAILED",
                    error
                );
            }
        }
    }

    private void stageSelectedJson(PluginCall call, Uri uri, String id) {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("无法打开所选文件");
            PersonalPendingOpenJsonStore.Metadata metadata = pendingOpenJsonStore().stage(id, input);
            if (call != null) {
                JSObject response = new JSObject();
                response.put("selected", true);
                putPendingOpenJsonMetadata(response, metadata);
                call.resolve(response);
            }
        } catch (PersonalPendingOpenJsonStore.StoreException error) {
            if (!shouldAbortPendingOpenJsonStageFailure(error)) {
                if (call != null) call.reject(error.getMessage(), error.code, error);
                return;
            }
            boolean cleaned = pendingOpenJsonStore().abortPreparing(id);
            if (call != null) {
                call.reject(
                    cleaned ? error.getMessage() : error.getMessage() + "；暂存清理未完成",
                    cleaned ? error.code : "PENDING_OPEN_JSON_CLEANUP_FAILED",
                    error
                );
            }
        } catch (IOException | RuntimeException error) {
            boolean cleaned = pendingOpenJsonStore().abortPreparing(id);
            if (call != null) {
                call.reject(
                    cleaned ? "无法读取备份文件" : "无法读取备份文件，且暂存清理未完成",
                    cleaned ? "DOCUMENT_READ_FAILED" : "PENDING_OPEN_JSON_CLEANUP_FAILED",
                    error
                );
            }
        } finally {
            operationState.finish(IMPORT);
        }
    }

    private void prepareExport(
        PluginCall call,
        String json,
        long expectedBytes,
        String token,
        String filename
    ) {
        File pendingFile = pendingFile(token);
        if (pendingFile == null) {
            operationState.finish(EXPORT);
            call.reject("无法创建安全导出会话");
            return;
        }

        try {
            File directory = pendingDirectory();
            if ((!directory.isDirectory() && !directory.mkdirs()) || !directory.isDirectory()) {
                throw new IOException("无法创建私有暂存目录");
            }
            if (!markCleanupFileDurably(pendingFile)) {
                throw new IOException("无法建立私有暂存恢复记录");
            }
            PersonalExportFingerprint expectedFingerprint = writeUtf8Strict(
                pendingFile,
                json,
                PersonalFilePolicy.MAX_JSON_BYTES
            );
            if (expectedFingerprint.bytes() != expectedBytes) {
                throw new IOException("导出数据的 UTF-8 长度在准备期间发生变化");
            }
            call.getData().put(CALL_EXPECTED_BYTES_KEY, expectedFingerprint.bytes());
            call.getData().put(CALL_EXPECTED_SHA256_KEY, expectedFingerprint.sha256());
        } catch (IOException | RuntimeException error) {
            operationState.finish(EXPORT);
            rejectAfterPendingCleanup(call, pendingFile, "无法准备数据副本", "PREPARE_EXPORT_FAILED", error);
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            operationState.finish(EXPORT);
            rejectAfterPendingCleanup(call, pendingFile, "当前页面已关闭，请重新导出", "ACTIVITY_UNAVAILABLE", null);
            return;
        }
        try {
            activity.runOnUiThread(() -> {
                if (activity.isFinishing() || activity.isDestroyed()) {
                    operationState.finish(EXPORT);
                    rejectAfterPendingCleanup(
                        call,
                        pendingFile,
                        "当前页面已关闭，请重新导出",
                        "ACTIVITY_UNAVAILABLE",
                        null
                    );
                    return;
                }
                Intent intent = createSaveDocumentIntent(filename);
                try {
                    operationState.activityStarted(EXPORT);
                    startActivityForResult(call, intent, "saveResult");
                } catch (RuntimeException error) {
                    operationState.finish(EXPORT);
                    rejectAfterPendingCleanup(
                        call,
                        pendingFile,
                        "无法打开系统文件选择器",
                        "DOCUMENT_PICKER_FAILED",
                        error
                    );
                }
            });
        } catch (RuntimeException error) {
            operationState.finish(EXPORT);
            rejectAfterPendingCleanup(
                call,
                pendingFile,
                "无法打开系统文件选择器",
                "DOCUMENT_PICKER_FAILED",
                error
            );
        }
    }

    private void writeToSelectedDocument(
        PluginCall call,
        File pendingFile,
        Uri uri,
        String filename
    ) {
        boolean documentWritten = false;
        try {
            Exception writeFailure = null;
            boolean partialDocumentDeleted = true;
            boolean pendingCleaned = false;
            boolean journalCleaned = false;
            try {
                try (
                    InputStream input = new FileInputStream(pendingFile);
                    OutputStream output = openDocumentOutput(uri)
                ) {
                    byte[] buffer = new byte[32 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    output.flush();
                }
                documentWritten = true;
            } catch (IOException | RuntimeException error) {
                writeFailure = error;
                partialDocumentDeleted = deleteSelectedDocument(uri);
                if (partialDocumentDeleted) journalCleaned = clearSelectedDocumentJournal();
            } finally {
                pendingCleaned = deletePendingFile(pendingFile);
            }
            if (writeFailure != null) {
                refreshCleanupWarning();
                if ((!partialDocumentDeleted || !journalCleaned) && !pendingCleaned) {
                    call.reject(
                        "保存失败；请删除文件“" + filename + "”，本机私有导出暂存也未能清理",
                        "EXPORT_CLEANUP_FAILED",
                        writeFailure
                    );
                } else if (!partialDocumentDeleted || !journalCleaned) {
                    call.reject(
                        "保存失败；请到刚才选择的位置删除文件“" + filename + "”",
                        "PARTIAL_DOCUMENT_CLEANUP_FAILED",
                        writeFailure
                    );
                } else if (!pendingCleaned) {
                    call.reject(
                        "保存失败，且本机私有导出暂存未能清理，请重启应用后重试",
                        "LOCAL_TEMP_CLEANUP_FAILED",
                        writeFailure
                    );
                } else {
                    call.reject("无法保存数据副本", "DOCUMENT_WRITE_FAILED", writeFailure);
                }
                return;
            }
            if (!markSelectedDocumentComplete()) {
                // The provider write was fully closed. A failed internal phase
                // commit is not evidence that the user's complete file should
                // be deleted. Keep the WRITING journal: fingerprint recovery
                // can prove MATCH after restart and publish the outcome.
                rememberLastExportOutcome(filename);
                refreshCleanupWarning();
                call.reject(
                    "文件已经保存，但完整状态未能确认；应用会在下次启动核对",
                    "EXPORT_SAVED_LOCAL_TEMP_CLEANUP_FAILED"
                );
                return;
            }
            if (!rememberLastExportOutcome(filename)) {
                refreshCleanupWarning();
                call.reject(
                    "文件已经保存，但完成状态未能持久确认；应用会在下次启动提示核对",
                    "EXPORT_SAVED_LOCAL_TEMP_CLEANUP_FAILED"
                );
                return;
            }
            journalCleaned = clearSelectedDocumentJournal();
            refreshCleanupWarning();
            if (!pendingCleaned || !journalCleaned) {
                call.reject(
                    "文件已经保存，但本机导出清理状态未能完成；应用会自动重试",
                    "EXPORT_SAVED_LOCAL_TEMP_CLEANUP_FAILED"
                );
                return;
            }
            JSObject response = new JSObject();
            response.put("saved", true);
            call.resolve(response);
        } catch (RuntimeException error) {
            try { setCleanupWarning(true); } catch (RuntimeException ignored) { }
            if (documentWritten) {
                // The provider stream was fully closed. Do not delete a complete
                // external file merely because internal metadata failed; retain
                // the journal and surface the at-least-once recovery path.
                call.reject(
                    "文件已经保存，但导出状态处理未完成；应用会在下次启动继续核对",
                    "EXPORT_SAVED_LOCAL_TEMP_CLEANUP_FAILED",
                    error
                );
            } else {
                // A cleanup/runtime failure before the provider stream closed is
                // not evidence of a successful export. Never tell the user that
                // the document was saved in this branch.
                call.reject(
                    "导出未完成，无法确认文件是否保存；请检查刚才选择的位置后重试",
                    "EXPORT_CLEANUP_FAILED",
                    error
                );
            }
        } finally {
            operationState.finish(EXPORT);
        }
    }

    private boolean rememberSelectedDocument(
        Uri uri,
        String filename,
        int resultFlags,
        PersonalExportFingerprint expectedFingerprint
    ) {
        int permissionFlags = resultFlags & (
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );
        int requestedPersistedFlags = (resultFlags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0
            ? permissionFlags
            : 0;
        boolean committed;
        try {
            // Write the release intent before acquiring a durable provider
            // grant. A process death or preference failure must never leave a
            // persisted permission whose URI/flags the next launch cannot find.
            committed = cleanupPreferences().edit()
                .putString(SELECTED_DOCUMENT_URI_KEY, uri.toString())
                .putString(SELECTED_DOCUMENT_NAME_KEY, filename)
                .putString(SELECTED_DOCUMENT_PHASE_KEY, DOCUMENT_PHASE_WRITING)
                .putInt(SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY, requestedPersistedFlags)
                .putLong(SELECTED_DOCUMENT_EXPECTED_BYTES_KEY, expectedFingerprint.bytes())
                .putString(SELECTED_DOCUMENT_EXPECTED_SHA256_KEY, expectedFingerprint.sha256())
                .putBoolean(CLEANUP_WARNING_KEY, true)
                .commit();
        } catch (RuntimeException error) {
            committed = false;
        }
        if (!committed) return false;
        if (requestedPersistedFlags != 0) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri, requestedPersistedFlags);
            } catch (RuntimeException ignored) {
                // The durable journal still identifies the transient location.
                // Later cleanup releases any subset that was actually granted,
                // or confirms that no persisted permission remains.
            }
        }
        return true;
    }

    private boolean markSelectedDocumentComplete() {
        return cleanupPreferences().edit()
            .putString(SELECTED_DOCUMENT_PHASE_KEY, DOCUMENT_PHASE_COMPLETE)
            .putBoolean(CLEANUP_WARNING_KEY, true)
            .commit();
    }

    private boolean clearSelectedDocumentJournal() {
        SharedPreferences preferences = cleanupPreferences();
        SelectedDocumentJournal journal = selectedDocumentJournal(preferences);
        if (journal.status == SelectedDocumentJournalStatus.CORRUPT) {
            // Never let a damaged single-slot journal revoke unrelated SAF
            // capabilities. Preserve it for the explicit acknowledgement path,
            // which can release only a recoverable exact URI.
            setCleanupWarning(true);
            return false;
        }
        if (journal.status == SelectedDocumentJournalStatus.NONE) return true;
        if (!releasePersistedPermissionsForUri(Uri.parse(journal.uri))) {
            setCleanupWarning(true);
            return false;
        }
        return removeSelectedDocumentJournal(preferences);
    }

    private boolean acknowledgeSelectedDocumentJournal() {
        SharedPreferences preferences = cleanupPreferences();
        SelectedDocumentJournal journal = selectedDocumentJournal(preferences);
        if (journal.status == SelectedDocumentJournalStatus.NONE) return true;
        Uri journalUri = journal.status == SelectedDocumentJournalStatus.VALID
            ? Uri.parse(journal.uri)
            : recoverSelectedDocumentUri(preferences);
        if (journalUri == null || !releasePersistedPermissionsForUri(journalUri)) {
            setCleanupWarning(true);
            return false;
        }
        // This method is called only after the user confirms the selected
        // location has been checked. It is the sole path allowed to forget a
        // corrupt journal, and it releases only that journal's exact URI.
        return removeSelectedDocumentJournal(preferences);
    }

    private boolean removeSelectedDocumentJournal(SharedPreferences preferences) {
        return preferences.edit()
            .remove(SELECTED_DOCUMENT_URI_KEY)
            .remove(SELECTED_DOCUMENT_NAME_KEY)
            .remove(SELECTED_DOCUMENT_PHASE_KEY)
            .remove(SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY)
            .remove(SELECTED_DOCUMENT_EXPECTED_BYTES_KEY)
            .remove(SELECTED_DOCUMENT_EXPECTED_SHA256_KEY)
            .commit();
    }

    private Uri recoverSelectedDocumentUri(SharedPreferences preferences) {
        try {
            Object rawUri = preferences.getAll().get(SELECTED_DOCUMENT_URI_KEY);
            if (!(rawUri instanceof String) || !isSupportedDocumentUriString((String) rawUri)) return null;
            return Uri.parse((String) rawUri);
        } catch (RuntimeException error) {
            return null;
        }
    }

    private boolean releasePersistedPermissionsForUri(Uri selectedUri) {
        if (selectedUri == null) return false;
        try {
            boolean allReleased = true;
            for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (!selectedUri.equals(permission.getUri())) continue;
                int flags = 0;
                if (permission.isReadPermission()) flags |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
                if (permission.isWritePermission()) flags |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                if (flags != 0 && !releasePersistedPermission(permission.getUri(), flags)) {
                    allReleased = false;
                }
            }
            return allReleased;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private boolean releasePersistedPermission(Uri uri, int permissionFlags) {
        boolean readResolved = (permissionFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0
            || releaseSinglePersistedPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        boolean writeResolved = (permissionFlags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0
            || releaseSinglePersistedPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        return unresolvedPermissionFlags(permissionFlags, readResolved, writeResolved) == 0;
    }

    private boolean releaseSinglePersistedPermission(Uri uri, int permissionFlag) {
        try {
            getContext().getContentResolver().releasePersistableUriPermission(uri, permissionFlag);
            return true;
        } catch (RuntimeException releaseError) {
            Boolean permissionStillHeld = null;
            try {
                permissionStillHeld = false;
                for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
                    if (!uri.equals(permission.getUri())) continue;
                    if (requestedPermissionStillHeld(
                        permissionFlag,
                        permission.isReadPermission(),
                        permission.isWritePermission()
                    )) {
                        permissionStillHeld = true;
                        break;
                    }
                }
            } catch (RuntimeException inspectionError) {
                permissionStillHeld = null;
            }
            // Only forget the journal when release succeeded or the platform
            // positively confirms the provider already revoked the grant.
            return permissionReleaseResolved(false, permissionStillHeld);
        }
    }

    private boolean deleteSelectedDocument(Uri uri) {
        try {
            return getContext().getContentResolver().delete(uri, null, null) > 0;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private void rejectJournalFailureNow(PluginCall call, File pendingFile, Uri uri, String filename) {
        boolean selectedDeleted = deleteSelectedDocument(uri);
        boolean journalCleared = selectedDeleted && clearSelectedDocumentJournal();
        boolean pendingDeleted = deletePendingFile(pendingFile);
        refreshCleanupWarning();
        if ((!selectedDeleted || !journalCleared) && !pendingDeleted) {
            call.reject(
                "无法建立导出恢复记录；请删除文件“" + filename + "”，本机暂存也未能清理",
                "EXPORT_CLEANUP_FAILED"
            );
        } else if (!selectedDeleted || !journalCleared) {
            call.reject(
                "无法建立导出恢复记录；请删除文件“" + filename + "”",
                "PARTIAL_DOCUMENT_CLEANUP_FAILED"
            );
        } else if (!pendingDeleted) {
            call.reject("无法建立导出恢复记录，本机暂存仍需清理", "LOCAL_TEMP_CLEANUP_FAILED");
        } else {
            call.reject("无法建立安全的导出恢复记录", "EXPORT_JOURNAL_FAILED");
        }
    }

    private OutputStream openDocumentOutput(Uri uri) throws IOException {
        OutputStream raw = getContext().getContentResolver().openOutputStream(uri, "wt");
        if (raw == null) throw new IOException("无法打开目标文件");
        return new BufferedOutputStream(raw);
    }

    private PersonalPendingOpenJsonStore pendingOpenJsonStore() {
        return new PersonalPendingOpenJsonStore(getContext());
    }

    private static void putPendingOpenJsonMetadata(
        JSObject response,
        PersonalPendingOpenJsonStore.Metadata metadata
    ) {
        response.put("id", metadata.id);
        response.put("byteLength", metadata.byteLength);
        response.put("sha256", metadata.sha256);
        if (metadata.displayName != null) response.put("displayName", metadata.displayName);
        if (metadata.lastModifiedEpochMillis > 0L) {
            response.put("lastModifiedEpochMillis", metadata.lastModifiedEpochMillis);
        }
    }

    private OpenJsonDocumentMetadata readOpenJsonDocumentMetadata(Uri uri) {
        String displayName = null;
        long lastModifiedEpochMillis = 0L;
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    displayName = PersonalPendingOpenJsonStore.sanitizeDisplayName(cursor.getString(nameIndex));
                }
                int modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) {
                    long candidate = cursor.getLong(modifiedIndex);
                    if (candidate > 0L) lastModifiedEpochMillis = candidate;
                }
            }
        } catch (RuntimeException ignored) {
            // File identity remains cryptographically bound by UUID, length
            // and SHA-256 even when a provider withholds display metadata.
        }
        return new OpenJsonDocumentMetadata(displayName, lastModifiedEpochMillis);
    }

    private void executePendingOpenJsonCall(PluginCall call, PendingOpenJsonAction action) {
        try {
            exportExecutor.execute(() -> {
                try {
                    action.run();
                } catch (PersonalPendingOpenJsonStore.StoreException error) {
                    call.reject(error.getMessage(), error.code, error);
                } catch (RuntimeException error) {
                    call.reject("备份暂存操作失败", "PENDING_OPEN_JSON_OPERATION_FAILED", error);
                }
            });
        } catch (RuntimeException error) {
            call.reject("无法启动备份暂存操作", "PENDING_OPEN_JSON_OPERATION_FAILED", error);
        }
    }

    private File pendingDirectory() {
        return new File(getContext().getNoBackupFilesDir(), "personal-exports");
    }

    private File pendingFile(String token) {
        if (!PersonalFilePolicy.isValidSessionToken(token)) return null;
        return new File(pendingDirectory(), token + PENDING_SUFFIX);
    }

    private void executeExportCleanupRejection(
        PluginCall call,
        File pendingFile,
        String message,
        String code,
        Exception error
    ) {
        try {
            exportExecutor.execute(() -> {
                try {
                    rejectAfterPendingCleanup(call, pendingFile, message, code, error);
                } catch (RuntimeException cleanupError) {
                    call.reject(message + "；本机清理状态无法确认", "LOCAL_TEMP_CLEANUP_FAILED", cleanupError);
                } finally {
                    operationState.finish(EXPORT);
                }
            });
        } catch (RuntimeException schedulingError) {
            operationState.finish(EXPORT);
            rejectAfterPendingCleanup(call, pendingFile, message, code, schedulingError);
        }
    }

    private boolean deletePendingFile(File file) {
        if (file == null) {
            clearCleanupFile(file);
            refreshCleanupWarning();
            return true;
        }
        boolean tracked = cleanupFileNames().contains(file.getName());
        if (!file.exists()) {
            // A previous unlink whose directory fsync failed leaves its durable
            // journal behind. Retry that barrier before forgetting the name.
            if (tracked && !syncDirectory(file.getParentFile())) {
                markCleanupFile(file);
                return false;
            }
            clearCleanupFile(file);
            refreshCleanupWarning();
            return true;
        }

        PendingFileEraseResult result = eraseExistingPendingFile(file);
        if (result == PendingFileEraseResult.RETRY_REQUIRED) {
            markCleanupFile(file);
            return false;
        }
        clearCleanupFile(file);
        refreshCleanupWarning();
        return true;
    }

    private static boolean truncateAndSyncFile(File file) {
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.flush();
            output.getFD().sync();
            return file.isFile() && file.length() == 0L;
        } catch (IOException | RuntimeException error) {
            return false;
        }
    }

    static boolean syncDirectory(File directory) {
        if (directory == null) return false;
        if (!directory.exists()) return true;
        if (!directory.isDirectory()) return false;
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(
                directory.getAbsolutePath(),
                OsConstants.O_RDONLY | OsConstants.O_CLOEXEC,
                0
            );
            Os.fsync(descriptor);
            return true;
        } catch (ErrnoException | RuntimeException error) {
            return false;
        } finally {
            if (descriptor != null) {
                try { Os.close(descriptor); }
                catch (ErrnoException | RuntimeException ignored) { }
            }
        }
    }

    private void rejectAfterPendingCleanup(
        PluginCall call,
        File pendingFile,
        String message,
        String code,
        Exception error
    ) {
        if (!deletePendingFile(pendingFile)) {
            call.reject(
                message + "；本机私有导出暂存也未能清理，请重启应用后重试",
                "LOCAL_TEMP_CLEANUP_FAILED",
                error
            );
        } else if (error == null) {
            call.reject(message, code);
        } else {
            call.reject(message, code, error);
        }
    }

    private void scheduleOrphanCleanup() {
        try {
            exportExecutor.execute(() -> {
                // restoreState runs before onStart/onResume. Holding the same
                // global gate as import/export makes every file here an orphan;
                // a restored picker session keeps the gate and is never purged.
                if (!operationState.tryStartCleanup()) return;
                try {
                    purgeAllPendingFiles();
                } finally {
                    operationState.finishCleanup();
                }
            });
        } catch (RuntimeException ignored) {
            // The warning stays persisted and a later foreground transition
            // or explicit purge can retry without losing the cleanup intent.
        }
    }

    private boolean purgeAllPendingFiles() {
        boolean selectedDocumentResolved = purgeSelectedDocumentJournal();
        boolean localFilesDeleted = purgeLocalPendingFiles();
        boolean outcomeReadable = lastExportOutcomeStatus(cleanupPreferences()) != ExportOutcomeStatus.CORRUPT;
        if (!selectedDocumentResolved || !outcomeReadable) setCleanupWarning(true);
        return selectedDocumentResolved && localFilesDeleted && outcomeReadable;
    }

    private boolean purgeLocalPendingFiles() {
        boolean allDeleted = true;
        File directory = pendingDirectory();
        if (!directory.exists()) {
            if (allDeleted) refreshCleanupWarning();
            else setCleanupWarning(true);
            return allDeleted;
        }
        File[] files = directory.listFiles();
        if (files == null) {
            setCleanupWarning(true);
            return false;
        }
        for (File file : files) {
            if (file.isFile() && file.getName().endsWith(PENDING_SUFFIX)) {
                if (!deletePendingFile(file)) allDeleted = false;
            }
        }
        if (allDeleted) refreshCleanupWarning();
        else setCleanupWarning(true);
        return allDeleted;
    }

    private boolean rememberLastExportOutcome(String filename) {
        synchronized (EXPORT_OUTCOME_LOCK) {
            try {
                SharedPreferences preferences = cleanupPreferences();
                if (hasLastExportOutcome(preferences)) return true;
                return preferences.edit()
                    .putString(LAST_EXPORT_OUTCOME_ID_KEY, UUID.randomUUID().toString())
                    .putString(LAST_EXPORT_OUTCOME_FILENAME_KEY, PersonalFilePolicy.safeFilename(filename))
                    .commit();
            } catch (RuntimeException error) {
                return false;
            }
        }
    }

    private boolean clearLastExportOutcomeForDeletion() {
        synchronized (EXPORT_OUTCOME_LOCK) {
            try {
                return cleanupPreferences().edit()
                    .remove(LAST_EXPORT_OUTCOME_ID_KEY)
                    .remove(LAST_EXPORT_OUTCOME_FILENAME_KEY)
                    .commit();
            } catch (RuntimeException error) {
                return false;
            }
        }
    }

    private boolean hasLastExportOutcome(SharedPreferences preferences) {
        ExportOutcomeStatus status = lastExportOutcomeStatus(preferences);
        if (status == ExportOutcomeStatus.CORRUPT) throw new IllegalStateException("Corrupted export outcome");
        return status == ExportOutcomeStatus.VALID;
    }

    private ExportOutcomeStatus lastExportOutcomeStatus(SharedPreferences preferences) {
        boolean hasId = preferences.contains(LAST_EXPORT_OUTCOME_ID_KEY);
        boolean hasFilename = preferences.contains(LAST_EXPORT_OUTCOME_FILENAME_KEY);
        if (!hasId && !hasFilename) return ExportOutcomeStatus.NONE;
        if (!hasId || !hasFilename) return ExportOutcomeStatus.CORRUPT;
        try {
            String id = preferences.getString(LAST_EXPORT_OUTCOME_ID_KEY, null);
            String filename = preferences.getString(LAST_EXPORT_OUTCOME_FILENAME_KEY, null);
            return PersonalFilePolicy.isValidSessionToken(id) && filename != null
                ? ExportOutcomeStatus.VALID
                : ExportOutcomeStatus.CORRUPT;
        } catch (ClassCastException error) {
            return ExportOutcomeStatus.CORRUPT;
        }
    }

    private boolean purgeSelectedDocumentJournal() {
        SharedPreferences preferences = cleanupPreferences();
        SelectedDocumentJournal journal = selectedDocumentJournal(preferences);
        if (journal.status == SelectedDocumentJournalStatus.NONE) {
            return true;
        }
        if (journal.status == SelectedDocumentJournalStatus.CORRUPT) {
            // Release only a still-recoverable exact URI. Never use a damaged
            // journal as authority to revoke unrelated SAF permissions.
            Uri recoverableUri = recoverSelectedDocumentUri(preferences);
            if (recoverableUri != null) releasePersistedPermissionsForUri(recoverableUri);
            setCleanupWarning(true);
            return false;
        }
        if (selectedDocumentRecoveryAction(journal.phase, SelectedDocumentVerification.UNAVAILABLE)
            == SelectedDocumentRecoveryAction.PRESERVE_AND_CLEAR) {
            if (!rememberLastExportOutcome(journal.name)) return false;
            return clearSelectedDocumentJournal();
        }
        final Uri uri;
        try {
            uri = Uri.parse(journal.uri);
        } catch (RuntimeException error) {
            setCleanupWarning(true);
            return false;
        }
        SelectedDocumentVerification verification = verifySelectedDocument(uri, journal.expectedFingerprint);
        if (selectedDocumentRecoveryAction(journal.phase, verification)
            == SelectedDocumentRecoveryAction.PRESERVE_AND_CLEAR) {
            if (!markSelectedDocumentComplete()) return false;
            if (!rememberLastExportOutcome(journal.name)) return false;
            return clearSelectedDocumentJournal();
        }
        // A mismatch after process death does not prove that the remaining
        // document is our partial write: the user or a cloud provider may have
        // replaced the URI. Never delete or forget it automatically. A missing
        // permission/offline provider is likewise unavailable, not evidence of
        // absence. Keep the filename journal for explicit human cleanup.
        releasePersistedPermissionsForUri(uri);
        setCleanupWarning(true);
        return false;
    }

    private SelectedDocumentVerification verifySelectedDocument(
        Uri uri,
        PersonalExportFingerprint expected
    ) {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) return SelectedDocumentVerification.UNAVAILABLE;
            PersonalExportFingerprint actual = PersonalExportFingerprint.read(
                input,
                PersonalFilePolicy.MAX_JSON_BYTES
            );
            return expected.matches(actual)
                ? SelectedDocumentVerification.MATCH
                : SelectedDocumentVerification.MISMATCH;
        } catch (IOException | RuntimeException error) {
            return SelectedDocumentVerification.UNAVAILABLE;
        }
    }

    private String selectedDocumentName() {
        SelectedDocumentJournal journal = selectedDocumentJournal(cleanupPreferences());
        return journal.status == SelectedDocumentJournalStatus.VALID
            ? journal.name
            : PersonalFilePolicy.DEFAULT_FILENAME;
    }

    private SharedPreferences cleanupPreferences() {
        return getContext().getSharedPreferences(CLEANUP_PREFS, 0);
    }

    private SelectedDocumentJournal selectedDocumentJournal(SharedPreferences preferences) {
        try {
            Map<String, ?> values = preferences.getAll();
            SelectedDocumentJournalStatus status = selectedDocumentJournalStatus(values);
            if (status != SelectedDocumentJournalStatus.VALID) {
                return SelectedDocumentJournal.empty(status);
            }
            long expectedBytes = (Long) values.get(SELECTED_DOCUMENT_EXPECTED_BYTES_KEY);
            PersonalExportFingerprint expectedFingerprint = PersonalExportFingerprint.stored(
                expectedBytes,
                (String) values.get(SELECTED_DOCUMENT_EXPECTED_SHA256_KEY)
            );
            if (expectedFingerprint == null) {
                return SelectedDocumentJournal.empty(SelectedDocumentJournalStatus.CORRUPT);
            }
            return new SelectedDocumentJournal(
                SelectedDocumentJournalStatus.VALID,
                (String) values.get(SELECTED_DOCUMENT_URI_KEY),
                (String) values.get(SELECTED_DOCUMENT_NAME_KEY),
                (String) values.get(SELECTED_DOCUMENT_PHASE_KEY),
                (Integer) values.get(SELECTED_DOCUMENT_PERMISSION_FLAGS_KEY),
                expectedFingerprint
            );
        } catch (RuntimeException error) {
            return SelectedDocumentJournal.empty(SelectedDocumentJournalStatus.CORRUPT);
        }
    }

    private String preferenceString(SharedPreferences preferences, String key, String fallback) {
        try {
            return preferences.getString(key, fallback);
        } catch (ClassCastException error) {
            return fallback;
        }
    }

    private boolean cleanupWarningPending(SharedPreferences preferences) {
        try {
            return preferences.getBoolean(CLEANUP_WARNING_KEY, false);
        } catch (ClassCastException error) {
            return true;
        }
    }

    private void setCleanupWarning(boolean pending) {
        SharedPreferences.Editor editor = cleanupPreferences().edit().putBoolean(CLEANUP_WARNING_KEY, pending);
        if (!pending) editor.remove(CLEANUP_FILES_KEY);
        editor.apply();
    }

    private Set<String> cleanupFileNames() {
        try {
            return new HashSet<>(cleanupPreferences().getStringSet(CLEANUP_FILES_KEY, Collections.emptySet()));
        } catch (ClassCastException error) {
            return new HashSet<>();
        }
    }

    private void markCleanupFile(File file) {
        markCleanupFileDurably(file);
    }

    private boolean markCleanupFileDurably(File file) {
        Set<String> files = cleanupFileNames();
        if (file != null && PersonalFilePolicy.isValidPendingFilename(file.getName())) files.add(file.getName());
        return cleanupPreferences().edit()
            .putStringSet(CLEANUP_FILES_KEY, files)
            .putBoolean(CLEANUP_WARNING_KEY, true)
            .commit();
    }

    private void clearCleanupFile(File file) {
        if (file == null) return;
        Set<String> files = cleanupFileNames();
        if (!files.remove(file.getName())) return;
        cleanupPreferences().edit().putStringSet(CLEANUP_FILES_KEY, files).apply();
    }

    private void refreshCleanupWarning() {
        if (selectedDocumentJournal(cleanupPreferences()).status != SelectedDocumentJournalStatus.NONE) {
            setCleanupWarning(true);
            return;
        }
        File directory = pendingDirectory();
        if (!directory.exists()) {
            cleanupPreferences().edit()
                .remove(CLEANUP_FILES_KEY)
                .putBoolean(CLEANUP_WARNING_KEY, false)
                .apply();
            return;
        }
        File[] files = directory.listFiles();
        if (files == null) {
            setCleanupWarning(true);
            return;
        }
        for (File file : files) {
            if (file.isFile() && file.getName().endsWith(PENDING_SUFFIX) && file.length() > 0L) {
                setCleanupWarning(true);
                return;
            }
        }
        cleanupPreferences().edit()
            .remove(CLEANUP_FILES_KEY)
            .putBoolean(CLEANUP_WARNING_KEY, false)
            .apply();
    }

    private boolean hasPendingLocalFiles() {
        if (!cleanupFileNames().isEmpty()) return true;
        File directory = pendingDirectory();
        if (!directory.exists()) return false;
        File[] files = directory.listFiles();
        if (files == null) return true;
        for (File file : files) {
            if (file.isFile() && file.getName().endsWith(PENDING_SUFFIX) && file.length() > 0L) return true;
        }
        return false;
    }

}
