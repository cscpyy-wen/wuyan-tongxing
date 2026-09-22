package cn.wuyantongxing.personal;

import android.content.ComponentName;
import android.content.Context;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.widget.Toast;

public final class QuickRecordTileService extends TileService {
    private boolean recording;

    @Override
    public void onStartListening() {
        super.onStartListening();
        setTile(Tile.STATE_ACTIVE, getString(R.string.quick_record_tile_label), getString(R.string.quick_record_tile_hint));
    }

    @Override
    public void onClick() {
        super.onClick();
        if (recording) return;
        recording = true;
        setTile(Tile.STATE_UNAVAILABLE, getString(R.string.quick_record_tile_label), getString(R.string.quick_record_in_progress));
        QuickRecordExecutor.submit(
            this,
            ExternalQuickRecordStore.EntryPoint.QUICK_SETTINGS_TILE,
            result -> {
                recording = false;
                String message = QuickRecordExecutor.message(this, result);
                setTile(Tile.STATE_ACTIVE, getString(R.string.quick_record_tile_label), message);
                QuickRecordWidgetUpdater.refresh(this, null);
                Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
            }
        );
    }

    static void refresh(Context context) {
        TileService.requestListeningState(
            context,
            new ComponentName(context, QuickRecordTileService.class)
        );
    }

    private void setTile(int state, String label, String subtitle) {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setState(state);
        tile.setLabel(label);
        tile.setSubtitle(subtitle);
        tile.setContentDescription(label + "，" + subtitle);
        tile.updateTile();
    }
}
