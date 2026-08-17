package io.ua.knowledgebase;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Local Capacitor plugin: SHA-256 of an on-device file.
 *
 * Registered as {@code UaFileHash}; the JS side calls
 * {@code Capacitor.Plugins.UaFileHash.hashFile({ path })} where path is the
 * absolute path or file:// URI returned by Filesystem.getUri().
 *
 * Security rules:
 * - 64 KiB streaming chunks; the file content never enters memory as a whole;
 * - the returned digest is lowercase hex;
 * - this plugin NEVER logs the path, the content or any part of the file, and
 *   rejects with generic messages only.
 */
@CapacitorPlugin(name = "UaFileHash")
public class UaFileHashPlugin extends Plugin {

    private static final int CHUNK_SIZE_BYTES = 64 * 1024;

    @PluginMethod
    public void hashFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }

        File file = resolveFile(path);
        if (file == null) {
            call.reject("invalid path");
            return;
        }
        if (!file.isFile()) {
            call.reject("file not found");
            return;
        }

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[CHUNK_SIZE_BYTES];
            try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    digest.update(buffer, 0, read);
                }
            }
            call.resolve(new JSObject().put("sha256", toLowercaseHex(digest.digest())));
        } catch (NoSuchAlgorithmException | IOException e) {
            call.reject("hashing failed");
        }
    }

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

    private static String toLowercaseHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}