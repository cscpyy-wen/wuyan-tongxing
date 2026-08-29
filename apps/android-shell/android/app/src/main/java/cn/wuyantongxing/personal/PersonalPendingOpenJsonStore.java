package cn.wuyantongxing.personal;

import android.content.Context;
import android.content.SharedPreferences;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.io.Reader;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;

/**
 * Crash-durable, single-slot handoff for an Android document selected by openJson.
 *
 * <p>The selected bytes never cross the Capacitor bridge in one envelope. They are
 * first committed in the no-backup directory, then exposed as bounded authenticated
 * chunks until JavaScript explicitly acknowledges the exact UUID.</p>
 */
final class PersonalPendingOpenJsonStore {
    enum JournalStatus { NONE, PREPARING, READY, CORRUPT }

    interface ReadyPhaseCommitter {
        boolean commit(SharedPreferences preferences);
    }

    static final String PREFS_NAME = "personal_export_cleanup";
    static final String PHASE_KEY = "pending_open_json_phase";
    static final String ID_KEY = "pending_open_json_id";
    static final String BYTE_LENGTH_KEY = "pending_open_json_byte_length";
    static final String SHA256_KEY = "pending_open_json_sha256";
    static final String DISPLAY_NAME_KEY = "pending_open_json_display_name";
    static final String LAST_MODIFIED_KEY = "pending_open_json_last_modified";
    static final String LAST_ACKNOWLEDGED_ID_KEY = "last_acknowledged_open_json_id";
    static final String PHASE_PREPARING = "PREPARING";
    static final String PHASE_READY = "READY";
    static final String RETRYABLE_STAGE_ERROR = "PENDING_OPEN_JSON_RETRYABLE";
    static final String DIRECTORY_NAME = "personal-import-recovery";
    static final String FINAL_SUFFIX = ".open-json";
    static final String NEW_SUFFIX = FINAL_SUFFIX + ".new";
    static final int MAX_CHUNK_BYTES = 256 * 1024;

    private static final Object LOCK = new Object();
    private static final int BUFFER_BYTES = 32 * 1024;
    private static final int BUFFER_CHARS = 16 * 1024;
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    static final class StoreException extends IOException {
        final String code;
        final boolean preservePendingPayload;

        StoreException(String code, String message) {
            this(code, message, null, false);
        }

        StoreException(String code, String message, Throwable cause) {
            this(code, message, cause, false);
        }

        StoreException(String code, String message, Throwable cause, boolean preservePendingPayload) {
            super(message, cause);
            this.code = code;
            this.preservePendingPayload = preservePendingPayload;
        }

        static StoreException retryable(String message, Throwable cause) {
            return new StoreException(RETRYABLE_STAGE_ERROR, message, cause, true);
        }
    }

    static final class Metadata {
        final String id;
        final long byteLength;
        final String sha256;
        final String displayName;
        final long lastModifiedEpochMillis;

        Metadata(
            String id,
            long byteLength,
            String sha256,
            String displayName,
            long lastModifiedEpochMillis
        ) {
            this.id = id;
            this.byteLength = byteLength;
            this.sha256 = sha256;
            this.displayName = displayName;
            this.lastModifiedEpochMillis = lastModifiedEpochMillis;
        }
    }

    static final class Probe {
        final boolean available;
        final Metadata metadata;

        Probe(boolean available, Metadata metadata) {
            this.available = available;
            this.metadata = metadata;
        }
    }

    static final class Chunk {
        final Metadata metadata;
        final long offset;
        final long nextOffset;
        final boolean done;
        final String chunkBase64;
        final String chunkSha256;

        Chunk(
            Metadata metadata,
            long offset,
            long nextOffset,
            boolean done,
            String chunkBase64,
            String chunkSha256
        ) {
            this.metadata = metadata;
            this.offset = offset;
            this.nextOffset = nextOffset;
            this.done = done;
            this.chunkBase64 = chunkBase64;
            this.chunkSha256 = chunkSha256;
        }
    }

    static final class Acknowledgement {
        final boolean alreadyAcknowledged;

        Acknowledgement(boolean alreadyAcknowledged) {
            this.alreadyAcknowledged = alreadyAcknowledged;
        }
    }

    private static final class Journal {
        final JournalStatus status;
        final String id;
        final PersonalExportFingerprint fingerprint;
        final String displayName;
        final long lastModifiedEpochMillis;

        Journal(
            JournalStatus status,
            String id,
            PersonalExportFingerprint fingerprint,
            String displayName,
            long lastModifiedEpochMillis
        ) {
            this.status = status;
            this.id = id;
            this.fingerprint = fingerprint;
            this.displayName = displayName;
            this.lastModifiedEpochMillis = lastModifiedEpochMillis;
        }
    }

    private final Context context;
    private final SharedPreferences preferences;
    private final File directory;
    private final ReadyPhaseCommitter readyPhaseCommitter;

    PersonalPendingOpenJsonStore(Context context) {
        this(context, preferences -> preferences.edit().putString(PHASE_KEY, PHASE_READY).commit());
    }

    PersonalPendingOpenJsonStore(Context context, ReadyPhaseCommitter readyPhaseCommitter) {
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences(PREFS_NAME, 0);
        this.directory = new File(this.context.getNoBackupFilesDir(), DIRECTORY_NAME);
        if (readyPhaseCommitter == null) throw new IllegalArgumentException("readyPhaseCommitter required");
        this.readyPhaseCommitter = readyPhaseCommitter;
    }

    static JournalStatus journalStatus(Map<String, ?> values) {
        if (values == null) return JournalStatus.CORRUPT;
        boolean hasPhase = values.containsKey(PHASE_KEY);
        boolean hasId = values.containsKey(ID_KEY);
        boolean hasBytes = values.containsKey(BYTE_LENGTH_KEY);
        boolean hasSha = values.containsKey(SHA256_KEY);
        boolean hasDisplayName = values.containsKey(DISPLAY_NAME_KEY);
        boolean hasLastModified = values.containsKey(LAST_MODIFIED_KEY);
        if (!hasPhase && !hasId && !hasBytes && !hasSha && !hasDisplayName && !hasLastModified) {
            return JournalStatus.NONE;
        }
        if (!hasPhase || !hasId || hasBytes != hasSha) return JournalStatus.CORRUPT;

        if (hasDisplayName && (!(values.get(DISPLAY_NAME_KEY) instanceof String)
            || sanitizeDisplayName((String) values.get(DISPLAY_NAME_KEY)) == null)) {
            return JournalStatus.CORRUPT;
        }
        if (hasLastModified && (!(values.get(LAST_MODIFIED_KEY) instanceof Long)
            || !isValidLastModified((Long) values.get(LAST_MODIFIED_KEY)))) {
            return JournalStatus.CORRUPT;
        }

        Object phase = values.get(PHASE_KEY);
        Object id = values.get(ID_KEY);
        if (!(phase instanceof String)
            || !(id instanceof String)
            || !PersonalFilePolicy.isValidSessionToken((String) id)) {
            return JournalStatus.CORRUPT;
        }
        PersonalExportFingerprint fingerprint = null;
        if (hasBytes) {
            Object bytes = values.get(BYTE_LENGTH_KEY);
            Object sha = values.get(SHA256_KEY);
            if (!(bytes instanceof Long) || !(sha instanceof String)) return JournalStatus.CORRUPT;
            long byteLength = (Long) bytes;
            fingerprint = PersonalExportFingerprint.stored(byteLength, (String) sha);
            if (fingerprint == null || byteLength <= 0L || byteLength > PersonalFilePolicy.MAX_JSON_BYTES) {
                return JournalStatus.CORRUPT;
            }
        }
        if (PHASE_PREPARING.equals(phase)) return JournalStatus.PREPARING;
        if (PHASE_READY.equals(phase) && fingerprint != null) return JournalStatus.READY;
        return JournalStatus.CORRUPT;
    }

    static Long exactOffset(Object value) {
        if (!(value instanceof Number)) return null;
        double numeric = ((Number) value).doubleValue();
        if (!Double.isFinite(numeric)
            || numeric < 0d
            || numeric > PersonalFilePolicy.MAX_JSON_BYTES
            || numeric != Math.rint(numeric)) return null;
        return (long) numeric;
    }

    static String sanitizeDisplayName(String value) {
        if (value == null) return null;
        String normalized = value.trim();
        if (normalized.isEmpty() || normalized.length() > 120) return null;
        for (int index = 0; index < normalized.length(); index++) {
            char current = normalized.charAt(index);
            if (current < 0x20 || current == 0x7f || current == '/' || current == '\\') return null;
        }
        return normalized;
    }

    private static boolean isValidLastModified(long value) {
        return value > 0L && value <= 253_402_300_799_999L;
    }

    void ensureCanStartSelection() throws StoreException {
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            if (journal.status == JournalStatus.CORRUPT || hasOwnedArtifactsLocked()) {
                if (journal.status == JournalStatus.NONE && !hasOwnedArtifactsLocked()) return;
                if (journal.status == JournalStatus.NONE) {
                    throw new StoreException(
                        "PENDING_OPEN_JSON_CORRUPT",
                        "发现没有恢复记录的备份暂存，请先清理"
                    );
                }
            }
            if (journal.status == JournalStatus.CORRUPT) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存恢复记录已损坏");
            }
            if (journal.status != JournalStatus.NONE) {
                throw new StoreException("PENDING_OPEN_JSON_EXISTS", "已有待处理的备份文件");
            }
        }
    }

    void beginPreparing(String id) throws StoreException {
        beginPreparing(id, null, 0L);
    }

    void beginPreparing(String id, String displayName, long lastModifiedEpochMillis) throws StoreException {
        if (!PersonalFilePolicy.isValidSessionToken(id)) {
            throw new StoreException("PENDING_OPEN_JSON_INVALID_ID", "备份暂存标识无效");
        }
        String safeDisplayName = sanitizeDisplayName(displayName);
        long safeLastModified = isValidLastModified(lastModifiedEpochMillis)
            ? lastModifiedEpochMillis
            : 0L;
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            if (journal.status != JournalStatus.NONE || hasOwnedArtifactsLocked()) {
                throw new StoreException(
                    journal.status == JournalStatus.CORRUPT || journal.status == JournalStatus.NONE
                        ? "PENDING_OPEN_JSON_CORRUPT"
                        : "PENDING_OPEN_JSON_EXISTS",
                    "已有未完成的备份暂存"
                );
            }
            SharedPreferences.Editor editor = preferences.edit()
                .putString(PHASE_KEY, PHASE_PREPARING)
                .putString(ID_KEY, id)
                .remove(BYTE_LENGTH_KEY)
                .remove(SHA256_KEY)
                .remove(DISPLAY_NAME_KEY)
                .remove(LAST_MODIFIED_KEY);
            if (safeDisplayName != null) editor.putString(DISPLAY_NAME_KEY, safeDisplayName);
            if (safeLastModified > 0L) editor.putLong(LAST_MODIFIED_KEY, safeLastModified);
            if (!editor.commit()) {
                throw new StoreException("PENDING_OPEN_JSON_JOURNAL_FAILED", "无法建立备份暂存恢复记录");
            }
        }
    }

    Metadata stage(String id, InputStream selectedInput) throws StoreException {
        if (selectedInput == null) {
            throw new StoreException("DOCUMENT_READ_FAILED", "无法打开所选文件");
        }
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            if (journal.status != JournalStatus.PREPARING || !id.equals(journal.id)) {
                throw new StoreException("PENDING_OPEN_JSON_STALE", "备份暂存会话已经变化");
            }
            File committed = finalFile(id);
            File pending = newFile(id);
            if (committed.exists() || pending.exists()) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存包含冲突文件");
            }
            boolean authenticatedPayloadPersisted = false;
            try {
                prepareDirectoryLocked();
                PersonalExportFingerprint expected = copySelectedBytesLocked(selectedInput, pending);
                if (expected.bytes() == 0L) {
                    throw new StoreException("DOCUMENT_EMPTY", "备份文件为空");
                }
                validateUtf8StrictLocked(pending);
                if (!preferences.edit()
                    .putLong(BYTE_LENGTH_KEY, expected.bytes())
                    .putString(SHA256_KEY, expected.sha256())
                    .commit()) {
                    throw new StoreException(
                        "PENDING_OPEN_JSON_JOURNAL_FAILED",
                        "无法保存备份暂存指纹"
                    );
                }
                authenticatedPayloadPersisted = true;
                atomicReplaceLocked(pending, committed);
                requireDirectorySyncLocked();
                PersonalExportFingerprint actual = fingerprintLocked(committed);
                validateUtf8StrictLocked(committed);
                if (!expected.matches(actual)) {
                    throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存提交后校验失败");
                }
                if (!readyPhaseCommitter.commit(preferences)) {
                    // PREPARING + exact fingerprint + committed file is intentionally
                    // retained. probe() can safely finish this crash boundary.
                    throw StoreException.retryable("备份已安全暂存，将在下次打开时重试", null);
                }
                return new Metadata(
                    id,
                    expected.bytes(),
                    expected.sha256(),
                    journal.displayName,
                    journal.lastModifiedEpochMillis
                );
            } catch (StoreException error) {
                if (authenticatedPayloadPersisted
                    && "PENDING_OPEN_JSON_STAGE_FAILED".equals(error.code)) {
                    throw StoreException.retryable("备份已安全暂存，将在下次打开时重试", error);
                }
                throw error;
            } catch (PersonalExportPlugin.JsonSizeLimitExceededException error) {
                throw new StoreException("DOCUMENT_TOO_LARGE", "备份文件超过 12 MiB 安全上限", error);
            } catch (PersonalExportPlugin.InvalidUtf8Exception error) {
                throw new StoreException("DOCUMENT_INVALID_UTF8", "备份文件不是有效 UTF-8", error);
            } catch (IOException | RuntimeException error) {
                if (authenticatedPayloadPersisted) {
                    throw StoreException.retryable("备份已安全暂存，将在下次打开时重试", error);
                }
                throw new StoreException("DOCUMENT_READ_FAILED", "无法读取备份文件", error);
            }
        }
    }

    boolean abortPreparing(String id) {
        if (!PersonalFilePolicy.isValidSessionToken(id)) return false;
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            if (journal.status == JournalStatus.NONE) return true;
            if (journal.status != JournalStatus.PREPARING || !id.equals(journal.id)) return false;
            if (!eraseLocked(newFile(id)) || !eraseLocked(finalFile(id))) return false;
            return clearJournalLocked(null);
        }
    }

    Probe probe() throws StoreException {
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            if (journal.status == JournalStatus.NONE) {
                if (hasOwnedArtifactsLocked()) {
                    throw new StoreException(
                        "PENDING_OPEN_JSON_CORRUPT",
                        "发现没有恢复记录的备份暂存"
                    );
                }
                return new Probe(false, null);
            }
            if (journal.status == JournalStatus.CORRUPT) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存恢复记录已损坏");
            }
            if (journal.status == JournalStatus.PREPARING) {
                if (journal.fingerprint == null) {
                    // A crash before the fingerprint commit cannot prove that a
                    // syntactically valid .new file reached EOF. Securely erase
                    // it and make the next probe ask for a fresh selection.
                    if (eraseLocked(newFile(journal.id))
                        && eraseLocked(finalFile(journal.id))
                        && clearJournalLocked(null)) {
                        throw new StoreException(
                            "PENDING_OPEN_JSON_PREPARING_ABORTED",
                            "上次备份暂存未完成，请重新选择文件"
                        );
                    }
                    throw new StoreException(
                        "PENDING_OPEN_JSON_PREPARING",
                        "备份仍在安全暂存中，请稍后重试"
                    );
                }
                Journal recovered = recoverPreparingCommitLocked(journal);
                if (recovered == null) {
                    throw new StoreException(
                        "PENDING_OPEN_JSON_PREPARING",
                        "备份仍在安全暂存中，请稍后重试"
                    );
                }
                journal = recovered;
            }
            Metadata metadata = requireReadyMetadataLocked(journal);
            return new Probe(true, metadata);
        }
    }

    Chunk readChunk(String id, Object requestedOffset) throws StoreException {
        if (!PersonalFilePolicy.isValidSessionToken(id)) {
            throw new StoreException("PENDING_OPEN_JSON_INVALID_ID", "备份暂存标识无效");
        }
        Long offset = exactOffset(requestedOffset);
        if (offset == null) {
            throw new StoreException("PENDING_OPEN_JSON_INVALID_OFFSET", "备份分片偏移无效");
        }
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            Metadata metadata = requireReadyMetadataLocked(journal);
            if (!id.equals(metadata.id)) {
                throw new StoreException("PENDING_OPEN_JSON_STALE", "备份暂存标识已经变化");
            }
            if (offset > metadata.byteLength) {
                throw new StoreException("PENDING_OPEN_JSON_INVALID_OFFSET", "备份分片偏移越界");
            }
            File file = finalFile(id);
            if (!file.isFile() || file.length() != metadata.byteLength) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存长度校验失败");
            }
            int requested = (int) Math.min(MAX_CHUNK_BYTES, metadata.byteLength - offset);
            byte[] bytes = new byte[requested];
            try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                input.seek(offset);
                int filled = 0;
                while (filled < bytes.length) {
                    int count = input.read(bytes, filled, bytes.length - filled);
                    if (count < 0) {
                        throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存读取时被截断");
                    }
                    if (count == 0) continue;
                    filled += count;
                }
                if (input.length() != metadata.byteLength) {
                    throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存在读取时发生变化");
                }
            } catch (StoreException error) {
                throw error;
            } catch (IOException | RuntimeException error) {
                throw new StoreException("PENDING_OPEN_JSON_READ_FAILED", "无法读取备份暂存分片", error);
            }
            long nextOffset = offset + bytes.length;
            return new Chunk(
                metadata,
                offset,
                nextOffset,
                nextOffset == metadata.byteLength,
                Base64.encodeToString(bytes, Base64.NO_WRAP),
                sha256Hex(bytes)
            );
        }
    }

    Acknowledgement acknowledge(String id) throws StoreException {
        if (!PersonalFilePolicy.isValidSessionToken(id)) {
            throw new StoreException("PENDING_OPEN_JSON_INVALID_ID", "备份暂存标识无效");
        }
        synchronized (LOCK) {
            Journal journal = readJournalLocked();
            if (journal.status == JournalStatus.NONE) {
                String lastAcknowledged = safePreferenceString(LAST_ACKNOWLEDGED_ID_KEY);
                if (id.equals(lastAcknowledged)) return new Acknowledgement(true);
                throw new StoreException("PENDING_OPEN_JSON_STALE", "没有可确认的备份暂存");
            }
            if (journal.status == JournalStatus.CORRUPT) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存恢复记录已损坏");
            }
            if (!id.equals(journal.id)) {
                throw new StoreException("PENDING_OPEN_JSON_STALE", "备份暂存标识已经变化");
            }
            if (journal.status == JournalStatus.PREPARING) {
                throw new StoreException("PENDING_OPEN_JSON_PREPARING", "备份仍在安全暂存中");
            }
            // Never report acknowledgement until both possible owned artifacts
            // have been truncated, synced, unlinked and the directory is synced.
            if (!eraseLocked(newFile(id)) || !eraseLocked(finalFile(id))) {
                throw new StoreException("PENDING_OPEN_JSON_ACK_FAILED", "备份暂存无法安全删除");
            }
            if (!clearJournalLocked(id)) {
                throw new StoreException("PENDING_OPEN_JSON_ACK_FAILED", "备份暂存确认记录无法提交");
            }
            return new Acknowledgement(false);
        }
    }

    boolean purgeAll() {
        synchronized (LOCK) {
            boolean erased = true;
            if (directory.exists()) {
                File[] files = directory.listFiles();
                if (files == null) return false;
                for (File file : files) {
                    if (file.isFile() && isOwnedFilename(file.getName()) && !eraseLocked(file)) erased = false;
                }
            }
            if (!erased || hasOwnedArtifactsLocked()) return false;
            try {
                return preferences.edit()
                    .remove(PHASE_KEY)
                    .remove(ID_KEY)
                    .remove(BYTE_LENGTH_KEY)
                    .remove(SHA256_KEY)
                    .remove(DISPLAY_NAME_KEY)
                    .remove(LAST_MODIFIED_KEY)
                    .remove(LAST_ACKNOWLEDGED_ID_KEY)
                    .commit();
            } catch (RuntimeException error) {
                return false;
            }
        }
    }

    File directoryForTesting() {
        return directory;
    }

    private Journal recoverPreparingCommitLocked(Journal journal) throws StoreException {
        if (journal.fingerprint == null) return null;
        File committed = finalFile(journal.id);
        File pending = newFile(journal.id);
        if (committed.exists() && pending.exists()) {
            throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存同时存在新旧提交文件");
        }
        File candidate = committed.exists() ? committed : pending.exists() ? pending : null;
        if (candidate == null || !candidate.isFile()) return null;
        try {
            PersonalExportFingerprint actual = fingerprintLocked(candidate);
            validateUtf8StrictLocked(candidate);
            if (!journal.fingerprint.matches(actual)) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存恢复指纹不匹配");
            }
            if (candidate.equals(pending)) {
                atomicReplaceLocked(pending, committed);
                requireDirectorySyncLocked();
            }
            if (!readyPhaseCommitter.commit(preferences)) {
                throw StoreException.retryable("备份暂存恢复记录暂未发布，请重试", null);
            }
            return new Journal(
                JournalStatus.READY,
                journal.id,
                journal.fingerprint,
                journal.displayName,
                journal.lastModifiedEpochMillis
            );
        } catch (StoreException error) {
            throw error;
        } catch (PersonalExportPlugin.InvalidUtf8Exception error) {
            throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存 UTF-8 校验失败", error);
        } catch (IOException | RuntimeException error) {
            throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存恢复失败", error);
        }
    }

    private Metadata requireReadyMetadataLocked(Journal journal) throws StoreException {
        if (journal.status == JournalStatus.NONE) {
            throw new StoreException("PENDING_OPEN_JSON_UNAVAILABLE", "没有待处理的备份暂存");
        }
        if (journal.status == JournalStatus.PREPARING) {
            throw new StoreException("PENDING_OPEN_JSON_PREPARING", "备份仍在安全暂存中");
        }
        if (journal.status != JournalStatus.READY || journal.fingerprint == null) {
            throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存恢复记录已损坏");
        }
        File file = finalFile(journal.id);
        if (!file.isFile()) {
            throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存文件缺失");
        }
        try {
            PersonalExportFingerprint actual = fingerprintLocked(file);
            if (!journal.fingerprint.matches(actual)) {
                throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存指纹不匹配");
            }
        } catch (StoreException error) {
            throw error;
        } catch (IOException | RuntimeException error) {
            throw new StoreException("PENDING_OPEN_JSON_CORRUPT", "备份暂存无法校验", error);
        }
        return new Metadata(
            journal.id,
            journal.fingerprint.bytes(),
            journal.fingerprint.sha256(),
            journal.displayName,
            journal.lastModifiedEpochMillis
        );
    }

    private Journal readJournalLocked() {
        try {
            Map<String, ?> values = preferences.getAll();
            JournalStatus status = journalStatus(values);
            if (status == JournalStatus.NONE || status == JournalStatus.CORRUPT) {
                return new Journal(status, null, null, null, 0L);
            }
            String id = (String) values.get(ID_KEY);
            PersonalExportFingerprint fingerprint = null;
            if (values.containsKey(BYTE_LENGTH_KEY)) {
                fingerprint = PersonalExportFingerprint.stored(
                    (Long) values.get(BYTE_LENGTH_KEY),
                    (String) values.get(SHA256_KEY)
                );
            }
            String displayName = values.containsKey(DISPLAY_NAME_KEY)
                ? (String) values.get(DISPLAY_NAME_KEY)
                : null;
            long lastModifiedEpochMillis = values.containsKey(LAST_MODIFIED_KEY)
                ? (Long) values.get(LAST_MODIFIED_KEY)
                : 0L;
            return new Journal(status, id, fingerprint, displayName, lastModifiedEpochMillis);
        } catch (RuntimeException error) {
            return new Journal(JournalStatus.CORRUPT, null, null, null, 0L);
        }
    }

    private boolean clearJournalLocked(String acknowledgedId) {
        try {
            SharedPreferences.Editor editor = preferences.edit()
                .remove(PHASE_KEY)
                .remove(ID_KEY)
                .remove(BYTE_LENGTH_KEY)
                .remove(SHA256_KEY)
                .remove(DISPLAY_NAME_KEY)
                .remove(LAST_MODIFIED_KEY);
            if (acknowledgedId != null) editor.putString(LAST_ACKNOWLEDGED_ID_KEY, acknowledgedId);
            return editor.commit();
        } catch (RuntimeException error) {
            return false;
        }
    }

    private String safePreferenceString(String key) {
        try {
            return preferences.getString(key, null);
        } catch (ClassCastException error) {
            return null;
        }
    }

    private void prepareDirectoryLocked() throws StoreException {
        boolean created = false;
        if (!directory.exists()) {
            created = directory.mkdirs();
        }
        if (!directory.isDirectory()) {
            throw new StoreException("PENDING_OPEN_JSON_STAGE_FAILED", "无法创建备份暂存目录");
        }
        if (created && !PersonalExportPlugin.syncDirectory(context.getNoBackupFilesDir())) {
            throw new StoreException("PENDING_OPEN_JSON_STAGE_FAILED", "无法提交备份暂存目录");
        }
    }

    private PersonalExportFingerprint copySelectedBytesLocked(InputStream input, File target)
        throws IOException {
        MessageDigest digest = newDigest();
        byte[] buffer = new byte[BUFFER_BYTES];
        long total = 0L;
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (count == 0) {
                    int next = input.read();
                    if (next == -1) break;
                    if (total >= PersonalFilePolicy.MAX_JSON_BYTES) {
                        throw new PersonalExportPlugin.JsonSizeLimitExceededException();
                    }
                    output.write(next);
                    digest.update((byte) next);
                    total++;
                    continue;
                }
                if ((long) count > PersonalFilePolicy.MAX_JSON_BYTES - total) {
                    throw new PersonalExportPlugin.JsonSizeLimitExceededException();
                }
                output.write(buffer, 0, count);
                digest.update(buffer, 0, count);
                total += count;
            }
            output.flush();
            output.getFD().sync();
        }
        PersonalExportFingerprint fingerprint = PersonalExportFingerprint.stored(total, toHex(digest.digest()));
        if (fingerprint == null) throw new IOException("invalid staged fingerprint");
        return fingerprint;
    }

    private static void validateUtf8StrictLocked(File file)
        throws IOException, PersonalExportPlugin.InvalidUtf8Exception {
        try (Reader reader = new InputStreamReader(
            new FileInputStream(file),
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
        )) {
            char[] buffer = new char[BUFFER_CHARS];
            while (reader.read(buffer) != -1) { /* validate without materializing */ }
        } catch (CharacterCodingException error) {
            throw new PersonalExportPlugin.InvalidUtf8Exception(error);
        }
    }

    private PersonalExportFingerprint fingerprintLocked(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return PersonalExportFingerprint.read(input, PersonalFilePolicy.MAX_JSON_BYTES);
        }
    }

    private void atomicReplaceLocked(File source, File target) throws IOException {
        try {
            Os.rename(source.getAbsolutePath(), target.getAbsolutePath());
        } catch (ErrnoException error) {
            throw new IOException("Atomic openJson rename failed", error);
        }
        if (source.exists() || !target.isFile()) {
            throw new IOException("Atomic openJson rename verification failed");
        }
    }

    private void requireDirectorySyncLocked() throws StoreException {
        if (!PersonalExportPlugin.syncDirectory(directory)) {
            throw new StoreException("PENDING_OPEN_JSON_STAGE_FAILED", "无法提交备份暂存目录变更");
        }
    }

    private boolean eraseLocked(File file) {
        if (file == null) return false;
        if (!file.exists()) return PersonalExportPlugin.syncDirectory(directory);
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.flush();
            output.getFD().sync();
        } catch (IOException | RuntimeException error) {
            return false;
        }
        if ((!file.delete() && file.exists()) || !PersonalExportPlugin.syncDirectory(directory)) return false;
        return !file.exists();
    }

    private boolean hasOwnedArtifactsLocked() {
        if (!directory.exists()) return false;
        File[] files = directory.listFiles();
        if (files == null) return true;
        for (File file : files) {
            if (file.isFile() && isOwnedFilename(file.getName())) return true;
        }
        return false;
    }

    private static boolean isOwnedFilename(String name) {
        if (name == null) return false;
        String id = name.endsWith(NEW_SUFFIX)
            ? name.substring(0, name.length() - NEW_SUFFIX.length())
            : name.endsWith(FINAL_SUFFIX)
                ? name.substring(0, name.length() - FINAL_SUFFIX.length())
                : null;
        return PersonalFilePolicy.isValidSessionToken(id);
    }

    private File finalFile(String id) {
        return new File(directory, id + FINAL_SUFFIX);
    }

    private File newFile(String id) {
        return new File(directory, id + NEW_SUFFIX);
    }

    private static MessageDigest newDigest() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IOException("SHA-256 unavailable", error);
        }
    }

    private static String sha256Hex(byte[] value) throws StoreException {
        try {
            return toHex(newDigest().digest(value));
        } catch (IOException error) {
            throw new StoreException("PENDING_OPEN_JSON_READ_FAILED", "SHA-256 不可用", error);
        }
    }

    private static String toHex(byte[] bytes) {
        char[] result = new char[bytes.length * 2];
        for (int index = 0; index < bytes.length; index++) {
            int value = bytes[index] & 0xff;
            result[index * 2] = HEX[value >>> 4];
            result[index * 2 + 1] = HEX[value & 0x0f];
        }
        return new String(result);
    }
}
