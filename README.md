# Multi Synth

A virtual MIDI SoundFont synthesizer for Android. It exposes a **virtual MIDI device** that other apps can play into, renders audio with a self-contained WebAudio SF2/SF3 engine hosted in a WebView, and ships with a bundled General MIDI bank (`FluidR3Mono_GM.sf3`).

Originally generated from a Google AI Studio app; the synth engine, MIDI integration, and native services have since been rebuilt.

## Features

**Sound engine** (vanilla JS + WebAudio, no external libraries)
- SF2 **and** SF3 (Ogg Vorbis-compressed) banks — SF3 samples are decoded in batches at load with progress, plus on-demand decoding as a fallback
- Full preset/instrument generator merge: global zones, preset-level offsets, key/velocity ranges
- Per-voice DAHDSR volume envelopes with keynum tracking, `initialAttenuation`, loop modes, exclusive class, and scale tuning
- Lowpass filter per voice: `initialFilterFc/Q`, modulation envelope to cutoff, LFO to cutoff/volume (zones without filter data bypass the node)
- Modulation and vibrato LFOs; CC1 mod wheel scales vibrato depth on sounding voices
- Pitch bend (±2 semitones), sustain pedal (CC64), pan (CC10), expression (CC11), per-channel All Sound Off / Reset Controllers / All Notes Off (CC120/121/123)
- GM channel 10 percussion (bank 128) with automatic kit lookup
- 48-voice polyphony with voice stealing, stuck-note watchdog, click-free releases from the envelope's analytic level, master-bus limiter, algorithmic reverb

**Sequencer**
- Standard MIDI File parser (formats 0/1, running status, tempo maps)
- Lookahead scheduler on the WebAudio clock (sample-accurate note timing) instead of an animation-frame loop — playback continues in the background with a widened scheduling horizon while the app is hidden
- Seek with controller-state reconstruction

**Engine control**
- The startup bank — the IndexedDB-cached upload if one exists, otherwise the bundled GM bank — loads automatically at app start, before any button is pressed
- **Start Audio Engine** is a toggle. Starting brings up the audio context, the foreground service, and MIDI input; stopping suspends the audio context, silences all voices, stops file playback, and releases the service
- The on-screen keys and the MIDI player's Play button implicitly start a stopped engine (a user gesture), so playback is never dead-ended; incoming MIDI is dropped while the engine is stopped instead of accumulating silently

**Channels & banks**
- On bank load, channels are auto-mapped to patches sequentially (Ch 1 = piano, Ch 2 = bright piano, …; drum kit pinned to Ch 10), deduplicated by (bank, program)
- Optional **Lock Channel Patches** toggle filters Program Change / Bank Select from MIDI sources
- User-uploaded banks are cached in IndexedDB and restored on next launch

**Native layer** (Kotlin)
- `MainActivity` — hosts the WebView via `WebViewAssetLoader`, bridges hardware MIDI (`MidiManager`) into the page with batched `evaluateJavascript` calls, survives configuration changes (dark mode, locale, split-screen) without killing audio
- `MyMidiDeviceService` — publishes the app as a virtual MIDI device ("Virtual SoundFont Synth") that other Android apps can send MIDI to
- `MidiSynthService` — media-playback foreground service + wakelock for background operation, started and stopped with the audio-engine toggle, with a Stop action in its notification

## Getting started

**Prerequisites:** [Android Studio](https://developer.android.com/studio) (or Gradle 9.5 + JDK 17+).

1. Open the project in Android Studio.
2. Run the `app` configuration on an emulator or device — the `debug` build needs no signing setup.
3. On first launch, the bundled `FluidR3Mono_GM.sf3` loads automatically at startup: it is parsed, its Ogg Vorbis samples decode in the background for a few seconds (progress appears in the MIDI log), and channels are auto-mapped as described above. **Start Audio Engine** is a toggle: starting brings up the audio engine, the foreground service, and MIDI input; stopping suspends the audio context, silences all notes, stops playback, and releases the service — safe to stop before loading another bank or reassigning patches, then start again.
4. Load `.sf2`/`.sf3` banks or `.mid` files via the UI, send MIDI from another app to the virtual device, or play the on-screen keyboard.

For a `release` build, provide `KEYSTORE_PATH`, `STORE_PASSWORD` and `KEY_PASSWORD` in the environment first.

> This repo has no `gradlew` script. From the project root you can run the wrapper jar directly:
> `java -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <tasks>`

## Project layout

```
app/src/main/java/com/example/
  MainActivity.kt        WebView host, hardware-MIDI bridge, lifecycle
  MidiSynthService.kt    Foreground service (media playback + wakelock)
  MyMidiDeviceService.kt Virtual MIDI device service
app/src/main/assets/public/
  app.js                 Synth engine, SF2/SF3 parser, sequencer, UI logic
  index.html             Single-page UI
  FluidR3Mono_GM.sf3     Bundled GM bank (SF3, Ogg Vorbis samples)
app/src/main/res/xml/
  midi_device_info.xml   Virtual MIDI device descriptor
```

## Testing

- `ExampleUnitTest` runs on the JVM (`testDebugUnitTest`).
- `ExampleInstrumentedTest` verifies the application id on a device.
- The JS engine is plain ES2020 — `node --check app/src/main/assets/public/app.js` catches syntax errors.

## Known limitations

- The SF2 modulator matrix is not implemented; only the default CC1→vibrato modulator is honored (`modEnvToPitch` and user modulators are ignored).
- Per-zone reverb/chorus sends are ignored; reverb is a single global bus.
- Stereo SF2 banks render their paired `(L)`/`(R)` zones summed rather than panned: per-zone pan (generator 16) is not applied.
- Velocity only selects zones and scales gain; velocity-to-filter/attack crossfades are not implemented.
- SMPTE-timed MIDI files are rejected (ticks-per-beat only).
- Web MIDI (`navigator.requestMIDIAccess`) is unavailable in WebView; external MIDI arrives through the native bridge instead.
