package com.aeronav.gcs;

import android.app.Activity;
import android.content.Intent;
import android.content.Context;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    static final String TAG = "AeroNavGCS";

    WebView  webView;
    DatagramSocket udpSocket;
    WifiManager.MulticastLock multicastLock;

    volatile String  fcIp      = "192.168.4.1";
    volatile int     recvPort  = 14550;
    volatile int     sendPort  = 14555;   // FC listens on 14555, GCS sends here
    volatile boolean udpActive = false;
    volatile boolean pageReady = false;

    final ExecutorService exec = Executors.newCachedThreadPool();

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Full-screen immersive
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_FULLSCREEN        |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION   |
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE     |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setBuiltInZoomControls(false);
        ws.setSupportZoom(false);

        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new Bridge(), "Android");

        // Notify JS once page is fully loaded, then start heartbeat loop
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                Log.d(TAG, "Page ready, notifying JS");
                jsCall("window.onGCSReady&&window.onGCSReady('"
                    + fcIp + "'," + recvPort + "," + sendPort + "," + udpActive + ")");
            }
        });

        webView.loadUrl("file:///android_asset/gcs.html");

        // Multicast lock — required to receive broadcast UDP on Android
        WifiManager wm = (WifiManager) getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
        multicastLock = wm.createMulticastLock("aeronav_gcs");
        multicastLock.setReferenceCounted(true);
        multicastLock.acquire();

        startUdp();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopUdp();
        exec.shutdownNow();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    // ── UDP receive loop ──────────────────────────────────────────────────────

    void startUdp() {
        stopUdp();
        udpActive = true;

        exec.submit(() -> {
            try {
                DatagramSocket s = new DatagramSocket(null);
                s.setReuseAddress(true);
                s.setBroadcast(true);
                s.bind(new InetSocketAddress(recvPort));
                udpSocket = s;
                Log.d(TAG, "UDP socket bound on port " + recvPort);

                if (pageReady) {
                    jsCall("window.onUdpStatus&&window.onUdpStatus(true,'"
                        + fcIp + "'," + recvPort + "," + sendPort + ")");
                }

                byte[] buf = new byte[1024];
                boolean peerDetected = false;
                while (udpActive) {
                    DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                    s.receive(pkt);
                    // Auto-detect FC IP and port from first received packet
                    if (!peerDetected) {
                        peerDetected = true;
                        String srcIp = pkt.getAddress().getHostAddress();
                        int srcPort = pkt.getPort();
                        Log.d(TAG, "Auto-detected FC at " + srcIp + ":" + srcPort);
                        fcIp = srcIp;
                        sendPort = srcPort;
                        jsCall("window.onUdpStatus&&window.onUdpStatus(true,'"
                            + fcIp + "'," + recvPort + "," + sendPort + ")");
                    }
                    Log.d(TAG, "UDP rx " + pkt.getLength() + "b from " + pkt.getAddress());
                    String b64 = Base64.encodeToString(
                            pkt.getData(), 0, pkt.getLength(), Base64.NO_WRAP);
                    jsCall("window.onUdpData&&window.onUdpData('" + b64 + "')");
                }
            } catch (Exception e) {
                if (!udpActive) return; // intentional stop via stopUdp()
                Log.e(TAG, "UDP error: " + e.getMessage());
                udpActive = false;
                jsCall("window.onUdpStatus&&window.onUdpStatus(false,'',0,0)");
                // Auto-retry after 3 s so a brief network drop self-heals
                try { Thread.sleep(3000); } catch (InterruptedException ie) { return; }
                if (pageReady) runOnUiThread(this::startUdp);
            }
        });
    }

    void stopUdp() {
        udpActive = false;
        DatagramSocket s = udpSocket;
        udpSocket = null;
        if (s != null && !s.isClosed()) s.close();
    }

    void jsCall(final String js) {
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    // ── Send helpers ──────────────────────────────────────────────────────────

    void udpSend(byte[] data, String host, int port) {
        try {
            DatagramSocket s = udpSocket;
            if (s == null || s.isClosed()) return;
            DatagramPacket pkt = new DatagramPacket(
                    data, data.length, InetAddress.getByName(host), port);
            s.send(pkt);
            Log.d(TAG, "UDP tx " + data.length + "b → " + host + ":" + port);
        } catch (Exception e) {
            Log.e(TAG, "UDP send error: " + e.getMessage());
        }
    }

    // ── JavaScript bridge ─────────────────────────────────────────────────────

    class Bridge {

        /** Send MAVLink frame to configured FC IP */
        @JavascriptInterface
        public void sendBytes(String b64) {
            exec.submit(() -> {
                byte[] data = Base64.decode(b64, Base64.NO_WRAP);
                udpSend(data, fcIp, sendPort);
            });
        }

        /** Send MAVLink frame to 255.255.255.255 (for heartbeats / discovery) */
        @JavascriptInterface
        public void sendBroadcast(String b64) {
            exec.submit(() -> {
                byte[] data = Base64.decode(b64, Base64.NO_WRAP);
                udpSend(data, "255.255.255.255", sendPort);
                udpSend(data, fcIp, sendPort);   // also unicast to configured IP
            });
        }

        /** Reconfigure and restart UDP */
        @JavascriptInterface
        public void setConfig(String ip, int recv, int send) {
            fcIp     = ip;
            recvPort = recv;
            sendPort = send;
            startUdp();
        }

        /** Return current config as "ip,recv,send" */
        @JavascriptInterface
        public String getConfig() {
            return fcIp + "," + recvPort + "," + sendPort;
        }

        /** Open coordinates in the device's default maps app */
        @JavascriptInterface
        public void openMaps(double lat, double lon) {
            runOnUiThread(() -> {
                Uri geoUri = Uri.parse("geo:" + lat + "," + lon + "?q=" + lat + "," + lon);
                Intent intent = new Intent(Intent.ACTION_VIEW, geoUri);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { startActivity(intent); }
                catch (Exception e) { Log.e(TAG, "openMaps failed: " + e.getMessage()); }
            });
        }
    }
}
