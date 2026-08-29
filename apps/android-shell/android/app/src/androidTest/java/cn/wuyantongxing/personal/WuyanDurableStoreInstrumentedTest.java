package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class WuyanDurableStoreInstrumentedTest {
    private File testDirectory;
    private WuyanDurableStore store;

    @Before
    public void setUp() {
        // A UUID-scoped debug-app cache directory cannot overlap production or durable user data.
        File isolatedCache = InstrumentationRegistry
            .getInstrumentation()
            .getTargetContext()
            .getCacheDir();
        testDirectory = new File(
            isolatedCache,
            "wuyan-durable-store-test-" + UUID.randomUUID()
        );
        store = new WuyanDurableStore(testDirectory);
    }

    @After
    public void tearDown() {
        deleteTree(testDirectory);
    }

    @Test
    public void atomicWriteOverwriteAndDeleteAreImmediatelyVisible() {
        String key = WuyanDurableStorePolicy.CLIENT_STATE_KEY;
        assertFalse(store.hasValue(key));
        assertNull(store.readValue(key));

        store.writeValue(key, "{\"counter\":1}");
        assertTrue(store.hasValue(key));
        assertEquals("{\"counter\":1}", store.readValue(key));
        assertEquals("{\"counter\":1}", store.readRawValue(key));

        store.writeValue(key, "{\"counter\":2,\"note\":\"已覆盖\"}");
        assertEquals(
            "{\"counter\":2,\"note\":\"已覆盖\"}",
            store.readValue(key)
        );

        store.removeValue(key);
        assertFalse(store.hasValue(key));
        assertNull(store.readValue(key));
        File base = fileForKey(key);
        assertFalse(base.exists());
        assertFalse(new File(base.getPath() + ".new").exists());
        assertFalse(new File(base.getPath() + ".bak").exists());
    }

    @Test
    public void interruptedReplacementKeepsLastCommittedValue() throws Exception {
        String key = WuyanDurableStorePolicy.LAST_KNOWN_GOOD_KEY;
        store.writeValue(key, "{\"committed\":true}");

        File pending = new File(fileForKey(key).getPath() + ".new");
        writeAndSync(pending, "{\"partial\":".getBytes(StandardCharsets.UTF_8));

        assertEquals("{\"committed\":true}", store.readValue(key));
        assertFalse(pending.exists());
    }

    @Test
    public void interruptedFirstWriteDoesNotExposePartialValue() throws Exception {
        String key = WuyanDurableStorePolicy.BOOTSTRAP_CIGARETTES_KEY;
        File base = fileForKey(key);
        File pending = new File(base.getPath() + ".new");
        writeAndSync(pending, "{\"partial\":".getBytes(StandardCharsets.UTF_8));

        assertFalse(base.exists());
        assertFalse(store.hasValue(key));
        assertNull(store.readValue(key));
        assertFalse(pending.exists());
    }

    @Test
    public void invalidJsonFailsClosedButRecoveryReadReturnsRawUtf8() throws Exception {
        String key = WuyanDurableStorePolicy.DELETION_IN_PROGRESS_KEY;
        store.writeValue(key, "{\"phase\":\"prepared\"}");
        String corrupt = "{\"phase\":";
        writeAndSync(fileForKey(key), corrupt.getBytes(StandardCharsets.UTF_8));

        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> store.readValue(key)
        );
        assertEquals("WUYAN_DURABLE_STORE_CORRUPT_JSON", error.getMessage());
        assertEquals(corrupt, store.readRawValue(key));
        assertTrue(store.hasValue(key));
    }

    @Test
    public void oversizedWriteIsRejectedWithoutReplacingCommittedValue() {
        String key = WuyanDurableStorePolicy.CLIENT_STATE_KEY;
        store.writeValue(key, "{\"stable\":true}");
        String oversized =
            "\"" + repeatAscii('a', WuyanDurableStorePolicy.MAX_VALUE_BYTES) + "\"";

        IllegalArgumentException error = assertThrows(
            IllegalArgumentException.class,
            () -> store.writeValue(key, oversized)
        );
        assertEquals("WUYAN_DURABLE_STORE_VALUE_TOO_LARGE", error.getMessage());
        assertEquals("{\"stable\":true}", store.readValue(key));
    }

    @Test
    public void recoveryReadAlsoRejectsFilesOverFourMib() throws Exception {
        String key = WuyanDurableStorePolicy.BACKUP_RESTORE_INTENT_KEY;
        byte[] oversized = new byte[WuyanDurableStorePolicy.MAX_VALUE_BYTES + 1];
        Arrays.fill(oversized, (byte) 'a');
        writeAndSync(fileForKey(key), oversized);

        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () -> store.readRawValue(key)
        );
        assertEquals("WUYAN_DURABLE_STORE_READ_FAILED", error.getMessage());
    }

    @Test
    public void javascriptCanCatchBridgeValidationFailuresWithoutSilentSuccess()
        throws Exception {
        CountDownLatch pageLoaded = new CountDownLatch(1);
        CountDownLatch evaluated = new CountDownLatch(1);
        AtomicReference<WebView> webViewReference = new AtomicReference<>();
        AtomicReference<String> result = new AtomicReference<>();

        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            WebView webView = new WebView(
                InstrumentationRegistry.getInstrumentation().getTargetContext()
            );
            webView.getSettings().setJavaScriptEnabled(true);
            webView.addJavascriptInterface(store, "WuyanDurableStore");
            webView.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        pageLoaded.countDown();
                    }
                }
            );
            webViewReference.set(webView);
            webView.loadDataWithBaseURL(
                "https://localhost/",
                "<!doctype html><html><body>test</body></html>",
                "text/html",
                "UTF-8",
                null
            );
        });

        try {
            assertTrue(pageLoaded.await(10, TimeUnit.SECONDS));
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                webViewReference.get().evaluateJavascript(
                    "(function(){try{" +
                        "WuyanDurableStore.hasValue('../not-allowed');" +
                        "return 'NO_THROW';" +
                        "}catch(error){return 'THREW:' + String(error);}})()",
                    value -> {
                        result.set(value);
                        evaluated.countDown();
                    }
                )
            );
            assertTrue(evaluated.await(10, TimeUnit.SECONDS));
            assertTrue(result.get().contains("THREW:"));
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                WebView webView = webViewReference.get();
                if (webView != null) webView.destroy();
            });
        }
    }

    private File fileForKey(String key) {
        return new File(testDirectory, WuyanDurableStorePolicy.filenameForKey(key));
    }

    private static void writeAndSync(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.getFD().sync();
        }
    }

    // Avoid depending on a platform-specific java.lang.String helper in the
    // instrumentation process; the storage boundary itself is what is under test.
    private static String repeatAscii(char value, int count) {
        char[] characters = new char[count];
        Arrays.fill(characters, value);
        return new String(characters);
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        if (!file.delete() && file.exists()) {
            throw new AssertionError("Unable to clean isolated durable-store test data");
        }
    }
}
