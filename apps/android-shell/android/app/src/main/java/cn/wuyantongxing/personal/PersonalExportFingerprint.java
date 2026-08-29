package cn.wuyantongxing.personal;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Bounded, streaming fingerprint used to resolve an interrupted SAF write. */
final class PersonalExportFingerprint {
    private final long bytes;
    private final String sha256;

    private PersonalExportFingerprint(long bytes, String sha256) {
        this.bytes = bytes;
        this.sha256 = sha256;
    }

    long bytes() {
        return bytes;
    }

    String sha256() {
        return sha256;
    }

    static PersonalExportFingerprint read(InputStream input, long maximumBytes) throws IOException {
        if (maximumBytes < 0L) throw new IOException("invalid byte limit");
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IOException("SHA-256 unavailable", error);
        }
        byte[] buffer = new byte[32 * 1024];
        long total = 0L;
        int count;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > maximumBytes) throw new IOException("document exceeds safe byte limit");
            digest.update(buffer, 0, count);
        }
        return new PersonalExportFingerprint(total, toHex(digest.digest()));
    }

    boolean matches(PersonalExportFingerprint other) {
        return other != null && bytes == other.bytes && sha256.equals(other.sha256);
    }

    static PersonalExportFingerprint stored(long bytes, String sha256) {
        if (bytes < 0L || sha256 == null || !sha256.matches("[0-9a-f]{64}")) return null;
        return new PersonalExportFingerprint(bytes, sha256);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }
}
