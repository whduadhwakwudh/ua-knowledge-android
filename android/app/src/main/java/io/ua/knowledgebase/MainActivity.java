package io.ua.knowledgebase;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin registration must happen before the bridge is created.
        registerPlugin(UaFileHashPlugin.class);
        super.onCreate(savedInstanceState);
    }
}