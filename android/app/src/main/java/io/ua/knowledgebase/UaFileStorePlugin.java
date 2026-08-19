package io.ua.knowledgebase;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Local Capacitor plugin: move a downloaded file into the public Downloads
 * directory and post system notifications.
 *
 * Registered as {@code UaFileStore}; the JS side calls:
 * <ul>
 *   <li>{@code Capacitor.Plugins.UaFileStore.moveToDownloads({ path, fileName, mimeType })}
 *       — moves the app-private file at {@code path} into the system public
 *       Downloads folder and returns its public {@code uri};</li>
 *   <li>{@code Capacitor.Plugins.UaFileStore.notify({ title, body })}
 *       — posts a system notification (creates the channel on first use).</li>
 * </ul>
 *
 * Storage strategy:
 * <ul>
 *   <li>API 29+: {@link MediaStore.Downloads} (scoped storage) — no permission
 *       needed for writing our own file into Downloads.</li>
 *   <li>API 24–28: {@code WRITE_EXTERNAL_STORAGE} runtime permission +
 *       {@code Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)}.</li>
 * </ul>
 *
 * Notifications require {@code POST_NOTIFICATIONS} on API 33+; the permission
 * is requested on demand via {@link #requestPermissionForAlias}.
 *
 * Security rules:
 * - the source file is only ever read from the app-private directory the
 *   downloader wrote it to (resolved via {@link #resolveFile});
 * - the destination file name is passed by the JS layer after sanitization
 *   (no path separators possible);
 * - this plugin NEVER logs paths or file content, and rejects with generic
 *   messages only.
 */
@CapacitorPlugin(
    name = "UaFileStore",
    permissions = {
        @Permission(strings = {Manifest.permission.WRITE_EXTERNAL_STORAGE}, alias = "storage"),
        @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")
    })
public class UaFileStorePlugin extends Plugin {

    private static final String CHANNEL_ID = "ua_downloads";
    private static final int BUFFER_SIZE_BYTES = 64 * 1024;

    /* ─── moveToDownloads ─────────────────────────────────────────────── */

    @PluginMethod
    public void moveToDownloads(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "movePermissionCallback");
            return;
        }
        doMove(call);
    }

    @PermissionCallback
    private void movePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("storage permission denied", "PERMISSION_DENIED");
            return;
        }
        doMove(call);
    }

    private void doMove(PluginCall call) {
        String path = call.getString("path");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType");
        if (path == null || path.isEmpty() || fileName == null || fileName.isEmpty()) {
            call.reject("path and fileName are required");
            return;
        }
        File source = resolveFile(path);
        if (source == null || !source.isFile()) {
            call.reject("source file not found");
            return;
        }

        try {
            String uri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? moveViaMediaStore(source, fileName, mimeType)
                    : moveToLegacyPublicDir(source, fileName);
            call.resolve(new JSObject().put("uri", uri));
        } catch (IOException e) {
            call.reject("move failed");
        }
    }

    /** API 29+ scoped-storage path: insert into MediaStore.Downloads, stream, publish. */
    private String moveViaMediaStore(File source, String fileName, String mimeType) throws IOException {
        Context context = getContext();
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
        if (mimeType != null && !mimeType.isEmpty()) {
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        }
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) {
            throw new IOException("media store insert failed");
        }
        try {
            try (OutputStream out = resolver.openOutputStream(item);
                 InputStream in = new FileInputStream(source)) {
                if (out == null) {
                    throw new IOException("cannot open output stream");
                }
                copyStream(in, out);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(item, values, null, null);
        } catch (IOException e) {
            resolver.delete(item, null, null);
            throw e;
        }
        deleteQuietly(source);
        return item.toString();
    }

    /** API 24–28: direct write to /storage/emulated/0/Download (permission granted). */
    private String moveToLegacyPublicDir(File source, String fileName) throws IOException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) {
            throw new IOException("no external storage");
        }
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("cannot create downloads dir");
        }
        File target = new File(dir, fileName);
        try (InputStream in = new FileInputStream(source);
             OutputStream out = new FileOutputStream(target)) {
            copyStream(in, out);
        }
        deleteQuietly(source);
        return Uri.fromFile(target).toString();
    }

    /* ─── notify ──────────────────────────────────────────────────────── */

    @PluginMethod
    public void notify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notifyPermissionCallback");
            return;
        }
        doNotify(call);
    }

    @PermissionCallback
    private void notifyPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("notification permission denied", "PERMISSION_DENIED");
            return;
        }
        doNotify(call);
    }

    private void doNotify(PluginCall call) {
        String title = call.getString("title");
        String body = call.getString("body");
        Context context = getContext();

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.reject("notification service unavailable");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "下载通知",
                    NotificationManager.IMPORTANCE_DEFAULT);
            manager.createNotificationChannel(channel);
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title != null ? title : "下载")
                .setContentText(body != null ? body : "")
                .setAutoCancel(true);
        manager.notify((int) System.currentTimeMillis(), builder.build());
        call.resolve();
    }

    /* ─── helpers ─────────────────────────────────────────────────────── */

    /** Accepts an absolute path or a file:// URI; returns null on malformed input. */
    private static File resolveFile(String path) {
        if (path.startsWith("file://")) {
            try {
                return new File(Uri.parse(path).getPath());
            } catch (Exception e) {
                return null;
            }
        }
        return new File(path);
    }

    private static void copyStream(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE_BYTES];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }

    private static void deleteQuietly(File file) {
        try {
            if (file != null && file.exists() && !file.delete()) {
                // Best-effort cleanup only; the move itself already succeeded.
            }
        } catch (Exception ignored) {
            // Best-effort cleanup only.
        }
    }
}
