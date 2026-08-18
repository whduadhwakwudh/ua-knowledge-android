package io.ua.knowledgebase;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin registration must happen before the bridge is created.
        registerPlugin(UaFileHashPlugin.class);
        super.onCreate(savedInstanceState);
        // 双指缩放：显式开启 supportZoom + builtInZoomControls（缩放范围由
        // viewport meta 的 minimum-scale/maximum-scale 控制，放大缩小双向生效）。
        // Capacitor 的 zoomEnabled 只设置 builtInZoomControls；显式再设一次
        // 保证部分 WebView 版本上缩小手势可用。
        if (bridge != null && bridge.getWebView() != null) {
            WebSettings settings = bridge.getWebView().getSettings();
            settings.setSupportZoom(true);
            settings.setBuiltInZoomControls(true);
            settings.setDisplayZoomControls(false);
        }
    }
}
