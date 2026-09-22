package cn.wuyantongxing.personal;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Serializes all user-triggered shortcut writes and returns results on main. */
final class QuickRecordExecutor {
    interface Callback {
        void onComplete(ExternalQuickRecordStore.Result result);
    }

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "wuyan-quick-record");
        thread.setDaemon(true);
        return thread;
    });
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private QuickRecordExecutor() {}

    static void submit(
        Context context,
        ExternalQuickRecordStore.EntryPoint entryPoint,
        Callback callback
    ) {
        Context applicationContext = context.getApplicationContext();
        try {
            EXECUTOR.execute(() -> {
                ExternalQuickRecordStore.Result result;
                try {
                    result = new ExternalQuickRecordStore(
                        new WuyanDurableStore(applicationContext)
                    ).recordNow(entryPoint);
                } catch (RuntimeException error) {
                    result = ExternalQuickRecordStore.Result.failure(
                        ExternalQuickRecordStore.Status.STORAGE_ERROR
                    );
                }
                deliver(callback, result);
            });
        } catch (RuntimeException error) {
            deliver(
                callback,
                ExternalQuickRecordStore.Result.failure(
                    ExternalQuickRecordStore.Status.STORAGE_ERROR
                )
            );
        }
    }

    private static void deliver(Callback callback, ExternalQuickRecordStore.Result result) {
        Runnable delivery = () -> {
            QuickRecordPlugin.notifyRecordCommitted(result);
            callback.onComplete(result);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            delivery.run();
        } else {
            MAIN.post(delivery);
        }
    }

    static String message(Context context, ExternalQuickRecordStore.Result result) {
        switch (result.status) {
            case RECORDED:
                return context.getString(R.string.quick_record_success);
            case APP_NOT_READY:
                return context.getString(R.string.quick_record_open_app_first);
            case TEMPORARILY_BLOCKED:
                return context.getString(R.string.quick_record_temporarily_blocked);
            case QUEUE_FULL:
                return context.getString(R.string.quick_record_queue_full);
            case STORAGE_ERROR:
            default:
                return context.getString(R.string.quick_record_failed);
        }
    }
}
