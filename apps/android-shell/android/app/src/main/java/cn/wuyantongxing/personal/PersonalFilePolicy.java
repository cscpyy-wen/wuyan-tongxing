package cn.wuyantongxing.personal;

import java.util.regex.Pattern;

final class PersonalFilePolicy {
    // The bridge must materialize one Java String. Twelve MiB keeps the
    // streaming decoder's StringBuilder + result + bridge copies bounded while
    // still fitting two base64-framed 4 MiB native recovery slots.
    static final int MAX_JSON_BYTES = 12 * 1024 * 1024;
    static final int MAX_ORDINARY_EXPORT_BYTES = 4 * 1024 * 1024;
    // A low-escape 12 MiB recovery JSON stays close to its raw size when it is
    // nested in Capacitor's call envelope. Arbitrary high-escape strings do not.
    static final int MAX_SAVE_BRIDGE_ESCAPED_BYTES = 13 * 1024 * 1024;
    static final int MAX_RECOVERY_ESCAPE_OVERHEAD_BYTES = 1024 * 1024;
    static final String DEFAULT_FILENAME = "wuyan-tongxing-backup.json";
    private static final Pattern SESSION_TOKEN = Pattern.compile(
        "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern PENDING_FILENAME = Pattern.compile("^[a-f0-9-]{36}\\.pending-json$");

    private PersonalFilePolicy() {}

    static boolean isValidSessionToken(String token) {
        return token != null && SESSION_TOKEN.matcher(token).matches();
    }

    static boolean isValidPendingFilename(String filename) {
        return filename != null && PENDING_FILENAME.matcher(filename).matches();
    }

    static boolean isJsonSizeAllowed(String json) {
        long length = utf8ByteLength(json, MAX_JSON_BYTES);
        return length >= 0L && length <= MAX_JSON_BYTES;
    }

    /**
     * Counts strict UTF-8 without allocating a second payload-sized byte[].
     * Returns -1 for null or unpaired UTF-16 surrogates and limit + 1 when the
     * encoded form is too large. The early exit also bounds work for hostile
     * bridge input.
     */
    static long utf8ByteLength(String value, long maximumBytes) {
        if (value == null || maximumBytes < 0L || maximumBytes == Long.MAX_VALUE) return -1L;
        long bytes = 0L;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current <= 0x7f) {
                bytes += 1L;
            } else if (current <= 0x7ff) {
                bytes += 2L;
            } else if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return -1L;
                }
                index++;
                bytes += 4L;
            } else if (Character.isLowSurrogate(current)) {
                return -1L;
            } else {
                bytes += 3L;
            }
            if (bytes > maximumBytes) return maximumBytes + 1L;
        }
        return bytes;
    }

    /** Exact strict-UTF-8 length of this value after JSON string escaping. */
    static long jsonStringEscapedUtf8ByteLength(String value, long maximumBytes) {
        if (value == null || maximumBytes < 0L || maximumBytes == Long.MAX_VALUE) return -1L;
        long bytes = 0L;
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current == '"' || current == '\\'
                || current == '\b' || current == '\t' || current == '\n'
                || current == '\f' || current == '\r') {
                bytes += 2L;
            } else if (current <= 0x1f) {
                bytes += 6L;
            } else if (current <= 0x7f) {
                bytes += 1L;
            } else if (current <= 0x7ff) {
                bytes += 2L;
            } else if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return -1L;
                }
                index++;
                bytes += 4L;
            } else if (Character.isLowSurrogate(current)) {
                return -1L;
            } else {
                bytes += 3L;
            }
            if (bytes > maximumBytes) return maximumBytes + 1L;
        }
        return bytes;
    }

    static boolean isLowEscapeRecoveryBundle(String value, long rawBytes, long escapedBytes) {
        if (value == null
            || rawBytes < 0L
            || rawBytes > MAX_JSON_BYTES
            || escapedBytes < rawBytes
            || escapedBytes > MAX_SAVE_BRIDGE_ESCAPED_BYTES
            || escapedBytes - rawBytes > MAX_RECOVERY_ESCAPE_OVERHEAD_BYTES) return false;
        // The explicit mode is reserved for the bounded forensic bundle. These
        // structural sentinels avoid granting the 12 MiB path to an arbitrary
        // caller-controlled string without materialising a second JSON tree.
        return value.startsWith("{")
            && value.endsWith("}")
            && value.contains("\"readStatus\"")
            && value.contains("\"primary\"")
            && value.contains("\"lastKnownGood\"")
            && value.contains("\"_recoveryIntegrity\"");
    }

    static String safeFilename(String requested) {
        String cleaned = requested == null
            ? DEFAULT_FILENAME
            : requested.replaceAll("[^A-Za-z0-9._-]", "-")
                .replaceFirst("^[._-]+", "");
        if (cleaned.trim().isEmpty()) return DEFAULT_FILENAME;
        String withExtension = cleaned.toLowerCase().endsWith(".json")
            ? cleaned
            : cleaned + ".json";
        return withExtension.length() <= 120 ? withExtension : DEFAULT_FILENAME;
    }
}
