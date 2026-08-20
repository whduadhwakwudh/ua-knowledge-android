package io.ua.knowledgebase;

import static org.junit.Assert.assertEquals;

import android.view.WindowManager;

import org.junit.Test;

public class DisplayEdgePolicyTest {

    @Test
    public void cutoutCapableAndroidVersionsAlwaysUseACutoutDrawingMode() {
        assertEquals(
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
                DisplayEdgePolicy.cutoutModeForApi(28));
        assertEquals(
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
                DisplayEdgePolicy.cutoutModeForApi(29));
        assertEquals(
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS,
                DisplayEdgePolicy.cutoutModeForApi(30));
        assertEquals(
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS,
                DisplayEdgePolicy.cutoutModeForApi(36));
    }

    @Test
    public void preCutoutAndroidKeepsTheDefaultMode() {
        assertEquals(
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT,
                DisplayEdgePolicy.cutoutModeForApi(27));
    }
}
