package cn.wuyantongxing.personal;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.webkit.JavascriptInterface;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Synchronous, process-thread-safe storage for the bundled WebView's fixed health-state keys.
 * Writes commit by syncing a same-directory .new file, atomically renaming it, then syncing the
 * parent directory. This avoids the non-atomic first-write behavior of Android 8 AtomicFile.
 */
public final class WuyanDurableStore {
    private static final String STORE_DIRECTORY = "wuyan-durable-store-v1";
    private static final Object FILE_LOCK = new Object();

    private final File directory;

    public WuyanDurableStore(Context context) {
        this(new File(context.getNoBackupFilesDir(), STORE_DIRECTORY));
    }

    WuyanDurableStore(File directory) {
        synchronized (FILE_LOCK) {
            this.directory = prepareDirectory(directory);
        }
    }

    @JavascriptInterface
    public String readValue(String key) {
        synchronized (FILE_LOCK) {
            String value = readRawValueLocked(key);
            if (value == null) return null;
            try {
                WuyanDurableStorePolicy.requireValidJson(value);
            } catch (IllegalArgumentException error) {
                throw new IllegalStateException(
                    "WUYAN_DURABLE_STORE_CORRUPT_JSON",
                    error
                );
            }
            return value;
        }
    }

    /**
     * Recovery-only read: preserves invalid JSON for an explicit user export while still rejecting
     * oversized or malformed UTF-8 files. Normal application reads must use {@link #readValue}.
     */
    @JavascriptInterface
    public String readRawValue(String key) {
        synchronized (FILE_LOCK) {
            return readRawValueLocked(key);
        }
    }

    @JavascriptInterface
    public boolean hasValue(String key) {
        String filename = WuyanDurableStorePolicy.filenameForKey(key);
        synchronized (FILE_LOCK) {
            try {
                return hasCommittedValueLocked(filename);
            } catch (IOException | SecurityException error) {
                throw new IllegalStateException(
                    "WUYAN_DURABLE_STORE_READ_FAILED",
                    error
                );
            }
        }
    }

    @JavascriptInterface
    public void writeValue(String key, String value) {
        String filename = WuyanDurableStorePolicy.filenameForKey(key);
        byte[] bytes = WuyanDurableStorePolicy.encodeJsonValue(value);
        synchronized (FILE_LOCK) {
            File base = new File(directory, filename);
            File pending = new File(directory, filename + ".new");
            try {
                recoverCommittedFileLocked(filename);
                deleteIfPresent(pending);
                try (FileOutputStream output = new FileOutputStream(pending)) {
                    output.write(bytes);
                    output.flush();
                    output.getFD().sync();
                }
                atomicReplace(pending, base);
                syncDirectory(directory);
                byte[] committed = readBytesLocked(filename);
                if (committed == null || !Arrays.equals(bytes, committed)) {
                    throw new IOException("Atomic write verification failed");
                }
            } catch (IOException | RuntimeException error) {
                try {
                    deleteIfPresent(pending);
                } catch (IOException cleanupError) {
                    error.addSuppressed(cleanupError);
                }
                throw new IllegalStateException(
                    "WUYAN_DURABLE_STORE_WRITE_FAILED",
                    error
                );
            }
        }
    }

    @JavascriptInterface
    public void removeValue(String key) {
        String filename = WuyanDurableStorePolicy.filenameForKey(key);
        synchronized (FILE_LOCK) {
            File base = new File(directory, filename);
            File pending = new File(directory, filename + ".new");
            File legacyBackup = new File(directory, filename + ".bak");
            try {
                // Clear recovery candidates first so a deleted base cannot be resurrected.
                deleteIfPresent(pending);
                deleteIfPresent(legacyBackup);
                deleteIfPresent(base);
                syncDirectory(directory);
                if (base.exists() || pending.exists() || legacyBackup.exists()) {
                    throw new IOException("Delete verification failed");
                }
            } catch (IOException | SecurityException error) {
                throw new IllegalStateException(
                    "WUYAN_DURABLE_STORE_REMOVE_FAILED",
                    error
                );
            }
        }
    }

    private String readRawValueLocked(String key) {
        String filename = WuyanDurableStorePolicy.filenameForKey(key);
        byte[] bytes;
        try {
            bytes = readBytesLocked(filename);
        } catch (IOException | SecurityException error) {
            throw new IllegalStateException(
                "WUYAN_DURABLE_STORE_READ_FAILED",
                error
            );
        }
        if (bytes == null) return null;
        return WuyanDurableStorePolicy.decodeStoredUtf8(bytes);
    }

    private byte[] readBytesLocked(String filename) throws IOException {
        File base = recoverCommittedFileLocked(filename);
        if (base == null) return null;

        long fileLength = base.length();
        if (fileLength > WuyanDurableStorePolicy.MAX_VALUE_BYTES) {
            throw new IOException("Stored value exceeds 4 MiB");
        }

        byte[] bytes = new byte[(int) fileLength];
        try (FileInputStream input = new FileInputStream(base)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count == -1) {
                    throw new IOException("Stored value was truncated while reading");
                }
                if (count == 0) {
                    int next = input.read();
                    if (next == -1) {
                        throw new IOException("Stored value was truncated while reading");
                    }
                    bytes[offset++] = (byte) next;
                    continue;
                }
                offset += count;
            }
            if (input.read() != -1) {
                throw new IOException("Stored value changed while reading");
            }
            return bytes;
        }
    }

    private boolean hasCommittedValueLocked(String filename) throws IOException {
        File base = recoverCommittedFileLocked(filename);
        if (base == null) return false;
        // Open and close only; no value bytes cross the JS bridge for an existence check.
        try (FileInputStream ignored = new FileInputStream(base)) {
            return true;
        }
    }

    private File recoverCommittedFileLocked(String filename) throws IOException {
        File base = new File(directory, filename);
        File pending = new File(directory, filename + ".new");
        File legacyBackup = new File(directory, filename + ".bak");
        boolean directoryChanged = false;

        // Android 8 AtomicFile used .bak; if one exists, it is the last committed value.
        if (legacyBackup.exists()) {
            atomicReplace(legacyBackup, base);
            directoryChanged = true;
        }
        // A .new file is never visible until rename commits it, including on a first write.
        if (deleteIfPresent(pending)) directoryChanged = true;
        if (directoryChanged) syncDirectory(directory);

        if (!base.exists()) return null;
        if (!base.isFile()) throw new IOException("Committed durable value is not a file");
        return base;
    }

    private static void atomicReplace(File source, File target) throws IOException {
        try {
            Os.rename(source.getAbsolutePath(), target.getAbsolutePath());
        } catch (ErrnoException error) {
            throw new IOException("Atomic durable-store rename failed", error);
        }
        if (source.exists() || !target.isFile()) {
            throw new IOException("Atomic durable-store rename verification failed");
        }
    }

    private static void syncDirectory(File directory) throws IOException {
        FileDescriptor descriptor = null;
        IOException failure = null;
        try {
            descriptor = Os.open(
                directory.getAbsolutePath(),
                OsConstants.O_RDONLY,
                0
            );
            Os.fsync(descriptor);
        } catch (ErrnoException error) {
            failure = new IOException("Durable-store directory sync failed", error);
        } finally {
            if (descriptor != null) {
                try {
                    Os.close(descriptor);
                } catch (ErrnoException error) {
                    IOException closeFailure = new IOException(
                        "Durable-store directory close failed",
                        error
                    );
                    if (failure == null) failure = closeFailure;
                    else failure.addSuppressed(closeFailure);
                }
            }
        }
        if (failure != null) throw failure;
    }

    private static File prepareDirectory(File directory) {
        if (directory == null) {
            throw new IllegalStateException("WUYAN_DURABLE_STORE_DIRECTORY_UNAVAILABLE");
        }
        List<File> missingDirectories = new ArrayList<>();
        File cursor = directory;
        while (cursor != null && !cursor.exists()) {
            missingDirectories.add(cursor);
            cursor = cursor.getParentFile();
        }
        if (
            !directory.isDirectory() &&
            !directory.mkdirs() &&
            !directory.isDirectory()
        ) {
            throw new IllegalStateException("WUYAN_DURABLE_STORE_DIRECTORY_UNAVAILABLE");
        }
        if (!directory.isDirectory()) {
            throw new IllegalStateException("WUYAN_DURABLE_STORE_DIRECTORY_UNAVAILABLE");
        }
        try {
            // mkdirs may create multiple levels. Persist each new directory entry in its parent,
            // from the outermost new directory down to the store directory itself.
            for (int index = missingDirectories.size() - 1; index >= 0; index--) {
                File createdDirectory = missingDirectories.get(index);
                if (!createdDirectory.isDirectory()) {
                    throw new IOException("Created durable-store path is not a directory");
                }
                File parent = createdDirectory.getParentFile();
                if (parent != null) syncDirectory(parent);
            }
        } catch (IOException | SecurityException error) {
            throw new IllegalStateException(
                "WUYAN_DURABLE_STORE_DIRECTORY_UNAVAILABLE",
                error
            );
        }
        return directory;
    }

    private static boolean deleteIfPresent(File file) throws IOException {
        boolean existed = file.exists();
        if (file.exists() && !file.delete()) {
            throw new IOException("Unable to delete durable-store file");
        }
        if (file.exists()) throw new IOException("Durable-store file still exists");
        return existed;
    }
}
