package com.dissonance.wfarer.multisynth

import android.media.midi.MidiDeviceService
import android.media.midi.MidiReceiver

class MyMidiDeviceService : MidiDeviceService() {

    override fun onGetInputPortReceivers(): Array<MidiReceiver> {
        val receiver = object : MidiReceiver() {
            override fun onSend(msg: ByteArray?, offset: Int, count: Int, timestamp: Long) {
                if (msg != null) {
                    // Forward directly to MainActivity
                    MainActivity.handleNativeMidi(msg, offset, count)
                }
            }

            override fun onFlush() {
                MainActivity.sendAllNotesOff()
            }
        }
        return arrayOf(receiver)
    }

    override fun onDestroy() {
        MainActivity.sendAllNotesOff()
        super.onDestroy()
    }
}
