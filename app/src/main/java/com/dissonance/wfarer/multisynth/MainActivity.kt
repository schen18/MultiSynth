package com.dissonance.wfarer.multisynth

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.content.pm.PackageManager
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.media.midi.MidiReceiver
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import com.dissonance.wfarer.multisynth.ui.theme.MyApplicationTheme

class MainActivity : ComponentActivity() {

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var midiManager: MidiManager? = null
    private val openDevices = mutableMapOf<MidiDeviceInfo, MidiDevice>()

    // The WebView created by THIS activity instance. The static activeWebView may
    // already point at the replacement activity's WebView while this instance is
    // still tearing down, so ownership must be tracked separately.
    private var ownWebView: WebView? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data: Intent? = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            val uris = if (data.data != null) {
                arrayOf(data.data!!)
            } else if (data.clipData != null) {
                val clipData = data.clipData!!
                Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
            } else {
                null
            }
            filePathCallback?.onReceiveValue(uris)
        } else {
            filePathCallback?.onReceiveValue(null)
        }
        filePathCallback = null
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Notification visibility is optional; the service runs regardless. */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        if (packageManager.hasSystemFeature(PackageManager.FEATURE_MIDI)) {
            val manager = getSystemService(Context.MIDI_SERVICE) as? MidiManager
            if (manager != null) {
                this.midiManager = manager
                setupMidiListening(manager)
            }
        }

        setContent {
            MyApplicationTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    SynthWebView(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(innerPadding),
                        onWebViewCreated = { wv -> ownWebView = wv },
                        onShowFileChooser = { callback, params ->
                            filePathCallback?.onReceiveValue(null)
                            filePathCallback = callback
                            try {
                                val intent = params.createIntent()
                                fileChooserLauncher.launch(intent)
                                true
                            } catch (e: Exception) {
                                filePathCallback = null
                                false
                            }
                        }
                    )
                }
            }
        }
    }

    // MidiManager.devices and registerDeviceCallback(Handler, ...) are deprecated
    // in API 33, but the only replacement (transport-filtered Executor variant)
    // reports a single transport per registration. The deprecated form delivers
    // every device on every transport, which is what this app needs.
    @Suppress("DEPRECATION")
    private fun setupMidiListening(manager: MidiManager) {
        for (deviceInfo in manager.devices) {
            connectToMidiDevice(manager, deviceInfo)
        }

        manager.registerDeviceCallback(object : MidiManager.DeviceCallback() {
            override fun onDeviceAdded(deviceInfo: MidiDeviceInfo) {
                connectToMidiDevice(manager, deviceInfo)
            }

            override fun onDeviceRemoved(deviceInfo: MidiDeviceInfo) {
                val device = openDevices.remove(deviceInfo)
                try {
                    device?.close()
                } catch (e: Exception) {
                    Log.e("MainActivity", "Error closing removed MIDI device", e)
                }
                // When a MIDI device/source is removed or quits abruptly, send All-Notes-Off / Panic to silence all channels
                sendAllNotesOff()
            }
        }, Handler(Looper.getMainLooper()))
    }

    private fun connectToMidiDevice(manager: MidiManager, deviceInfo: MidiDeviceInfo) {
        if (openDevices.containsKey(deviceInfo)) return

        val properties = deviceInfo.properties
        val name = properties.getString(MidiDeviceInfo.PROPERTY_NAME)
        val product = properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT)
        if (name?.contains("Virtual SoundFont Synth") == true || product?.contains("Virtual SoundFont Synth") == true) {
            return
        }

        manager.openDevice(deviceInfo, { device ->
            if (device != null) {
                openDevices[deviceInfo] = device
                val numOutputs = deviceInfo.outputPortCount
                for (portIndex in 0 until numOutputs) {
                    val outputPort = device.openOutputPort(portIndex)
                    if (outputPort != null) {
                        outputPort.connect(object : MidiReceiver() {
                            override fun onSend(msg: ByteArray?, offset: Int, count: Int, timestamp: Long) {
                                if (msg != null) {
                                    handleNativeMidi(msg, offset, count)
                                }
                            }

                            override fun onFlush() {
                                sendAllNotesOff()
                            }
                        })
                    }
                }
            }
        }, Handler(Looper.getMainLooper()))
    }

    override fun onDestroy() {
        // Global audio state must only be torn down when the app is truly finishing.
        // During a configuration-change recreation the NEW activity (and its WebView)
        // is already alive by the time this runs; stopping the service or destroying
        // the replacement WebView here would blank the app.
        if (isFinishing) {
            emergencyStopSynth()
            try {
                stopService(Intent(this, MidiSynthService::class.java))
            } catch (e: Exception) {
                Log.e("MainActivity", "Error stopping MidiSynthService in onDestroy", e)
            }
        }

        for (device in openDevices.values) {
            try {
                device.close()
            } catch (e: Exception) {
                Log.e("MainActivity", "Error closing MIDI device in onDestroy", e)
            }
        }
        openDevices.clear()

        // Destroy only the WebView this instance created — never the replacement's.
        val mine = ownWebView
        if (mine != null) {
            try {
                if (isFinishing) {
                    // pauseTimers()/onPause() affect ALL WebViews in the process,
                    // so they must never run during a recreation.
                    mine.onPause()
                    mine.pauseTimers()
                }
                mine.stopLoading()
                mine.destroy()
            } catch (e: Exception) {
                Log.e("MainActivity", "Error destroying WebView in onDestroy", e)
            }
            if (activeWebView === mine) {
                activeWebView = null
            }
            ownWebView = null
        }
        super.onDestroy()
    }

    companion object {
        @Volatile
        var activeWebView: WebView? = null

        // Pending native->JS MIDI bytes, coalesced into a single evaluateJavascript
        // call per main-loop pass. Guarded by midiBatchLock; may arrive from both
        // the main-thread handler and the virtual device service's binder threads.
        private val midiBatchLock = Any()
        private val pendingMidiBytes = StringBuilder()
        @Volatile
        private var midiFlushPosted = false

        fun handleNativeMidi(msg: ByteArray, offset: Int, count: Int) {
            val webView = activeWebView ?: return
            synchronized(midiBatchLock) {
                for (i in 0 until count) {
                    if (pendingMidiBytes.isNotEmpty()) pendingMidiBytes.append(',')
                    pendingMidiBytes.append(msg[offset + i].toInt() and 0xFF)
                }
            }
            if (midiFlushPosted) return
            midiFlushPosted = true
            webView.post {
                midiFlushPosted = false
                val jsArray = synchronized(midiBatchLock) {
                    if (pendingMidiBytes.isNotEmpty()) {
                        val s = "[" + pendingMidiBytes.toString() + "]"
                        pendingMidiBytes.setLength(0)
                        s
                    } else {
                        ""
                    }
                }
                if (jsArray.isEmpty()) return@post
                activeWebView?.let { wv ->
                    try {
                        wv.evaluateJavascript(
                            "if (window.receiveNativeMidiBytes) { window.receiveNativeMidiBytes($jsArray); }",
                            null
                        )
                    } catch (e: Exception) {
                        Log.w("MainActivity", "MIDI bridge dispatch failed", e)
                    }
                }
            }
        }

        fun sendAllNotesOff() {
            val webView = activeWebView ?: return
            webView.post {
                webView.evaluateJavascript(
                    "if (window.emergencyStopSynth) { window.emergencyStopSynth(); }",
                    null
                )
            }
        }

        fun emergencyStopSynth() {
            val webView = activeWebView ?: return
            webView.post {
                webView.evaluateJavascript(
                    "if (window.emergencyStopSynth) { window.emergencyStopSynth(); }",
                    null
                )
            }
        }
    }
}

class AndroidSynthBridge(private val context: Context) {
    @JavascriptInterface
    fun startForegroundService(statusMessage: String?) {
        val message = statusMessage ?: "MIDI Synth running in background"
        val intent = Intent(context, MidiSynthService::class.java).apply {
            action = MidiSynthService.ACTION_START
            putExtra(MidiSynthService.EXTRA_STATUS, message)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (e: Exception) {
            // Starting a foreground service can be refused when the app is
            // backgrounded (API 31+); audio in the WebView still runs either way.
            Log.w("AndroidSynthBridge", "Could not start foreground service", e)
        }
    }

    @JavascriptInterface
    fun stopForegroundService() {
        // Never startService() here: calling it from the background throws on API 26+.
        try {
            context.stopService(Intent(context, MidiSynthService::class.java))
        } catch (e: Exception) {
            Log.w("AndroidSynthBridge", "Could not stop foreground service", e)
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun SynthWebView(
    modifier: Modifier = Modifier,
    onWebViewCreated: (WebView) -> Unit,
    onShowFileChooser: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean
) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                MainActivity.activeWebView = this
                onWebViewCreated(this)
                val assetLoader = WebViewAssetLoader.Builder()
                    .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
                    .build()

                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // All content is served via the https://appassets.androidplatform.net
                // asset loader; file/content access is unnecessary attack surface.
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.mediaPlaybackRequiresUserGesture = false

                addJavascriptInterface(AndroidSynthBridge(context), "AndroidBridge")

                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) {
                        // The bundled page never needs WebView permissions (no
                        // camera/mic/etc.); deny instead of granting blindly.
                        request.deny()
                    }

                    override fun onShowFileChooser(
                        webView: WebView?,
                        filePathCallback: ValueCallback<Array<Uri>>?,
                        fileChooserParams: FileChooserParams?
                    ): Boolean {
                        return if (filePathCallback != null && fileChooserParams != null) {
                            onShowFileChooser(filePathCallback, fileChooserParams)
                        } else {
                            false
                        }
                    }
                }

                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest
                    ): WebResourceResponse? {
                        return assetLoader.shouldInterceptRequest(request.url)
                    }
                }

                loadUrl("https://appassets.androidplatform.net/assets/public/index.html")
            }
        }
    )
}
