package cn.wuyantongxing.personal;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

final class WuyanDurableStorePolicy {
    static final String CLIENT_STATE_KEY = "wuyan-tongxing/client-state/v1";
    static final String LAST_KNOWN_GOOD_KEY =
        "wuyan-tongxing/client-state/v1/last-known-good";
    static final String DELETION_IN_PROGRESS_KEY =
        "wuyan-tongxing/client-state/v1/deletion-in-progress";
    static final String BOOTSTRAP_CIGARETTES_KEY =
        "wuyan-tongxing/android-bootstrap-cigarettes/v1";
    static final String SYSTEM_SHORTCUT_CIGARETTES_KEY =
        "wuyan-tongxing/android-system-shortcut-cigarettes/v1";
    static final String BOOTSTRAP_CIGARETTES_QUARANTINE_KEY =
        "wuyan-tongxing/android-bootstrap-cigarettes-quarantine/v1";
    static final String BOOTSTRAP_CIGARETTES_CORRUPT_KEY =
        "wuyan-tongxing/android-bootstrap-cigarettes-corrupt/v1";
    static final String BOOTSTRAP_IMPORT_JOURNAL_KEY =
        "wuyan-tongxing/android-bootstrap-import-journal/v1";
    static final String BACKUP_RESTORE_INTENT_KEY =
        "wuyan-tongxing/android-backup-restore-intent/v1";
    static final int MAX_VALUE_BYTES = 4 * 1024 * 1024;

    private static final int MAX_JSON_NESTING = 512;

    private WuyanDurableStorePolicy() {}

    static String filenameForKey(String key) {
        if (CLIENT_STATE_KEY.equals(key)) return "client-state-v1.json";
        if (LAST_KNOWN_GOOD_KEY.equals(key)) {
            return "client-state-v1-last-known-good.json";
        }
        if (DELETION_IN_PROGRESS_KEY.equals(key)) {
            return "client-state-v1-deletion-in-progress.json";
        }
        if (BOOTSTRAP_CIGARETTES_KEY.equals(key)) {
            return "android-bootstrap-cigarettes-v1.json";
        }
        if (SYSTEM_SHORTCUT_CIGARETTES_KEY.equals(key)) {
            return "android-system-shortcut-cigarettes-v1.json";
        }
        if (BOOTSTRAP_CIGARETTES_QUARANTINE_KEY.equals(key)) {
            return "android-bootstrap-cigarettes-quarantine-v1.json";
        }
        if (BOOTSTRAP_CIGARETTES_CORRUPT_KEY.equals(key)) {
            return "android-bootstrap-cigarettes-corrupt-v1.json";
        }
        if (BOOTSTRAP_IMPORT_JOURNAL_KEY.equals(key)) {
            return "android-bootstrap-import-journal-v1.json";
        }
        if (BACKUP_RESTORE_INTENT_KEY.equals(key)) {
            return "android-backup-restore-intent-v1.json";
        }
        throw new IllegalArgumentException("WUYAN_DURABLE_STORE_INVALID_KEY");
    }

    static byte[] encodeJsonValue(String value) {
        byte[] bytes = encodeUtf8(value);
        if (bytes.length > MAX_VALUE_BYTES) {
            throw new IllegalArgumentException("WUYAN_DURABLE_STORE_VALUE_TOO_LARGE");
        }
        requireValidJson(value);
        return bytes;
    }

    static String decodeStoredUtf8(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString();
        } catch (CharacterCodingException error) {
            throw new IllegalStateException(
                "WUYAN_DURABLE_STORE_CORRUPT_UTF8",
                error
            );
        }
    }

    static void requireValidJson(String value) {
        if (value == null) {
            throw new IllegalArgumentException("WUYAN_DURABLE_STORE_INVALID_JSON");
        }
        try {
            new StrictJsonParser(value).parseDocument();
        } catch (JsonSyntaxException error) {
            throw new IllegalArgumentException(
                "WUYAN_DURABLE_STORE_INVALID_JSON",
                error
            );
        }
    }

    private static byte[] encodeUtf8(String value) {
        if (value == null) {
            throw new IllegalArgumentException("WUYAN_DURABLE_STORE_INVALID_JSON");
        }
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8
                .newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(CharBuffer.wrap(value));
            byte[] bytes = new byte[encoded.remaining()];
            encoded.get(bytes);
            return bytes;
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException(
                "WUYAN_DURABLE_STORE_INVALID_UTF8",
                error
            );
        }
    }

    /** A dependency-free, strict RFC 8259 syntax check used by both JVM tests and Android. */
    private static final class StrictJsonParser {
        private final String source;
        private int position;

        StrictJsonParser(String source) {
            this.source = source;
        }

        void parseDocument() throws JsonSyntaxException {
            skipWhitespace();
            if (position == source.length()) throw syntaxError();
            parseValue(0);
            skipWhitespace();
            if (position != source.length()) throw syntaxError();
        }

        private void parseValue(int depth) throws JsonSyntaxException {
            if (position >= source.length()) throw syntaxError();
            char current = source.charAt(position);
            if (current == '{') {
                parseObject(depth + 1);
            } else if (current == '[') {
                parseArray(depth + 1);
            } else if (current == '"') {
                parseString();
            } else if (current == 't') {
                parseLiteral("true");
            } else if (current == 'f') {
                parseLiteral("false");
            } else if (current == 'n') {
                parseLiteral("null");
            } else if (current == '-' || isDigit(current)) {
                parseNumber();
            } else {
                throw syntaxError();
            }
        }

        private void parseObject(int depth) throws JsonSyntaxException {
            requireNesting(depth);
            position++;
            skipWhitespace();
            if (consume('}')) return;
            while (true) {
                if (position >= source.length() || source.charAt(position) != '"') {
                    throw syntaxError();
                }
                parseString();
                skipWhitespace();
                require(':');
                skipWhitespace();
                parseValue(depth);
                skipWhitespace();
                if (consume('}')) return;
                require(',');
                skipWhitespace();
            }
        }

        private void parseArray(int depth) throws JsonSyntaxException {
            requireNesting(depth);
            position++;
            skipWhitespace();
            if (consume(']')) return;
            while (true) {
                parseValue(depth);
                skipWhitespace();
                if (consume(']')) return;
                require(',');
                skipWhitespace();
            }
        }

        private void parseString() throws JsonSyntaxException {
            require('"');
            while (position < source.length()) {
                char current = source.charAt(position++);
                if (current == '"') return;
                if (current < 0x20) throw syntaxError();
                if (current != '\\') continue;
                if (position >= source.length()) throw syntaxError();
                char escaped = source.charAt(position++);
                if (
                    escaped == '"' ||
                    escaped == '\\' ||
                    escaped == '/' ||
                    escaped == 'b' ||
                    escaped == 'f' ||
                    escaped == 'n' ||
                    escaped == 'r' ||
                    escaped == 't'
                ) {
                    continue;
                }
                if (escaped != 'u' || position + 4 > source.length()) {
                    throw syntaxError();
                }
                for (int index = 0; index < 4; index++) {
                    if (Character.digit(source.charAt(position + index), 16) < 0) {
                        throw syntaxError();
                    }
                }
                position += 4;
            }
            throw syntaxError();
        }

        private void parseNumber() throws JsonSyntaxException {
            consume('-');
            if (consume('0')) {
                if (position < source.length() && isDigit(source.charAt(position))) {
                    throw syntaxError();
                }
            } else {
                requireDigitOneToNine();
                while (position < source.length() && isDigit(source.charAt(position))) {
                    position++;
                }
            }
            if (consume('.')) {
                requireDigit();
                while (position < source.length() && isDigit(source.charAt(position))) {
                    position++;
                }
            }
            if (consume('e') || consume('E')) {
                if (!consume('+')) consume('-');
                requireDigit();
                while (position < source.length() && isDigit(source.charAt(position))) {
                    position++;
                }
            }
        }

        private void parseLiteral(String literal) throws JsonSyntaxException {
            if (!source.regionMatches(position, literal, 0, literal.length())) {
                throw syntaxError();
            }
            position += literal.length();
        }

        private void requireNesting(int depth) throws JsonSyntaxException {
            if (depth > MAX_JSON_NESTING) throw syntaxError();
        }

        private void skipWhitespace() {
            while (position < source.length()) {
                char current = source.charAt(position);
                if (
                    current != ' ' &&
                    current != '\t' &&
                    current != '\n' &&
                    current != '\r'
                ) {
                    return;
                }
                position++;
            }
        }

        private void require(char expected) throws JsonSyntaxException {
            if (!consume(expected)) throw syntaxError();
        }

        private void requireDigit() throws JsonSyntaxException {
            if (position >= source.length() || !isDigit(source.charAt(position))) {
                throw syntaxError();
            }
            position++;
        }

        private void requireDigitOneToNine() throws JsonSyntaxException {
            if (position >= source.length()) throw syntaxError();
            char current = source.charAt(position);
            if (current < '1' || current > '9') throw syntaxError();
            position++;
        }

        private boolean consume(char expected) {
            if (position < source.length() && source.charAt(position) == expected) {
                position++;
                return true;
            }
            return false;
        }

        private static boolean isDigit(char value) {
            return value >= '0' && value <= '9';
        }

        private JsonSyntaxException syntaxError() {
            return new JsonSyntaxException();
        }
    }

    private static final class JsonSyntaxException extends Exception {}
}
