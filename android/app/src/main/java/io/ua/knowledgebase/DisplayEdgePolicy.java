package io.ua.knowledgebase;

import android.view.WindowManager;

final class DisplayEdgePolicy {

    private DisplayEdgePolicy() {}

    static int cutoutModeForApi(int sdkInt) {
        if (sdkInt >= 30) {
            return WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        }
        if (sdkInt >= 28) {
            return WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        return WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
    }
}
