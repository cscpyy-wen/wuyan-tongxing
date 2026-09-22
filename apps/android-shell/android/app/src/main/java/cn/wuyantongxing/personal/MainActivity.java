package cn.wuyantongxing.personal;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    private static final String DURABLE_STORE_INTERFACE = "WuyanDurableStore";
    private static final long SPLASH_FAIL_OPEN_MS = 5_000L;
    private static final long WEB_READY_POLL_MS = 100L;
    private static final long WEB_READY_SETTLE_MS = 80L;
    private final AtomicBoolean nativeOverlayReady = new AtomicBoolean(false);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView appWebView;
    private View launchOverlay;
    private LaunchOverlayReleaseWatchdog launchOverlayWatchdog;
    private long splashDeadline;
    private boolean splashReleaseScheduled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        splashScreen.setKeepOnScreenCondition(() -> !nativeOverlayReady.get());
        splashScreen.setOnExitAnimationListener(provider -> provider.remove());
        registerPlugin(PersonalExportPlugin.class);
        registerPlugin(QuickRecordPlugin.class);
        // Capacitor also reads this from capacitor.config.json. Enforce it at
        // runtime as defense in depth so a generated-config regression cannot
        // expose personal health state through WebView DevTools on user builds.
        WebView.setWebContentsDebuggingEnabled(false);
        super.onCreate(savedInstanceState);

        installLaunchOverlay();
        launchOverlayWatchdog = new LaunchOverlayReleaseWatchdog(
            new LaunchOverlayReleaseWatchdog.Scheduler() {
                @Override
                public void postDelayed(Runnable action, long delayMillis) {
                    mainHandler.postDelayed(action, delayMillis);
                }

                @Override
                public void removeCallbacks(Runnable action) {
                    mainHandler.removeCallbacks(action);
                }
            },
            this::removeLaunchOverlayImmediately,
            SPLASH_FAIL_OPEN_MS
        );
        launchOverlayWatchdog.arm();
        nativeOverlayReady.set(true);
        splashDeadline = SystemClock.uptimeMillis() + SPLASH_FAIL_OPEN_MS;
        appWebView = getBridge().getWebView();
        mainHandler.post(this::probeWebContentReady);
    }

    @Override
    protected void load() {
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        if (webView == null) {
            throw new IllegalStateException("WUYAN_DURABLE_STORE_WEBVIEW_UNAVAILABLE");
        }

        /*
         * SECURITY BOUNDARY: addJavascriptInterface exposes annotated methods to every frame in
         * this WebView. It is safe here only because this APK loads trusted bundled content at its
         * Capacitor local origin, declares no INTERNET permission, and allows no remote navigation.
         * The bridge additionally accepts only nine fixed keys mapped to app-private filenames.
         * If untrusted or remote content is ever allowed, this interface must be removed or isolated
         * behind an origin-authenticated messaging design before that content can load.
         */
        webView.addJavascriptInterface(
            new WuyanDurableStore(getApplicationContext()),
            DURABLE_STORE_INTERFACE
        );
        appWebView = webView;

        // BridgeActivity.load() creates the Capacitor bridge and immediately calls loadUrl().
        // Installing above therefore guarantees availability before the first page script runs.
        super.load();
    }

    private void installLaunchOverlay() {
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(ContextCompat.getColor(this, R.color.splashBackground));
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_launcher_foreground);
        icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        int iconSize = Math.round(160 * getResources().getDisplayMetrics().density);
        FrameLayout.LayoutParams iconLayout = new FrameLayout.LayoutParams(iconSize, iconSize);
        iconLayout.gravity = Gravity.CENTER;
        overlay.addView(icon, iconLayout);
        addContentView(
            overlay,
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        launchOverlay = overlay;
    }

    private void removeLaunchOverlay() {
        if (launchOverlayWatchdog != null) {
            launchOverlayWatchdog.release();
            return;
        }
        removeLaunchOverlayImmediately();
    }

    private void removeLaunchOverlayImmediately() {
        if (launchOverlay == null) return;
        ViewGroup parent = (ViewGroup) launchOverlay.getParent();
        if (parent != null) parent.removeView(launchOverlay);
        launchOverlay = null;
    }

    private void probeWebContentReady() {
        if (launchOverlay == null) return;
        if (appWebView == null || isFinishing() || isDestroyed()) {
            removeLaunchOverlay();
            return;
        }
        if (SystemClock.uptimeMillis() >= splashDeadline) {
            removeLaunchOverlay();
            return;
        }
        try {
            appWebView.evaluateJavascript(
                "Boolean(document.body && document.body.innerText.trim().length > 0)",
                result -> {
                    if (launchOverlay == null) return;
                    if ("true".equals(result)) {
                        if (!splashReleaseScheduled) {
                            splashReleaseScheduled = true;
                            mainHandler.postDelayed(
                                this::removeLaunchOverlay,
                                WEB_READY_SETTLE_MS
                            );
                        }
                    } else {
                        mainHandler.postDelayed(this::probeWebContentReady, WEB_READY_POLL_MS);
                    }
                }
            );
        } catch (RuntimeException error) {
            // Renderer/WebView failures must never leave the native launch overlay permanent.
            removeLaunchOverlay();
        }
    }

    @Override
    public void onDestroy() {
        nativeOverlayReady.set(true);
        removeLaunchOverlay();
        mainHandler.removeCallbacksAndMessages(null);
        if (appWebView != null) {
            appWebView.removeJavascriptInterface(DURABLE_STORE_INTERFACE);
        }
        launchOverlayWatchdog = null;
        appWebView = null;
        super.onDestroy();
    }
}
