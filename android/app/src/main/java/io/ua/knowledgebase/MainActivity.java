package io.ua.knowledgebase;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin registration must happen before the bridge is created.
        registerPlugin(UaFileHashPlugin.class);
        registerPlugin(UaFileStorePlugin.class);
        super.onCreate(savedInstanceState);
        // WebView 级缩放保持关闭（zoomEnabled=false）：阅读页缩放由
        // 页面内双指手势（--read-scale 正文字号缩放）实现，避免手势冲突。
        applyImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 每次窗口获得焦点（含旋转、从系统 UI 返回）都重新应用沉浸式，
        // 否则系统状态栏会在交互后重新出现。
        if (hasFocus) {
            applyImmersiveMode();
        }
    }

    /**
     * 隐藏系统状态栏（时间/蓝牙/WiFi 图标区域）实现沉浸式阅读：
     * - 内容延伸到状态栏区域，消除顶部白边；
     * - BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE：从顶部下滑临时显示
     *   通知栏，数秒后自动隐藏——用户想看时间时下滑即可，不影响沉浸感。
     * 仅隐藏状态栏；底部导航栏（手势条）保留，避免影响系统导航习惯。
     */
    private void applyImmersiveMode() {
        // Hiding the status bar alone is insufficient on phones with a notch
        // or punch-hole camera. The default cutout policy may letterbox the
        // entire Activity at the camera's horizontal line, leaving a solid
        // strip in both portrait and landscape. Explicitly let the window
        // paint behind that physical area; CSS safe-area insets still keep
        // interactive content clear of the camera itself.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode =
                    DisplayEdgePolicy.cutoutModeForApi(Build.VERSION.SDK_INT);
            getWindow().setAttributes(attributes);
        }

        // Apply edge-to-edge on every supported Android version. Previously
        // this ran only on Android 11+, so Android 9/10 could still reserve
        // the cutout/status-bar region even though FULLSCREEN was requested.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // Android 10-：旧 API，需要 IMMERSIVE_STICKY 标志。
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            return;
        }
        // Android 11+：WindowInsetsControllerCompat 是推荐方式。
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller == null) {
            return;
        }
        controller.hide(WindowInsetsCompat.Type.statusBars());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
