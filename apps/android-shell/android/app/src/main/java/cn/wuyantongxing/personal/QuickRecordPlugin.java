package cn.wuyantongxing.personal;

import android.app.StatusBarManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;

@CapacitorPlugin(name = "QuickRecord")
public final class QuickRecordPlugin extends Plugin {
    private static WeakReference<QuickRecordPlugin> active = new WeakReference<>(null);

    @Override
    public void load() {
        synchronized (QuickRecordPlugin.class) {
            active = new WeakReference<>(this);
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (QuickRecordPlugin.class) {
            if (active.get() == this) active.clear();
        }
    }

    static void notifyRecordCommitted(ExternalQuickRecordStore.Result result) {
        if (result == null || result.status != ExternalQuickRecordStore.Status.RECORDED) return;
        QuickRecordPlugin plugin;
        synchronized (QuickRecordPlugin.class) {
            plugin = active.get();
        }
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("id", result.id);
        data.put("smokedAt", result.smokedAt);
        plugin.notifyListeners("recordCommitted", data, true);
    }

    @PluginMethod
    public void requestPinWidget(PluginCall call) {
        boolean supported = false;
        boolean requested = false;
        try {
            Context context = getContext();
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            supported = manager.isRequestPinAppWidgetSupported();
            if (supported) {
                ComponentName provider = new ComponentName(context, QuickRecordWidgetProvider.class);
                requested = manager.requestPinAppWidget(provider, null, null);
            }
        } catch (RuntimeException ignored) {
            supported = false;
            requested = false;
        }
        JSObject result = new JSObject();
        result.put("supported", supported);
        result.put("requested", requested);
        call.resolve(result);
    }

    @PluginMethod
    public void requestAddTile(PluginCall call) {
        try {
            Context context = getContext();
            StatusBarManager statusBarManager = context.getSystemService(StatusBarManager.class);
            if (statusBarManager == null || getActivity() == null) {
                resolveTileUnavailable(call);
                return;
            }
            ComponentName service = new ComponentName(context, QuickRecordTileService.class);
            statusBarManager.requestAddTileService(
                service,
                context.getString(R.string.quick_record_tile_label),
                Icon.createWithResource(context, R.drawable.ic_quick_record),
                context.getMainExecutor(),
                code -> {
                    JSObject result = new JSObject();
                    result.put("result", tileResult(code));
                    call.resolve(result);
                }
            );
        } catch (RuntimeException ignored) {
            resolveTileUnavailable(call);
        }
    }

    private static void resolveTileUnavailable(PluginCall call) {
        JSObject unavailable = new JSObject();
        unavailable.put("result", "unavailable");
        call.resolve(unavailable);
    }

    private static String tileResult(int code) {
        if (code == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED) return "added";
        if (code == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED) return "already-added";
        if (code == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED) return "not-added";
        return "unavailable";
    }
}
