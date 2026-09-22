package cn.wuyantongxing.personal;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Reads committed data off the UI thread; the launcher runs the live timer itself. */
final class QuickRecordWidgetUpdater {
    static final String ACTION_REFRESH = "cn.wuyantongxing.personal.action.REFRESH_RECORD_WIDGET";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "wuyan-widget-refresh");
        thread.setDaemon(true);
        return thread;
    });
    private static Runnable pendingRefresh;

    private QuickRecordWidgetUpdater() {}

    /** Collapse primary/LKG/queue commits into one redraw, without delaying the data write. */
    static void schedule(Context context) {
        if (context == null) return;
        Context application = context.getApplicationContext();
        synchronized (QuickRecordWidgetUpdater.class) {
            if (pendingRefresh != null) MAIN.removeCallbacks(pendingRefresh);
            pendingRefresh = () -> refresh(application, null);
            MAIN.postDelayed(pendingRefresh, 80);
        }
    }

    static void refresh(Context context, Runnable completion) {
        Context application = context.getApplicationContext();
        WORKER.execute(() -> {
            try {
                updateNow(application);
            } catch (RuntimeException ignored) {
                // A removed widget/launcher restart must not turn a committed record into failure.
            } finally {
                if (completion != null) MAIN.post(completion);
            }
        });
    }

    private static void updateNow(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, QuickRecordWidgetProvider.class));
        if (ids.length == 0) {
            cancelMidnightRefresh(context);
            return;
        }
        long now = System.currentTimeMillis();
        ExternalQuickRecordStore.WidgetSnapshot snapshot;
        try {
            snapshot = new ExternalQuickRecordStore(new WuyanDurableStore(context)).widgetSnapshot(now);
        } catch (RuntimeException error) {
            snapshot = ExternalQuickRecordStore.WidgetSnapshot.unavailable();
        }
        RemoteViews views = views(context, snapshot, now, SystemClock.elapsedRealtime());
        manager.updateAppWidget(ids, views);
        scheduleMidnightRefresh(context, now);
    }

    static RemoteViews views(
        Context context, ExternalQuickRecordStore.WidgetSnapshot snapshot, long now, long uptime
    ) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.quick_record_widget);
        views.setTextViewText(R.id.quick_record_widget_count,
            snapshot.available ? Integer.toString(snapshot.todayCount) : "—");
        boolean timed = snapshot.available && snapshot.lastSmokedAtMillis != null;
        views.setViewVisibility(R.id.quick_record_widget_timer, timed ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.quick_record_widget_empty_timer, timed ? View.GONE : View.VISIBLE);
        views.setChronometer(R.id.quick_record_widget_timer,
            timed ? chronometerBase(now, uptime, snapshot.lastSmokedAtMillis) : uptime, null, timed);
        views.setContentDescription(R.id.quick_record_widget_root,
            snapshot.available
                ? context.getString(R.string.quick_record_widget_accessibility, snapshot.todayCount)
                : context.getString(R.string.quick_record_open_app_first));
        views.setOnClickPendingIntent(R.id.quick_record_widget_root, PendingIntent.getBroadcast(
            context, 4101,
            new Intent(context, QuickRecordWidgetProvider.class)
                .setAction(QuickRecordWidgetProvider.ACTION_RECORD)
                .setPackage(context.getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        ));
        return views;
    }

    static long chronometerBase(long now, long uptime, long smokedAt) {
        // Negative bases are intentional when the last cigarette predates the current boot.
        return uptime - Math.max(0, now - smokedAt);
    }

    static long nextMidnight(long now) {
        return Instant.ofEpochMilli(now).atOffset(ZoneOffset.ofHours(8)).toLocalDate()
            .plusDays(1).atStartOfDay().toInstant(ZoneOffset.ofHours(8)).toEpochMilli();
    }

    private static PendingIntent refreshIntent(Context context) {
        return PendingIntent.getBroadcast(context, 4102,
            new Intent(context, QuickRecordWidgetProvider.class).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void scheduleMidnightRefresh(Context context, long now) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms != null) {
            // No exact-alarm permission or wakeup; queued refresh runs when the device wakes.
            alarms.set(AlarmManager.RTC, nextMidnight(now), refreshIntent(context));
        }
    }

    static void cancelMidnightRefresh(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(refreshIntent(context));
    }
}
