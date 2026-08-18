package io.ua.knowledgebase;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin registration must happen before the bridge is created.
        registerPlugin(UaFileHashPlugin.class);
        super.onCreate(savedInstanceState);
        // WebView 级缩放保持关闭（zoomEnabled=false）：阅读页缩放由
        // 页面内双指手势（--read-scale 正文字号缩放）实现，避免手势冲突。
    }
}
