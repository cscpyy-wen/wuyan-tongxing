package cn.wuyantongxing.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AppSecurityInstrumentedTest {
    private static final String PACKAGE_NAME = "cn.wuyantongxing.personal.debug";

    private static String readUtf8(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    @Test
    public void packageAndBackupPolicyAreCorrect() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(PACKAGE_NAME, context.getPackageName());
        ApplicationInfo info = context.getPackageManager().getApplicationInfo(PACKAGE_NAME, 0);
        assertFalse((info.flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0);
    }

    @Test
    public void manifestUsesOnlyExpectedNotificationPermissions() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo info = context.getPackageManager().getPackageInfo(PACKAGE_NAME, PackageManager.GET_PERMISSIONS);
        Set<String> permissions = info.requestedPermissions == null
            ? Collections.emptySet()
            : new HashSet<>(Arrays.asList(info.requestedPermissions));

        assertTrue(permissions.contains("android.permission.POST_NOTIFICATIONS"));
        assertTrue(permissions.contains("android.permission.RECEIVE_BOOT_COMPLETED"));
        assertTrue(permissions.contains("android.permission.WAKE_LOCK"));
        assertFalse(permissions.contains("android.permission.SCHEDULE_EXACT_ALARM"));
        assertFalse(permissions.contains("android.permission.USE_EXACT_ALARM"));
        assertFalse(permissions.contains("android.permission.INTERNET"));
        assertFalse(permissions.contains("android.permission.ACCESS_FINE_LOCATION"));
        assertFalse(permissions.contains("android.permission.RECORD_AUDIO"));
        assertFalse(permissions.contains("android.permission.READ_CONTACTS"));
    }

    @Test
    public void packagedWebAppIsLocalAndReadable() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (InputStream input = context.getAssets().open("public/index.html")) {
            String html = readUtf8(input);
            assertTrue(html.contains("<div id=\"app\"></div>"));
            assertTrue(html.contains("id=\"wuyan-android-bootstrap\""));
            assertTrue(html.contains("data-wuyan-android-bootstrap"));
            assertTrue(html.contains("href=\"#/pages/sos/index\""));
            assertTrue(html.contains("正在读取本机记录"));
            assertTrue(
                html.indexOf("id=\"wuyan-android-bootstrap\"")
                    < html.indexOf("<div id=\"app\"></div>")
            );
            assertFalse(html.contains("chatgpt.site"));
        }
    }

    @Test
    public void packagedRuntimeConfigurationDisablesWebViewDebugging() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (InputStream input = context.getAssets().open("capacitor.config.json")) {
            String config = readUtf8(input);
            assertTrue(config.contains("\"webContentsDebuggingEnabled\": false"));
            assertTrue(config.contains("\"allowMixedContent\": false"));
            assertTrue(config.contains("\"cleartext\": false"));
        }
    }
}
