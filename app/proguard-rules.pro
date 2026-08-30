# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# WebView JavaScript bridge: AndroidSynthBridge is registered via
# addJavascriptInterface() and its @JavascriptInterface methods are invoked
# reflectively from JS running inside the WebView, so they must not be renamed
# or stripped.
-keepclassmembers class com.dissonance.wfarer.multisynth.AndroidSynthBridge {
   public *;
}

# Framework entry points declared by name in AndroidManifest.xml and resolved by
# reflection: the launcher activity, the foreground-service wrapper, and the
# system-bound MIDI device service. (AGP emits AAPT keep rules for these too;
# listed explicitly so the app survives custom minification setups.)
-keep class com.dissonance.wfarer.multisynth.MainActivity { *; }
-keep class com.dissonance.wfarer.multisynth.MidiSynthService { *; }
-keep class com.dissonance.wfarer.multisynth.MyMidiDeviceService { *; }

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
