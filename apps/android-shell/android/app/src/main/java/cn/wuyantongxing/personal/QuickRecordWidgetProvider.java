package cn.wuyantongxing.personal;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver.PendingResult;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

public final class QuickRecordWidgetProvider extends AppWidgetProvider {
    static final String ACTION_RECORD =
        "cn.wuyantongxing.personal.action.RECORD_CIGARETTE_FROM_WIDGET";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        QuickRecordWidgetUpdater.refresh(context, null);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!ACTION_RECORD.equals(action)) {
            if (AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action)
                || AppWidgetManager.ACTION_APPWIDGET_OPTIONS_CHANGED.equals(action)
                || QuickRecordWidgetUpdater.ACTION_REFRESH.equals(action)
                || Intent.ACTION_DATE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_LOCALE_CHANGED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
                PendingResult pending = goAsync();
                QuickRecordWidgetUpdater.refresh(context, pending::finish);
            } else {
                super.onReceive(context, intent);
            }
            return;
        }
        PendingResult pendingResult = goAsync();
        QuickRecordExecutor.submit(
            context,
            ExternalQuickRecordStore.EntryPoint.APP_WIDGET,
            result -> {
                try {
                    if (result.status != ExternalQuickRecordStore.Status.RECORDED) {
                        Toast.makeText(context, QuickRecordExecutor.message(context, result), Toast.LENGTH_SHORT).show();
                    }
                    QuickRecordTileService.refresh(context);
                } finally {
                    QuickRecordWidgetUpdater.refresh(context, pendingResult::finish);
                }
            }
        );
    }

    @Override
    public void onDisabled(Context context) {
        QuickRecordWidgetUpdater.cancelMidnightRefresh(context);
    }
}
