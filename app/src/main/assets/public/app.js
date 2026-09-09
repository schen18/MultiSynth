/**
 * Virtual MIDI SoundFont Synthesizer powered by spessasynth_lib logic
 */

// Algorithmic Reverb Impulse Generator
function createReverbImpulseResponse(ctx, duration = 2.0, decay = 2.0) {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * duration;
  const impulse = ctx.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const percent = i / length;
    const mult = Math.pow(1 - percent, decay);
    left[i] = (Math.random() * 2 - 1) * mult;
    right[i] = (Math.random() * 2 - 1) * mult;
  }
  return impulse;
}

// IndexedDB Caching for uploaded SoundFonts
const DB_NAME = "SoundFontSynthDB";
const DB_VERSION = 1;
const STORE_NAME = "soundfonts";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function saveSoundFontToDB(name, data) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(data, "active_soundfont");
    store.put(name, "active_soundfont_name");
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(tx.error);
  });
}

async function loadSoundFontFromDB() {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const reqData = store.get("active_soundfont");
      reqData.onsuccess = () => {
        const data = reqData.result;
        if (!data) {
          resolve(null);
          return;
        }
        const reqName = store.get("active_soundfont_name");
        reqName.onsuccess = () => {
          resolve({ name: reqName.result || "soundfont.sf2", data });
        };
        reqName.onerror = () => resolve({ name: "soundfont.sf2", data });
      };
      reqData.onerror = () => reject(reqData.error);
    });
  } catch (err) {
    console.error("IndexedDB Load Error:", err);
    return null;
  }
}

async function clearSoundFontDB() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(tx.error);
  });
}

// SF2 generator opcodes (SF2 2.04 §8.1.3, matching FluidSynth GEN_* numbering).
const SF2_GEN = {
  MODLFOTOPITCH: 5,
  VIBLFOTOPITCH: 6,
  MODENVTOPITCH: 7,
  FILTERFC: 8,
  FILTERQ: 9,
  MODLFOTOFILTERFC: 10,
  MODENVTOFILTERFC: 11,
  MODLFOTOVOL: 13,
  DELAYMODLFO: 21,
  FREQMODLFO: 22,
  DELAYVIBLFO: 23,
  FREQVIBLFO: 24,
  DELAYMODENV: 25,
  ATTACKMODENV: 26,
  HOLDMODENV: 27,
  DECAYMODENV: 28,
  SUSTAINMODENV: 29,
  RELEASEMODENV: 30,
  KEYTOMODENVHOLD: 31,
  KEYTOMODENVDECAY: 32,
  DELAYVOLENV: 33,
  ATTACKVOLENV: 34,
  HOLDVOLENV: 35,
  DECAYVOLENV: 36,
  SUSTAINVOLENV: 37,
  RELEASEVOLENV: 38,
  KEYTOVOLENVHOLD: 39,
  KEYTOVOLENVDECAY: 40,
  INSTRUMENT: 41,
  KEYRANGE: 43,
  VELRANGE: 44,
  ATTENUATION: 48,
  COARSETUNE: 51,
  FINETUNE: 52,
  SAMPLEID: 53,
  SAMPLEMODES: 54,
  SCALETUNING: 56,
  EXCLUSIVECLASS: 57,
  OVERRIDINGROOTKEY: 58
};

// Timecents (SF2 timing unit) to seconds.
function tcToSeconds(tc) {
  const clamped = Math.min(8000, Math.max(-12000, tc));
  return Math.pow(2, clamped / 1200);
}

class SoundFont2Parser {
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;
    this.view = new DataView(arrayBuffer);
    this.presets = [];
    this.sampleHeaders = [];
    this.samples = new Int16Array(0);
    this.phdr = [];
    this.pbag = [];
    this.pgen = [];
    this.inst = [];
    this.ibag = [];
    this.igen = [];
    this.shdr = [];
    this.smplInfo = null; // { offset, size } of the smpl chunk
    this.isCompressed = false; // SF3: sample data is Ogg Vorbis
    this.parse();
  }

  readString(offset, length) {
    let str = "";
    for (let i = 0; i < length; i++) {
      const charCode = this.view.getUint8(offset + i);
      if (charCode === 0) break;
      str += String.fromCharCode(charCode);
    }
    return str.trim();
  }

  parse() {
    try {
      if (this.readString(0, 4) !== "RIFF") {
        console.warn("Not a standard RIFF file, initializing default GM SoundBank.");
        return;
      }

      const formType = this.readString(8, 4);
      if (formType !== "sfbk") {
        console.warn("RIFF form type is not sfbk:", formType);
        return;
      }

      let offset = 12;
      while (offset < this.buffer.byteLength - 8) {
        const chunkId = this.readString(offset, 4);
        const chunkSize = this.view.getUint32(offset + 4, true);
        const chunkDataOffset = offset + 8;

        if (chunkId === "LIST") {
          const listType = this.readString(chunkDataOffset, 4);
          this.parseListChunk(listType, chunkDataOffset + 4, chunkSize - 4);
        }
        offset += 8 + chunkSize + (chunkSize % 2);
      }

      this.buildPresets();
      this.detectCompression();
    } catch (e) {
      console.error("Error parsing SoundFont SF2:", e);
    }
  }

  // SF3 keeps the SF2 structure but stores each sample as a complete Ogg Vorbis
  // stream inside smpl: shdr dwStart/dwEnd become BYTE offsets into the chunk
  // (contiguous), while loop points stay in decoded samples relative to each
  // sample's own start.
  detectCompression() {
    this.isCompressed = false;
    if (!this.smplInfo || this.shdr.length < 2) return;
    const first = this.shdr[0];
    const magicOffset = this.smplInfo.offset + first.start;
    if (magicOffset + 4 <= this.buffer.byteLength &&
        this.readString(magicOffset, 4) === "OggS") {
      this.isCompressed = true;
      // Guard the PCM path: the compressed bytes must never be treated as
      // raw sample data.
      this.samples = new Int16Array(0);
    }
  }

  parseListChunk(listType, offset, size) {
    if (listType === "pdta") {
      let subOffset = offset;
      const endOffset = offset + size;
      while (subOffset < endOffset - 8) {
        const subId = this.readString(subOffset, 4);
        const subSize = this.view.getUint32(subOffset + 4, true);
        const subData = subOffset + 8;

        if (subId === "phdr") {
          this.parsePhdr(subData, subSize);
        } else if (subId === "pbag") {
          this.parsePbag(subData, subSize);
        } else if (subId === "pgen") {
          this.parsePgen(subData, subSize);
        } else if (subId === "inst") {
          this.parseInst(subData, subSize);
        } else if (subId === "ibag") {
          this.parseIbag(subData, subSize);
        } else if (subId === "igen") {
          this.parseIgen(subData, subSize);
        } else if (subId === "shdr") {
          this.parseShdr(subData, subSize);
        }
        subOffset += 8 + subSize + (subSize % 2);
      }
    } else if (listType === "sdta") {
      let subOffset = offset;
      const endOffset = offset + size;
      while (subOffset < endOffset - 8) {
        const subId = this.readString(subOffset, 4);
        const subSize = this.view.getUint32(subOffset + 4, true);
        const subData = subOffset + 8;
        if (subId === "smpl") {
          this.smplInfo = { offset: subData, size: subSize };
          this.samples = new Int16Array(this.buffer, subData, subSize / 2);
        }
        subOffset += 8 + subSize + (subSize % 2);
      }
    }
  }

  parsePhdr(offset, size) {
    const recordSize = 38;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      this.phdr.push({
        name: this.readString(rec, 20),
        program: this.view.getUint16(rec + 20, true),
        bank: this.view.getUint16(rec + 22, true),
        presetBagIndex: this.view.getUint16(rec + 24, true)
      });
    }
  }

  parsePbag(offset, size) {
    const recordSize = 4;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      this.pbag.push({
        genIndex: this.view.getUint16(rec, true),
        modIndex: this.view.getUint16(rec + 2, true)
      });
    }
  }

  parsePgen(offset, size) {
    const recordSize = 4;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      this.pgen.push({
        genOper: this.view.getUint16(rec, true),
        genVal: this.view.getUint16(rec + 2, true)
      });
    }
  }

  parseInst(offset, size) {
    const recordSize = 22;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      this.inst.push({
        name: this.readString(rec, 20),
        instBagIndex: this.view.getUint16(rec + 20, true)
      });
    }
  }

  parseIbag(offset, size) {
    const recordSize = 4;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      this.ibag.push({
        genIndex: this.view.getUint16(rec, true),
        modIndex: this.view.getUint16(rec + 2, true)
      });
    }
  }

  parseIgen(offset, size) {
    const recordSize = 4;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      this.igen.push({
        genOper: this.view.getUint16(rec, true),
        genVal: this.view.getUint16(rec + 2, true)
      });
    }
  }

  parseShdr(offset, size) {
    const recordSize = 46;
    const count = Math.floor(size / recordSize);
    for (let i = 0; i < count; i++) {
      const rec = offset + i * recordSize;
      const name = this.readString(rec, 20);
      const start = this.view.getUint32(rec + 20, true);
      const end = this.view.getUint32(rec + 24, true);
      const startLoop = this.view.getUint32(rec + 28, true);
      const endLoop = this.view.getUint32(rec + 32, true);
      const sampleRate = this.view.getUint32(rec + 36, true);
      const originalPitch = this.view.getUint8(rec + 40);
      const pitchCorrection = this.view.getInt8(rec + 41);
      this.shdr.push({ name, start, end, startLoop, endLoop, sampleRate, originalPitch, pitchCorrection });
    }
    this.sampleHeaders = this.shdr;
  }

  buildPresets() {
    const sgn = (v) => (v > 32767 ? v - 65536 : v);
    const resolvedPresets = [];
    const phdrLimit = (this.phdr.length > 0 && this.phdr[this.phdr.length - 1].name.toUpperCase() === "EOP") ? this.phdr.length - 1 : this.phdr.length;

    for (let i = 0; i < phdrLimit; i++) {
      const p = this.phdr[i];
      const nextP = this.phdr[i + 1];
      const presetBagStart = p.presetBagIndex;
      const presetBagEnd = nextP ? nextP.presetBagIndex : this.pbag.length;

      // Collect each preset zone's generator map. A first bag without an
      // instrument generator is the preset's GLOBAL zone (applies to all).
      const presetZoneGens = [];
      let pGlobal = null;
      for (let j = presetBagStart; j < presetBagEnd; j++) {
        if (j >= this.pbag.length) break;
        const bag = this.pbag[j];
        const nextBag = this.pbag[j + 1];
        const genStart = bag.genIndex;
        const genEnd = nextBag ? nextBag.genIndex : this.pgen.length;

        const gens = new Map();
        for (let k = genStart; k < genEnd; k++) {
          if (k >= this.pgen.length) break;
          const gen = this.pgen[k];
          gens.set(gen.genOper, sgn(gen.genVal));
        }
        if (!gens.has(SF2_GEN.INSTRUMENT)) {
          if (j === presetBagStart) pGlobal = gens;
          continue;
        }
        presetZoneGens.push(gens);
      }

      const zones = [];

      presetZoneGens.forEach((pGens) => {
        const instId = pGens.get(SF2_GEN.INSTRUMENT);
        if (!(instId >= 0 && instId < this.inst.length)) return;
        const instrument = this.inst[instId];
        const nextInst = this.inst[instId + 1];
        const instBagStart = instrument.instBagIndex;
        const instBagEnd = nextInst ? nextInst.instBagIndex : this.ibag.length;

        // Same rule at instrument level: a first bag without sampleID is a
        // global zone shared by every zone of the instrument.
        const instZoneGens = [];
        let iGlobal = null;
        for (let m = instBagStart; m < instBagEnd; m++) {
          if (m >= this.ibag.length) break;
          const ibag = this.ibag[m];
          const nextIbag = this.ibag[m + 1];
          const igenStart = ibag.genIndex;
          const igenEnd = nextIbag ? nextIbag.genIndex : this.igen.length;

          const gens = new Map();
          for (let n = igenStart; n < igenEnd; n++) {
            if (n >= this.igen.length) break;
            const igen = this.igen[n];
            gens.set(igen.genOper, sgn(igen.genVal));
          }
          if (!gens.has(SF2_GEN.SAMPLEID)) {
            if (m === instBagStart) iGlobal = gens;
            continue;
          }
          instZoneGens.push(gens);
        }

        instZoneGens.forEach((iGens) => {
          const sampleId = iGens.get(SF2_GEN.SAMPLEID);
          if (!(sampleId >= 0 && sampleId < this.shdr.length)) return;

          // Range generators: preset zone intersects instrument zone (packed lo|hi).
          const rangeOf = (localMap, globalMap, oper) => {
            let v = null;
            if (localMap.has(oper)) v = localMap.get(oper);
            else if (globalMap && globalMap.has(oper)) v = globalMap.get(oper);
            if (v === null) return [0, 127];
            return [v & 0x00FF, (v >> 8) & 0x00FF];
          };
          const [pkMin, pkMax] = rangeOf(pGens, pGlobal, SF2_GEN.KEYRANGE);
          const [ikMin, ikMax] = rangeOf(iGens, iGlobal, SF2_GEN.KEYRANGE);
          const [pvMin, pvMax] = rangeOf(pGens, pGlobal, SF2_GEN.VELRANGE);
          const [ivMin, ivMax] = rangeOf(iGens, iGlobal, SF2_GEN.VELRANGE);

          // Value generators: preset-level ADDS to instrument-level; a zone's
          // own value wins over its global zone.
          const pickInst = (o) => iGens.has(o) ? iGens.get(o) : (iGlobal && iGlobal.has(o) ? iGlobal.get(o) : null);
          const pickPreset = (o) => pGens.has(o) ? pGens.get(o) : (pGlobal && pGlobal.has(o) ? pGlobal.get(o) : null);
          const g = (o, def) => {
            const iv = pickInst(o);
            const pv = pickPreset(o);
            if (iv === null && pv === null) return def;
            return (iv === null ? 0 : iv) + (pv === null ? 0 : pv);
          };

          zones.push({
            sampleId,
            minKey: Math.max(pkMin, ikMin),
            maxKey: Math.min(pkMax, ikMax),
            minVel: Math.max(pvMin, ivMin),
            maxVel: Math.min(pvMax, ivMax),
            overridingRootKey: g(SF2_GEN.OVERRIDINGROOTKEY, -1),
            fineTune: g(SF2_GEN.FINETUNE, 0),
            coarseTune: g(SF2_GEN.COARSETUNE, 0),
            sampleModes: g(SF2_GEN.SAMPLEMODES, 0),
            scaleTuning: g(SF2_GEN.SCALETUNING, 100),
            exclusiveClass: g(SF2_GEN.EXCLUSIVECLASS, 0),
            // Some editors write negative attenuation as a boost; clamp to the
            // legal range so rendering math never sees invalid values.
            attenuation: Math.min(1440, Math.max(0, g(SF2_GEN.ATTENUATION, 0))),
            volEnv: {
              delay: g(SF2_GEN.DELAYVOLENV, -12000),
              attack: g(SF2_GEN.ATTACKVOLENV, -12000),
              hold: g(SF2_GEN.HOLDVOLENV, -12000),
              decay: g(SF2_GEN.DECAYVOLENV, -12000),
              sustain: g(SF2_GEN.SUSTAINVOLENV, 0),
              release: g(SF2_GEN.RELEASEVOLENV, -12000)
            },
            keynumToVolEnvHold: g(SF2_GEN.KEYTOVOLENVHOLD, 0),
            keynumToVolEnvDecay: g(SF2_GEN.KEYTOVOLENVDECAY, 0),
            filterFc: g(SF2_GEN.FILTERFC, 13500),
            filterQ: g(SF2_GEN.FILTERQ, 0),
            modEnvToFilterFc: g(SF2_GEN.MODENVTOFILTERFC, 0),
            modEnv: {
              delay: g(SF2_GEN.DELAYMODENV, -12000),
              attack: g(SF2_GEN.ATTACKMODENV, -12000),
              hold: g(SF2_GEN.HOLDMODENV, -12000),
              decay: g(SF2_GEN.DECAYMODENV, -12000),
              sustain: g(SF2_GEN.SUSTAINMODENV, 0),
              release: g(SF2_GEN.RELEASEMODENV, -12000)
            },
            modLfo: {
              delay: g(SF2_GEN.DELAYMODLFO, -12000),
              freq: g(SF2_GEN.FREQMODLFO, 0),
              toPitch: g(SF2_GEN.MODLFOTOPITCH, 0),
              toFilterFc: g(SF2_GEN.MODLFOTOFILTERFC, 0),
              toVolume: g(SF2_GEN.MODLFOTOVOL, 0)
            },
            vibLfo: {
              delay: g(SF2_GEN.DELAYVIBLFO, -12000),
              freq: g(SF2_GEN.FREQVIBLFO, 0),
              toPitch: g(SF2_GEN.VIBLFOTOPITCH, 0)
            }
          });
        });
      });

      resolvedPresets.push({
        name: p.name || `Preset ${p.program}`,
        bank: p.bank,
        program: p.program,
        zones: zones
      });
    }

    this.presets = resolvedPresets;
  }
}

class SpessaSynthEngine {
  constructor(onVoiceChange) {
    this.ctx = null;
    this.masterGain = null;
    this.masterCompressor = null; // Peak limiter on the master bus
    this.synthOutput = null; // Reverb send bus
    this.convolver = null;
    this.reverbWetGain = null;
    this.reverbMix = 0.30; // 30% default wet level
    this.reverbDecay = 2.0; // 2.0s default decay duration
    this.activeVoices = new Map(); // key: "channel_note", value: audio source node
    this.voiceWatchdogs = new Map(); // key: "channel_note", value: timeout ID
    this.maxPolyphony = 48; // Maximum simultaneous voices to prevent runaway stuck notes
    this.onVoiceChange = onVoiceChange;
    this.soundBankManager = {
      name: "",
      presets: []
    };
    this.currentSoundFont = null;
    this.channelPrograms = new Array(16).fill(0);
    this.channelBanks = new Array(16).fill(0);
    this.channelVolumes = new Array(16).fill(1.0);
    this.channelExpression = new Array(16).fill(1.0); // CC11
    this.channelPan = new Array(16).fill(0); // CC10, -1..1
    this.channelPanners = new Array(16).fill(null); // lazy per-channel StereoPannerNode
    this.channelBend = new Array(16).fill(0); // pitch bend, -1..1
    this.channelSustain = new Array(16).fill(false); // CC64
    this.sustainedVoiceKeys = new Set(); // voiceKeys held by the pedal
    this.channelMod = new Array(16).fill(0); // CC1 mod wheel, 0..1
    this.bendRangeSemitones = 2; // GM default
    this.ignoreMidiProgramChanges = false; // honor Program Change / Bank Select by default
    this.decodeInFlight = new Map(); // sampleId -> decode promise (SF3)
  }

  async initAudio() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();
    // Peak limiter: dense chords across 16 channels can otherwise hard-clip
    // at the destination.
    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.setValueAtTime(-10, this.ctx.currentTime);
    this.masterCompressor.knee.setValueAtTime(20, this.ctx.currentTime);
    this.masterCompressor.ratio.setValueAtTime(6, this.ctx.currentTime);
    this.masterCompressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
    this.masterCompressor.release.setValueAtTime(0.25, this.ctx.currentTime);
    this.masterCompressor.connect(this.ctx.destination);

    // Master Output Gain Control
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
    this.masterGain.connect(this.masterCompressor);

    // Synth Output Bus (All voices direct here first)
    this.synthOutput = this.ctx.createGain();
    this.synthOutput.connect(this.masterGain); // Dry signal path

    // Parallel Reverb processing path
    this.convolver = this.ctx.createConvolver();
    this.reverbWetGain = this.ctx.createGain();
    this.reverbWetGain.gain.setValueAtTime(this.reverbMix, this.ctx.currentTime);

    // Load dynamic impulse response
    this.updateReverbImpulse();

    // Connect Reverb loop
    this.synthOutput.connect(this.convolver);
    this.convolver.connect(this.reverbWetGain);
    this.reverbWetGain.connect(this.masterGain); // Mix wet back with dry
  }

  // Per-channel input node (gain -> panner -> synthOutput), created lazily so
  // CC10 pan changes only need to touch nodes that are actually in use.
  getChannelInput(channel) {
    if (!this.ctx) return null;
    let panner = this.channelPanners[channel];
    if (!panner) {
      panner = this.ctx.createStereoPanner
        ? this.ctx.createStereoPanner()
        : this.ctx.createGain(); // fallback if StereoPanner unavailable
      if (panner.pan) {
        panner.pan.setValueAtTime(this.channelPan[channel] || 0, this.ctx.currentTime);
      }
      panner.connect(this.synthOutput || this.masterGain);
      this.channelPanners[channel] = panner;
    }
    return panner;
  }

  isRunning() {
    return !!(this.ctx && this.ctx.state === "running");
  }

  async suspendAudio() {
    if (this.ctx && this.ctx.state === "running") {
      await this.ctx.suspend();
    }
  }

  updateReverbImpulse() {
    if (this.ctx && this.convolver) {
      try {
        const impulse = createReverbImpulseResponse(this.ctx, this.reverbDecay, 2.0);
        this.convolver.buffer = impulse;
      } catch (e) {
        console.error("Error creating reverb impulse response", e);
      }
    }
  }

  setReverbMix(mix) {
    this.reverbMix = mix;
    if (this.reverbWetGain && this.ctx) {
      this.reverbWetGain.gain.setTargetAtTime(mix, this.ctx.currentTime, 0.01);
    }
  }

  setReverbDecay(decay) {
    this.reverbDecay = decay;
    this.updateReverbImpulse();
  }

  setVolume(vol) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.01);
    }
  }

  loadSoundBank(arrayBuffer, fileName = "soundfont.sf2") {
    const parser = new SoundFont2Parser(arrayBuffer);
    this.soundBankManager.name = fileName;
    const presets = parser.presets || [];
    const totalZones = presets.reduce((n, p) => n + (p.zones ? p.zones.length : 0), 0);
    const hasSampleData = parser.isCompressed ||
      (parser.samples && parser.samples.length > 0);

    if (presets.length === 0 || totalZones === 0 || !hasSampleData) {
      // Reject the bank entirely. Keeping the previous bank's presets would leave
      // them pointing into the new (unusable) sample data.
      this.soundBankManager.presets = [];
      this.currentSoundFont = null;
      return [];
    }

    this.soundBankManager.presets = presets;
    this.currentSoundFont = {
      sampleHeaders: parser.sampleHeaders,
      samples: parser.samples,
      bufferCache: new Map(),
      compressed: parser.isCompressed,
      smplOffset: parser.smplInfo ? parser.smplInfo.offset : 0,
      sourceBuffer: arrayBuffer // kept for per-sample Ogg slices (SF3)
    };
    return presets;
  }

  // Decode one compressed (Ogg Vorbis) SF3 sample into the buffer cache.
  decodeSample(sampleId) {
    const sf = this.currentSoundFont;
    if (!sf || !sf.compressed || !this.ctx) return Promise.resolve(null);
    if (sf.bufferCache.has(sampleId)) return Promise.resolve(sf.bufferCache.get(sampleId));
    if (this.decodeInFlight.has(sampleId)) return this.decodeInFlight.get(sampleId);

    const header = sf.sampleHeaders[sampleId];
    if (!header || !sf.sourceBuffer) return Promise.resolve(null);
    const startByte = sf.smplOffset + header.start;
    const endByte = sf.smplOffset + header.end;
    if (endByte <= startByte || endByte > sf.sourceBuffer.byteLength) {
      return Promise.resolve(null);
    }

    // decodeAudioData detaches the buffer it is given, so hand it a copy.
    const oggData = sf.sourceBuffer.slice(startByte, endByte);
    const promise = this.ctx.decodeAudioData(oggData).then((buffer) => {
      sf.bufferCache.set(sampleId, buffer);
      this.decodeInFlight.delete(sampleId);
      return buffer;
    }).catch((err) => {
      console.warn(`SF3 decode failed for sample ${sampleId} (${header.name}):`, err);
      this.decodeInFlight.delete(sampleId);
      return null;
    });
    this.decodeInFlight.set(sampleId, promise);
    return promise;
  }

  // Pre-decode every sample referenced by the loaded bank's zones (SF3), in
  // small batches so the UI stays responsive.
  async decodeAllSamples(onProgress) {
    const sf = this.currentSoundFont;
    if (!sf || !sf.compressed) return;
    if (!this.ctx) await this.initAudio();

    const ids = new Set();
    this.soundBankManager.presets.forEach((p) =>
      (p.zones || []).forEach((z) => ids.add(z.sampleId))
    );
    const queue = Array.from(ids);
    const total = queue.length;
    const BATCH = 8;

    for (let i = 0; i < queue.length; i += BATCH) {
      const batch = queue.slice(i, i + BATCH).map((id) => this.decodeSample(id));
      await Promise.all(batch);
      if (onProgress) onProgress(Math.min(total, i + BATCH), total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  setChannelPatch(channel, bank, program) {
    if (channel >= 0 && channel < 16) {
      this.channelPrograms[channel] = program;
      this.channelBanks[channel] = bank;
    }
  }

  // Map channels sequentially onto the bank's patches: channel 1 takes the
  // lowest (bank, program) melodic patch, channel 2 the next, and so on.
  // Channel 10 always receives the first percussion kit (GM convention).
  // Duplicate (bank, program) entries are skipped — the engine's preset
  // lookup only ever finds the first of them anyway.
  autoMapChannels() {
    const presets = this.soundBankManager.presets;
    if (!presets || presets.length === 0) return false;

    const byPatchOrder = (a, b) => (a.bank - b.bank) || (a.program - b.program);
    const seen = new Set();
    const unique = presets.filter((p) => {
      const key = `${p.bank}_${p.program}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort(byPatchOrder);

    const melodic = unique.filter(p => p.bank !== 128);
    const percussion = unique.find(p => p.bank === 128) || null;

    let idx = 0;
    for (let ch = 0; ch < 16; ch++) {
      if (ch === 9 && percussion) {
        this.setChannelPatch(ch, percussion.bank, percussion.program);
      } else if (melodic.length > 0) {
        const preset = melodic[idx % melodic.length];
        this.setChannelPatch(ch, preset.bank, preset.program);
        idx++;
      }
    }
    return true;
  }

  programChange(channel, program, force = false) {
    if (this.ignoreMidiProgramChanges && !force) return;
    if (channel >= 0 && channel < 16) {
      this.channelPrograms[channel] = program;
    }
  }

  bankSelect(channel, bank, force = false) {
    if (this.ignoreMidiProgramChanges && !force) return;
    if (channel >= 0 && channel < 16) {
      this.channelBanks[channel] = bank;
    }
  }

  setIgnoreMidiProgramChanges(ignore) {
    this.ignoreMidiProgramChanges = ignore;
  }

  controllerChange(channel, ccNumber, value) {
    if (channel < 0 || channel > 15) return;
    if (ccNumber === 1) { // Modulation -> vibrato depth
      this.applyModWheel(channel, value / 127);
    } else if (ccNumber === 0) { // Bank Select MSB
      if (!this.ignoreMidiProgramChanges) {
        this.bankSelect(channel, value);
      }
    } else if (ccNumber === 32) { // Bank Select LSB
      if (!this.ignoreMidiProgramChanges) {
        // Fine bank select if applicable
      }
    } else if (ccNumber === 7) { // Channel Volume
      this.channelVolumes[channel] = value / 127.0;
    } else if (ccNumber === 11) { // Expression
      this.channelExpression[channel] = value / 127.0;
    } else if (ccNumber === 10) { // Pan
      this.channelPan[channel] = (value - 64) / 63;
      const panner = this.channelPanners[channel];
      if (panner && panner.pan && this.ctx) {
        panner.pan.setTargetAtTime(this.channelPan[channel], this.ctx.currentTime, 0.01);
      }
    } else if (ccNumber === 64) { // Sustain Pedal
      const wasDown = this.channelSustain[channel];
      this.channelSustain[channel] = value >= 64;
      if (wasDown && !this.channelSustain[channel]) {
        this.releaseSustainedNotes(channel);
      }
    } else if (ccNumber === 120) { // All Sound Off — immediate hard silence on this channel
      this.channelSustain[channel] = false;
      this.releaseSustainedNotes(channel);
      this.releaseChannelNotes(channel, true);
    } else if (ccNumber === 121) { // Reset All Controllers
      this.channelBend[channel] = 0;
      this.channelExpression[channel] = 1.0;
      this.channelPan[channel] = 0;
      if (this.channelPanners[channel] && this.channelPanners[channel].pan && this.ctx) {
        this.channelPanners[channel].pan.setValueAtTime(0, this.ctx.currentTime);
      }
      this.channelSustain[channel] = false;
      this.releaseSustainedNotes(channel);
    } else if (ccNumber === 123) { // All Notes Off — release, respects sustain
      this.releaseChannelNotes(channel, false);
    }
  }

  pitchBend(channel, lsb, msb) {
    if (!this.ctx || channel < 0 || channel > 15) return;
    const bend = (((msb & 0x7F) << 7) | (lsb & 0x7F)) / 8192 - 1; // -1..1
    this.channelBend[channel] = bend;
    const factor = Math.pow(2, (bend * this.bendRangeSemitones) / 12);
    const now = this.ctx.currentTime;
    this.activeVoices.forEach((voices) => {
      const vArray = Array.isArray(voices) ? voices : [voices];
      vArray.forEach((voice) => {
        if (voice && voice.channel === channel && voice.osc && voice.basePlaybackRate) {
          try {
            voice.osc.playbackRate.setTargetAtTime(voice.basePlaybackRate * factor, now, 0.01);
          } catch (e) {}
        }
      });
    });
  }

  // Sine LFO -> depth gain -> target AudioParam, started after its delay.
  createLfo(freqTc, delayTc, targetParam, depthValue, t0) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = Math.min(40, Math.max(0.03, 8.176 * Math.pow(2, Math.min(4500, Math.max(-12000, freqTc)) / 1200)));
    const depth = this.ctx.createGain();
    depth.gain.value = depthValue;
    osc.connect(depth);
    depth.connect(targetParam);
    osc.start(t0 + Math.max(tcToSeconds(delayTc), 0.001));
    return { osc, depth };
  }

  // Analytic level of the scheduled DAHDSR envelope at audio time t — used so
  // releases (including future-scheduled ones from the sequencer) can fade from
  // the level the voice actually has at that moment.
  envelopeLevelAt(voice, t) {
    const e = voice.env;
    if (!e) {
      return voice.targetGain != null ? voice.targetGain : (voice.gainNode ? voice.gainNode.gain.value : 0);
    }
    if (t <= e.t0 + e.delay) return e.v0;
    const tAttackStart = e.t0 + e.delay;
    const tA = tAttackStart + e.attack;
    if (t <= tA) {
      const f = (t - tAttackStart) / e.attack;
      return e.v0 * Math.pow(e.peak / e.v0, f);
    }
    const tH = tA + e.hold;
    if (t <= tH) return e.peak;
    const tD = tH + e.decay;
    if (t <= tD) {
      const f = (t - tH) / e.decay;
      return e.peak * Math.pow(e.sustainLevel / e.peak, f);
    }
    return e.sustainLevel;
  }

  // CC1 mod wheel: rescale vibrato depth on all sounding voices of a channel.
  applyModWheel(channel, mod) {
    this.channelMod[channel] = mod;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.activeVoices.forEach((voices) => {
      (Array.isArray(voices) ? voices : [voices]).forEach((voice) => {
        if (voice && voice.channel === channel && voice.vibDepth) {
          try {
            voice.vibDepth.node.gain.setTargetAtTime(voice.vibDepth.base + 50 * mod, now, 0.03);
          } catch (e) {}
        }
      });
    });
  }

  noteOn(channel, note, velocity = 100, when = null) {
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    const now = when !== null ? Math.max(when, this.ctx.currentTime) : this.ctx.currentTime;

    const voiceKey = `${channel}_${note}`;
    if (this.activeVoices.has(voiceKey)) {
      // Retrigger: bypass sustain so the old voice is actually replaced
      // instead of being orphaned in the sustained set.
      this.sustainedVoiceKeys.delete(voiceKey);
      this.releaseVoiceKey(voiceKey, now, true);
    }

    // Voice stealing if at polyphony limit to avoid audio thread stalls
    if (this.activeVoices.size >= this.maxPolyphony) {
      const oldestKey = this.activeVoices.keys().next().value;
      if (oldestKey) {
        this.sustainedVoiceKeys.delete(oldestKey);
        this.releaseVoiceKey(oldestKey, now, true);
      }
    }

    const prog = this.channelPrograms[channel] || 0;
    const bank = this.channelBanks[channel] || 0;
    const velGain = (velocity / 127) *
      (this.channelVolumes[channel] || 1.0) *
      (this.channelExpression[channel] || 1.0);
    const bendFactor = Math.pow(2, ((this.channelBend[channel] || 0) * this.bendRangeSemitones) / 12);

    let playedFromSoundFont = false;

    if (this.currentSoundFont && this.soundBankManager.presets && this.soundBankManager.presets.length > 0) {
      // GM channel 10 is percussion: prefer the drum bank (128) regardless of
      // what Bank Select arrived on the channel.
      let activePreset = null;
      if (channel === 9) {
        activePreset = this.soundBankManager.presets.find(p => p.bank === 128 && p.program === prog)
                    || this.soundBankManager.presets.find(p => p.bank === 128 && p.program === 0);
      }
      if (!activePreset) {
        activePreset = this.soundBankManager.presets.find(p => p.program === prog && p.bank === bank)
                    || this.soundBankManager.presets.find(p => p.program === prog)
                    || this.soundBankManager.presets[0];
      }

      if (activePreset && activePreset.zones && activePreset.zones.length > 0) {
        const matchingZones = activePreset.zones.filter(z =>
          note >= z.minKey && note <= z.maxKey &&
          velocity >= z.minVel && velocity <= z.maxVel
        );

        const targetZones = matchingZones.length > 0 ? matchingZones : activePreset.zones;
        const voicesList = [];

        targetZones.forEach(zone => {
          const bestSample = this.currentSoundFont.sampleHeaders[zone.sampleId];
          if (!bestSample) return;

          // Cache by sampleId: SF2 sample names are NOT guaranteed unique, so a
          // name key can return a different sample's audio.
          let audioBuffer = this.currentSoundFont.bufferCache.get(zone.sampleId);
          if (!audioBuffer && !this.currentSoundFont.compressed) {
            const start = bestSample.start;
            const end = bestSample.end;
            const sampleRate = bestSample.sampleRate || 44100;
            const durationSamples = end - start;

            if (durationSamples > 0 && this.currentSoundFont.samples.length >= end) {
              const rawData = this.currentSoundFont.samples.subarray(start, end);
              audioBuffer = this.ctx.createBuffer(1, durationSamples, sampleRate);
              const channelData = audioBuffer.getChannelData(0);
              for (let i = 0; i < durationSamples; i++) {
                channelData[i] = rawData[i] / 32768.0;
              }
              this.currentSoundFont.bufferCache.set(zone.sampleId, audioBuffer);
            }
          } else if (!audioBuffer) {
            // SF3: samples decode asynchronously; kick a decode so the sample
            // is available for the next note.
            this.decodeSample(zone.sampleId);
          }

          if (audioBuffer) {
            // Exclusive class (drums): cut any sounding voice in this class.
            if (zone.exclusiveClass > 0) {
              this.activeVoices.forEach((vArr, exKey) => {
                const list = Array.isArray(vArr) ? vArr : [vArr];
                if (list.some((v) => v && v.exclusiveClass === zone.exclusiveClass)) {
                  this.sustainedVoiceKeys.delete(exKey);
                  this.releaseVoiceKey(exKey, now, true);
                }
              });
            }

            const source = this.ctx.createBufferSource();
            source.buffer = audioBuffer;

            const rootKey = zone.overridingRootKey !== -1 ? zone.overridingRootKey : bestSample.originalPitch;
            const pitchCorrectionSemitones = (bestSample.pitchCorrection || 0) / 100.0;
            const totalTune = zone.coarseTune + (zone.fineTune / 100.0) + pitchCorrectionSemitones;
            const scale = zone.scaleTuning == null ? 100 : zone.scaleTuning;
            const pitchDiff = (note - rootKey) * (scale / 100) + totalTune;
            const baseRate = Math.pow(2, pitchDiff / 12);
            source.playbackRate.value = baseRate * bendFactor;

            const sampleRate = bestSample.sampleRate || 44100;
            if (zone.sampleModes === 1 || zone.sampleModes === 3) {
              if (this.currentSoundFont.compressed) {
                // SF3 loop points are already relative to the sample's own
                // start; WebAudio clamps loopEnd to the buffer duration.
                if (bestSample.endLoop > bestSample.startLoop) {
                  source.loop = true;
                  source.loopStart = bestSample.startLoop / sampleRate;
                  source.loopEnd = bestSample.endLoop / sampleRate;
                }
              } else if (bestSample.startLoop >= bestSample.start && bestSample.endLoop > bestSample.startLoop && bestSample.endLoop <= bestSample.end) {
                source.loop = true;
                source.loopStart = (bestSample.startLoop - bestSample.start) / sampleRate;
                source.loopEnd = (bestSample.endLoop - bestSample.start) / sampleRate;
              }
            }

            const gainNode = this.ctx.createGain();

            // --- Volume envelope (DAHDSR) with initial attenuation ---
            // Peak level = velocity × channel volume × expression, scaled by
            // the zone's initialAttenuation (centibels).
            const attCb = Math.min(1440, Math.max(0, zone.attenuation || 0));
            const peak = Math.max(velGain * Math.pow(10, -attCb / 200), 1e-7);
            const keyShift = note - 60;
            const env = {
              t0: now,
              delay: Math.max(tcToSeconds(zone.volEnv.delay), 0.001),
              attack: Math.max(tcToSeconds(zone.volEnv.attack), 0.001),
              hold: Math.max(tcToSeconds(zone.volEnv.hold - (zone.keynumToVolEnvHold || 0) * keyShift), 0.001),
              decay: Math.max(tcToSeconds(zone.volEnv.decay - (zone.keynumToVolEnvDecay || 0) * keyShift), 0.001),
              sustainLevel: 0,
              release: Math.max(tcToSeconds(zone.volEnv.release), 0.005),
              peak,
              v0: peak * 1e-4
            };
            const sustainCb = Math.min(1440, Math.max(0, zone.volEnv.sustain || 0));
            env.sustainLevel = Math.max(peak * Math.pow(10, -sustainCb / 200), env.v0);

            const gn = gainNode.gain;
            const tAttackEnd = now + env.delay + env.attack;
            const tHoldEnd = tAttackEnd + env.hold;
            gn.setValueAtTime(env.v0, now);
            gn.exponentialRampToValueAtTime(peak, tAttackEnd);
            gn.setValueAtTime(peak, tHoldEnd);
            gn.exponentialRampToValueAtTime(env.sustainLevel, tHoldEnd + env.decay);

            // --- Lowpass filter: initialFilterFc/Q + mod env to cutoff ---
            const nyq = this.ctx.sampleRate / 2;
            const wantsFilter =
              (zone.filterFc != null && zone.filterFc < 13000) ||
              (zone.filterQ > 0) ||
              zone.modEnvToFilterFc !== 0 ||
              zone.modLfo.toFilterFc !== 0;

            let filter = null;
            let filterFcHz = 0;
            if (wantsFilter) {
              filter = this.ctx.createBiquadFilter();
              filter.type = "lowpass";
              // Spec render range: 1500-13500 cents (~19.5Hz-19.5kHz). Preset
              // offsets can sum outside it; clamp like FluidSynth does.
              const fcCents = Math.min(13500, Math.max(1500, zone.filterFc));
              filterFcHz = Math.min(nyq * 0.98, Math.max(50, 8.176 * Math.pow(2, fcCents / 1200)));
              const qLin = Math.min(20, Math.max(0.5, Math.pow(10, Math.min(zone.filterQ, 960) / 200)));
              filter.frequency.setValueAtTime(filterFcHz, now);
              filter.Q.setValueAtTime(qLin, now);

              if (zone.modEnvToFilterFc !== 0) {
                // Filter envelope: cutoff sweeps by modEnvToFilterFc cents and
                // settles according to the mod env sustain fraction.
                const clampFc = (hz) => Math.min(nyq * 0.98, Math.max(50, hz));
                const peakFc = clampFc(filterFcHz * Math.pow(2, zone.modEnvToFilterFc / 1200));
                const susFrac = Math.min(1, Math.max(0, (zone.modEnv.sustain || 0) / 1000));
                const susFc = clampFc(filterFcHz * Math.pow(2, (zone.modEnvToFilterFc * susFrac) / 1200));
                const mDelay = Math.max(tcToSeconds(zone.modEnv.delay), 0.001);
                const mAttack = Math.max(tcToSeconds(zone.modEnv.attack), 0.001);
                const mHold = Math.max(tcToSeconds(zone.modEnv.hold), 0.001);
                const mDecay = Math.max(tcToSeconds(zone.modEnv.decay), 0.001);
                const fp = filter.frequency;
                fp.setValueAtTime(filterFcHz, now + mDelay);
                fp.exponentialRampToValueAtTime(peakFc, now + mDelay + mAttack);
                fp.setValueAtTime(peakFc, now + mDelay + mAttack + mHold);
                fp.exponentialRampToValueAtTime(susFc, now + mDelay + mAttack + mHold + mDecay);
              }
            }

            // Graph: source -> [filter] -> gain -> channel bus
            if (filter) {
              source.connect(filter);
              filter.connect(gainNode);
            } else {
              source.connect(gainNode);
            }
            gainNode.connect(this.getChannelInput(channel) || this.masterGain);

            const voice = {
              osc: source,
              gainNode,
              filter,
              stopTime: now,
              channel,
              targetGain: peak,
              basePlaybackRate: baseRate,
              exclusiveClass: zone.exclusiveClass || 0,
              env,
              lfos: [],
              vibDepth: null
            };

            // --- LFOs: vibrato (CC1-scalable) and fixed modulation ---
            const vibBase = zone.vibLfo.toPitch || 0;
            const modWheel = this.channelMod[channel] || 0;
            if ((vibBase !== 0 || modWheel > 0) && source.detune) {
              // Default SF2 modulator #1: CC1 scales a 50-cent vibrato depth
              // on top of the zone's own vibLfoToPitch.
              const vib = this.createLfo(zone.vibLfo.freq, zone.vibLfo.delay, source.detune, vibBase + 50 * modWheel, now);
              voice.lfos.push(vib);
              voice.vibDepth = { node: vib.depth, base: vibBase };
            }
            if (zone.modLfo.toPitch && source.detune) {
              voice.lfos.push(this.createLfo(zone.modLfo.freq, zone.modLfo.delay, source.detune, zone.modLfo.toPitch, now));
            }
            if (filter && zone.modLfo.toFilterFc) {
              const deltaHz = filterFcHz * (Math.pow(2, zone.modLfo.toFilterFc / 1200) - 1);
              voice.lfos.push(this.createLfo(zone.modLfo.freq, zone.modLfo.delay, filter.frequency, deltaHz, now));
            }
            if (zone.modLfo.toVolume) {
              const depthAmp = peak * (Math.pow(10, zone.modLfo.toVolume / 200) - 1);
              voice.lfos.push(this.createLfo(zone.modLfo.freq, zone.modLfo.delay, gainNode.gain, depthAmp, now));
            }

            source.start(now);
            voicesList.push(voice);
            playedFromSoundFont = true;
          }
        });

        if (voicesList.length > 0) {
          this.activeVoices.set(voiceKey, voicesList);

          // Automatic Stuck Note Watchdog: Auto-release voice after 25s if MIDI source disconnected without Note-Off
          if (this.voiceWatchdogs.has(voiceKey)) {
            clearTimeout(this.voiceWatchdogs.get(voiceKey));
          }
          const watchdogDelay = 25000 + Math.max(0, (now - this.ctx.currentTime) * 1000);
          const watchdogTimer = setTimeout(() => {
            this.sustainedVoiceKeys.delete(voiceKey);
            this.releaseVoiceKey(voiceKey, null, false);
          }, watchdogDelay);
          this.voiceWatchdogs.set(voiceKey, watchdogTimer);
        }
      }
    }

    if (playedFromSoundFont && this.onVoiceChange) {
      this.onVoiceChange(this.activeVoices.size, channel, true);
    }
  }

  noteOff(channel, note, when = null, force = false) {
    const voiceKey = `${channel}_${note}`;

    // With the sustain pedal down, defer the release until pedal-up.
    if (!force && this.channelSustain[channel]) {
      if (this.activeVoices.has(voiceKey)) {
        this.sustainedVoiceKeys.add(voiceKey);
      }
      return;
    }

    this.releaseVoiceKey(voiceKey, when, false);
  }

  releaseSustainedNotes(channel) {
    for (const key of Array.from(this.sustainedVoiceKeys)) {
      const ch = parseInt(key.split("_")[0], 10);
      if (ch === channel) {
        this.releaseVoiceKey(key, null, false);
      }
    }
  }

  releaseChannelNotes(channel, fast) {
    for (const key of Array.from(this.activeVoices.keys())) {
      const ch = parseInt(key.split("_")[0], 10);
      if (ch === channel) {
        if (!fast && this.channelSustain[channel]) {
          this.sustainedVoiceKeys.add(key);
        } else {
          this.sustainedVoiceKeys.delete(key);
          this.releaseVoiceKey(key, null, fast);
        }
      }
    }
  }

  releaseVoiceKey(voiceKey, when, fast) {
    if (this.voiceWatchdogs.has(voiceKey)) {
      clearTimeout(this.voiceWatchdogs.get(voiceKey));
      this.voiceWatchdogs.delete(voiceKey);
    }
    this.sustainedVoiceKeys.delete(voiceKey);

    if (!this.activeVoices.has(voiceKey) || !this.ctx) return;

    const voices = this.activeVoices.get(voiceKey);
    const now = when !== null ? Math.max(when, this.ctx.currentTime) : this.ctx.currentTime;
    const channel = parseInt(voiceKey.split("_")[0], 10);

    const releaseVoice = (voice) => {
      try {
        const releaseTime = fast ? 0.02 : (voice.env ? voice.env.release : 0.25);
        const floor = voice.env ? voice.env.v0 : 0.0001;
        const stopAt = now + releaseTime + 0.02;
        if (voice.gainNode) {
          // Release from the envelope's actual level at this moment (analytic,
          // so future-scheduled releases from the sequencer work too).
          const level = Math.max(this.envelopeLevelAt(voice, now), floor);
          voice.gainNode.gain.cancelScheduledValues(now);
          voice.gainNode.gain.setValueAtTime(level, now);
          voice.gainNode.gain.exponentialRampToValueAtTime(floor, now + releaseTime);
        }
        if (voice.osc) {
          voice.osc.stop(stopAt);
          if (voice.lfos) {
            voice.lfos.forEach((l) => {
              try { l.osc.stop(stopAt); } catch (e) {}
            });
          }
          const oscRef = voice.osc;
          const filterRef = voice.filter;
          const gainRef = voice.gainNode;
          const lfoRefs = voice.lfos || [];
          setTimeout(() => {
            try { oscRef.disconnect(); } catch (e) {}
            try { if (filterRef) filterRef.disconnect(); } catch (e) {}
            try { if (gainRef) gainRef.disconnect(); } catch (e) {}
            lfoRefs.forEach((l) => {
              try { l.osc.disconnect(); } catch (e) {}
              try { l.depth.disconnect(); } catch (e) {}
            });
          }, (releaseTime + 0.2) * 1000);
        }
      } catch (e) {}
    };

    if (voices && Array.isArray(voices)) {
      voices.forEach(releaseVoice);
    } else if (voices) {
      releaseVoice(voices);
    }

    this.activeVoices.delete(voiceKey);

    if (this.onVoiceChange) {
      this.onVoiceChange(this.activeVoices.size, channel, false);
    }
  }

  stopAll() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Clear all watchdog timers and sustain state
    this.voiceWatchdogs.forEach(t => clearTimeout(t));
    this.voiceWatchdogs.clear();
    this.sustainedVoiceKeys.clear();

    this.activeVoices.forEach((voices) => {
      const vArray = Array.isArray(voices) ? voices : [voices];
      vArray.forEach(voice => {
        try {
          if (voice.gainNode) {
            // Short fade from the envelope's current level — an instant jump
            // to near-zero produces an audible click.
            const peak = Math.max(this.envelopeLevelAt(voice, now), voice.env ? voice.env.v0 : 0.0001);
            voice.gainNode.gain.cancelScheduledValues(now);
            voice.gainNode.gain.setValueAtTime(peak, now);
            voice.gainNode.gain.linearRampToValueAtTime(0, now + 0.015);
          }
          if (voice.osc) {
            voice.osc.stop(now + 0.02);
            if (voice.lfos) {
              voice.lfos.forEach((l) => {
                try { l.osc.stop(now + 0.02); } catch (e) {}
                try { l.osc.disconnect(); } catch (e) {}
                try { l.depth.disconnect(); } catch (e) {}
              });
            }
            try { voice.osc.disconnect(); } catch (e) {}
            try { if (voice.filter) voice.filter.disconnect(); } catch (e) {}
            try { if (voice.gainNode) voice.gainNode.disconnect(); } catch (e) {}
          }
        } catch (e) {}
      });
    });
    this.activeVoices.clear();

    if (this.onVoiceChange) {
      this.onVoiceChange(0, null, false);
    }
  }
}

class MidiParser {
  static parse(arrayBuffer) {
    const data = new DataView(arrayBuffer);
    let offset = 0;

    function readString(len) {
      let str = "";
      for (let i = 0; i < len && offset < arrayBuffer.byteLength; i++) {
        str += String.fromCharCode(data.getUint8(offset++));
      }
      return str;
    }

    function readUint16() {
      if (offset + 2 > arrayBuffer.byteLength) return 0;
      const val = data.getUint16(offset, false); // Big endian for MIDI files
      offset += 2;
      return val;
    }

    function readUint32() {
      if (offset + 4 > arrayBuffer.byteLength) return 0;
      const val = data.getUint32(offset, false); // Big endian for MIDI files
      offset += 4;
      return val;
    }

    function readUint8() {
      if (offset >= arrayBuffer.byteLength) return 0;
      return data.getUint8(offset++);
    }

    function readVLQ() {
      let value = 0;
      let count = 0;
      while (offset < arrayBuffer.byteLength && count < 4) {
        const byte = readUint8();
        value = (value << 7) | (byte & 0x7F);
        count++;
        if (!(byte & 0x80)) {
          break;
        }
      }
      return value;
    }

    let headerType = readString(4);
    if (headerType !== "MThd") {
      // Look for "MThd" elsewhere in the first 2048 bytes (e.g., RIFF/RMID wrappers or ID3/junk headers)
      let found = false;
      const scanLimit = Math.min(arrayBuffer.byteLength - 4, 2048);
      for (let i = 0; i < scanLimit; i++) {
        if (data.getUint8(i) === 0x4D && // 'M'
            data.getUint8(i + 1) === 0x54 && // 'T'
            data.getUint8(i + 2) === 0x68 && // 'h'
            data.getUint8(i + 3) === 0x64) {  // 'd'
          offset = i + 4;
          headerType = "MThd";
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error("Invalid MIDI file: Missing MThd header");
      }
    }

    const headerLength = readUint32();
    const format = readUint16();
    const numTracks = readUint16();
    const division = readUint16();

    // Skip extra header bytes if headerLength > 6
    if (headerLength > 6) {
      offset += (headerLength - 6);
    }

    // division: if MSB is 0, it's ticks per beat (quarter note)
    if (division & 0x8000) {
      throw new Error("SMPTE division format in MIDI files is not supported.");
    }
    const ticksPerBeat = division || 480;

    const tracks = [];

    // Parse each track
    while (offset < arrayBuffer.byteLength - 8 && tracks.length < numTracks) {
      const trackType = readString(4);
      if (trackType !== "MTrk") {
        if (offset + 4 > arrayBuffer.byteLength) break;
        const size = readUint32();
        offset = Math.min(offset + size, arrayBuffer.byteLength);
        continue;
      }

      const trackSize = readUint32();
      const trackEnd = Math.min(offset + trackSize, arrayBuffer.byteLength);
      const events = [];
      let ticks = 0;
      let lastStatus = 0; // for running status

      while (offset < trackEnd) {
        if (offset >= arrayBuffer.byteLength) break;
        const deltaTime = readVLQ();
        ticks += deltaTime;

        if (offset >= arrayBuffer.byteLength) break;
        let status = readUint8();

        // Running status handling
        if ((status & 0x80) === 0) {
          if (lastStatus === 0) {
            throw new Error("Invalid MIDI: Running status used without previous status");
          }
          status = lastStatus;
          offset--; // backup so we can parse the data byte normally
        }

        const command = status & 0xF0;
        const channel = status & 0x0F;

        if (command >= 0x80 && command <= 0xEF) {
          lastStatus = status;
          if (offset >= arrayBuffer.byteLength) break;
          const data1 = readUint8();
          let data2 = 0;
          if (command !== 0xC0 && command !== 0xD0) {
            if (offset < arrayBuffer.byteLength) {
              data2 = readUint8();
            }
          }
          events.push({
            ticks: ticks,
            status: status,
            command: command,
            channel: channel,
            data1: data1,
            data2: data2
          });
        } else if (status === 0xFF) {
          // Meta Event clears running status per SMF spec
          lastStatus = 0;
          if (offset >= arrayBuffer.byteLength) break;
          const metaType = readUint8();
          const length = readVLQ();
          const safeLen = Math.min(length, arrayBuffer.byteLength - offset);
          const metaData = new Uint8Array(arrayBuffer, offset, safeLen);
          offset += safeLen;
          events.push({
            ticks: ticks,
            status: 0xFF,
            metaType: metaType,
            metaData: metaData
          });
        } else if (status === 0xF0 || status === 0xF7) {
          // SysEx clears running status
          lastStatus = 0;
          const length = readVLQ();
          offset = Math.min(offset + length, arrayBuffer.byteLength);
        } else {
          // Skip other status
        }
      }

      tracks.push(events);
    }

    return {
      format: format,
      ticksPerBeat: ticksPerBeat,
      tracks: tracks
    };
  }
}

function convertMidiToTimeline(parsedMidi) {
  const ticksPerBeat = parsedMidi.ticksPerBeat || 480;
  const allEvents = [];

  parsedMidi.tracks.forEach((track, trackIndex) => {
    track.forEach(event => {
      allEvents.push({
        ...event,
        trackIndex: trackIndex
      });
    });
  });

  // Sort by ticks primarily
  allEvents.sort((a, b) => a.ticks - b.ticks);

  let currentTicks = 0;
  let currentTimeMs = 0;
  let currentUsPerBeat = 500000; // 120 BPM default

  allEvents.forEach(event => {
    const deltaTicks = event.ticks - currentTicks;
    if (deltaTicks > 0) {
      currentTimeMs += (deltaTicks / ticksPerBeat) * (currentUsPerBeat / 1000);
      currentTicks = event.ticks;
    }
    event.timeMs = currentTimeMs;

    if (event.status === 0xFF && event.metaType === 0x51) {
      // Set Tempo Meta Event
      const data = event.metaData;
      if (data && data.length >= 3) {
        currentUsPerBeat = (data[0] << 16) | (data[1] << 8) | data[2];
      }
    }
  });

  // Sort by timeMs to guarantee strict chronological ordering
  allEvents.sort((a, b) => a.timeMs - b.timeMs);
  return allEvents;
}

class MidiSequencer {
  constructor(app) {
    this.app = app;
    this.timeline = [];
    this.isPlaying = false;
    this.playheadMs = 0;
    this.audioStartTime = 0; // ctx.currentTime that corresponds to playheadMs == 0
    this.timerId = null;
    this.durationMs = 0;
    this.fileName = "";
    this.onProgress = null; // Callback for UI updates (e.g., progress slider)
    this.onEnded = null;
    this.nextEventIndex = 0;
    // Lookahead scheduling: a timer wakes up every tickMs and dispatches every
    // event that falls within lookaheadSec of the AUDIO clock, scheduling voices
    // at their exact WebAudio times. This replaces a requestAnimationFrame loop,
    // which stopped entirely whenever the WebView was hidden and quantized note
    // timing to display frames.
    this.lookaheadSec = 0.15;
    this.tickMs = 25;

    // When hidden, timer wakeups can be throttled by the platform; widen the
    // horizon so playback continues seamlessly in the background.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.lookaheadSec = 2.0;
        this.tickMs = 200;
      } else {
        this.lookaheadSec = 0.15;
        this.tickMs = 25;
      }
    });
  }

  loadMidi(arrayBuffer, fileName) {
    this.stop();
    this.fileName = fileName;
    try {
      const parsed = MidiParser.parse(arrayBuffer);
      this.timeline = convertMidiToTimeline(parsed);
      this.durationMs = this.timeline.length > 0 ? this.timeline[this.timeline.length - 1].timeMs : 0;
      this.nextEventIndex = 0;
      this.playheadMs = 0;
      return true;
    } catch (e) {
      console.error("MIDI Load Error:", e);
      return false;
    }
  }

  play() {
    if (this.isPlaying || this.timeline.length === 0) return;
    if (!this.app.synth.ctx) this.app.synth.initAudio();
    const ctx = this.app.synth.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    this.isPlaying = true;
    this.audioStartTime = ctx.currentTime - this.playheadMs / 1000;
    this.tick();
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    const ctx = this.app.synth.ctx;
    if (ctx) {
      this.playheadMs = Math.min(
        this.durationMs,
        Math.max(0, (ctx.currentTime - this.audioStartTime) * 1000)
      );
    }
    this.app.synth.stopAll();
  }

  stop() {
    this.pause();
    this.playheadMs = 0;
    this.nextEventIndex = 0;
    this.app.synth.stopAll();
    if (this.onProgress) {
      this.onProgress(0, this.durationMs);
    }
  }

  seek(timeMs) {
    const wasPlaying = this.isPlaying;
    this.pause();
    this.playheadMs = Math.max(0, Math.min(timeMs, this.durationMs));

    // Reconstruct controller state by replaying CCs up to the seek point.
    // Program Change / Bank Select are applied through controllerChange /
    // programChange, which themselves respect the "Lock Channel Patches" toggle.
    this.nextEventIndex = 0;
    while (this.nextEventIndex < this.timeline.length && this.timeline[this.nextEventIndex].timeMs < this.playheadMs) {
      const event = this.timeline[this.nextEventIndex];
      if (event.command === 0xB0) {
        this.app.synth.controllerChange(event.channel, event.data1, event.data2);
      } else if (event.command === 0xC0) {
        this.app.synth.programChange(event.channel, event.data1);
      }
      this.nextEventIndex++;
    }

    if (this.onProgress) {
      this.onProgress(this.playheadMs, this.durationMs);
    }

    if (wasPlaying) {
      this.play();
    }
  }

  tick() {
    if (!this.isPlaying) return;
    const ctx = this.app.synth.ctx;
    if (!ctx) {
      this.timerId = setTimeout(() => this.tick(), this.tickMs);
      return;
    }

    const nowAudio = ctx.currentTime;
    const playheadMs = (nowAudio - this.audioStartTime) * 1000;
    this.playheadMs = Math.max(0, playheadMs);

    // Dispatch every event inside the lookahead window at its exact audio time.
    const horizon = nowAudio + this.lookaheadSec;
    while (this.nextEventIndex < this.timeline.length) {
      const event = this.timeline[this.nextEventIndex];
      const eventAudioTime = this.audioStartTime + event.timeMs / 1000;
      if (eventAudioTime > horizon) break;
      this.dispatchEvent(event, Math.max(eventAudioTime, nowAudio));
      this.nextEventIndex++;
    }

    if (this.nextEventIndex >= this.timeline.length && playheadMs >= this.durationMs) {
      this.playheadMs = this.durationMs;
      if (this.onProgress && !document.hidden) {
        this.onProgress(this.playheadMs, this.durationMs);
      }
      this.stop();
      if (this.onEnded) this.onEnded();
      return;
    }

    if (this.onProgress && !document.hidden) {
      this.onProgress(this.playheadMs, this.durationMs);
    }

    this.timerId = setTimeout(() => this.tick(), this.tickMs);
  }

  dispatchEvent(event, atTime) {
    if (event.status === 0xFF) return; // meta events only matter at load time

    const command = event.command;
    const channel = event.channel;

    if (command === 0x90 && event.data2 > 0) {
      this.app.synth.noteOn(channel, event.data1, event.data2, atTime);
      this.app.highlightKey(event.data1, true);
    } else if (command === 0x80 || (command === 0x90 && event.data2 === 0)) {
      this.app.synth.noteOff(channel, event.data1, atTime);
      this.app.highlightKey(event.data1, false);
    } else {
      // CC / PC / bend go through the shared handler for logging + UI sync.
      this.app.handleMidiMessage({ data: [event.status, event.data1, event.data2] }, "Sequencer");
    }
  }
}

// Global Application Controller
class App {
  constructor() {
    this.synth = new SpessaSynthEngine((count, channel, isActive) => {
      this.updateTelemetry(count, channel, isActive);
    });
    this.sequencer = new MidiSequencer(this);
    this.midiAccess = null;
    this.isMidiEnabled = true;
    this.baseOctave = 4; // C4
    this.selectedChannel = "all";
    this.channelVoiceCounts = new Array(16).fill(0);
    this._engineRunning = false;

    this.initDOMReferences();
    this.bindEvents();
    this.buildKeyboard();
    this.populatePresetsUI([], "");
    // Load the startup bank right away so the app opens with the bundled (or
    // cached) SoundFont instead of an empty patch list.
    this.initSoundFont();
  }

  // Resolve the startup SoundFont once: the IndexedDB-cached bank if present,
  // otherwise the bundled bank. Guarded so the Start button re-entering this
  // path never triggers a second load.
  initSoundFont() {
    if (!this._soundFontLoadPromise) {
      this._soundFontLoadPromise = (async () => {
        try {
          this.logMidi("[System] Checking for cached SoundFont in offline storage...");
          const cachedSf = await loadSoundFontFromDB();
          if (cachedSf && cachedSf.data) {
            this.logMidi(`[System] Found cached SoundFont: ${cachedSf.name}. Loading...`);
            const ok = await this.activateSoundFont(cachedSf.data, cachedSf.name);
            if (ok) return;
            this.logMidi("[System] Cached SoundFont is not usable; falling back to the bundled bank.");
          }
        } catch (err) {
          this.logMidi(`[System] Offline storage read failed: ${err.message}. Loading default...`);
        }
        await this.loadBundledSoundFont();
      })();
    }
    return this._soundFontLoadPromise;
  }

  initDOMReferences() {
    this.btnStartAudio = document.getElementById("btnStartAudio");
    this.statusBadge = document.getElementById("statusBadge");
    this.statusText = document.getElementById("statusText");
    this.midiToggle = document.getElementById("midiToggle");
    this.midiStatusDesc = document.getElementById("midiStatusDesc");
    this.presetSelect = document.getElementById("presetSelect");
    this.sfName = document.getElementById("sfName");
    this.presetCountTag = document.getElementById("presetCountTag");
    this.sfFileInput = document.getElementById("sfFileInput");
    this.volumeSlider = document.getElementById("volumeSlider");
    this.volVal = document.getElementById("volVal");
    this.channelSelect = document.getElementById("channelSelect");
    this.pianoContainer = document.getElementById("pianoContainer");
    this.btnOctaveDown = document.getElementById("btnOctaveDown");
    this.btnOctaveUp = document.getElementById("btnOctaveUp");
    this.octaveLabel = document.getElementById("octaveLabel");
    this.midiLog = document.getElementById("midiLog");
    this.portCount = document.getElementById("portCount");
    this.activeVoicesVal = document.getElementById("activeVoicesVal");
    this.engineLoadVal = document.getElementById("engineLoadVal");
    this.activePatchDisplay = document.getElementById("activePatchDisplay");

    // Reverb and cache elements
    this.reverbMixSlider = document.getElementById("reverbMixSlider");
    this.reverbMixVal = document.getElementById("reverbMixVal");
    this.reverbDecaySlider = document.getElementById("reverbDecaySlider");
    this.reverbDecayVal = document.getElementById("reverbDecayVal");
    this.reverbStatus = document.getElementById("reverbStatus");
    this.btnClearCache = document.getElementById("btnClearCache");

    // MIDI Player elements
    this.playerStatus = document.getElementById("playerStatus");
    this.midiFileInput = document.getElementById("midiFileInput");
    this.midiFileName = document.getElementById("midiFileName");
    this.midiTimeDisplay = document.getElementById("midiTimeDisplay");
    this.midiProgressSlider = document.getElementById("midiProgressSlider");
    this.btnMidiPlay = document.getElementById("btnMidiPlay");
    this.btnMidiStop = document.getElementById("btnMidiStop");
  }

  bindEvents() {
    this.btnStartAudio.addEventListener("click", () => this.toggleAudioEngine());

    this.midiToggle.addEventListener("change", (e) => {
      this.isMidiEnabled = e.target.checked;
      this.handleMidiToggleChange();
    });

    this.presetSelect.addEventListener("change", (e) => {
      const val = e.target.value;
      if (!val) return;
      const [bank, program] = val.split("_").map(Number);
      
      if (this.selectedChannel === "all") {
        for (let ch = 0; ch < 16; ch++) {
          this.synth.setChannelPatch(ch, bank, program);
        }
        this.logMidi(`[All Channels] User Assigned Patch -> Bank ${bank}, Patch ${program}`);
      } else {
        const channel = parseInt(this.selectedChannel);
        this.synth.setChannelPatch(channel, bank, program);
        this.logMidi(`[Ch ${channel + 1}] User Assigned Patch -> Bank ${bank}, Patch ${program}`);
      }
      
      const selectedOption = this.presetSelect.options[this.presetSelect.selectedIndex];
      if (selectedOption && this.activePatchDisplay) {
        this.activePatchDisplay.textContent = selectedOption.textContent;
      }

      this.refreshChannelPatchList();
    });

    this.sfFileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (evt) => {
          this.logMidi(`Loading custom SoundFont: ${file.name}`);
          const arrayBuffer = evt.target.result;
          const ok = await this.activateSoundFont(arrayBuffer, file.name);
          if (!ok) {
            this.logMidi(`[Error] "${file.name}" contains no usable presets (no zones or no sample data).`);
            return;
          }

          // Cache in IndexedDB so it's persisted across sessions
          this.logMidi(`Caching SoundFont to device storage...`);
          try {
            await saveSoundFontToDB(file.name, arrayBuffer);
            this.logMidi(`SoundFont cached successfully in offline storage!`);
          } catch (err) {
            this.logMidi(`[Warning] Could not cache to storage: ${err.message}`);
          }
        };
        reader.onerror = (err) => {
          console.error("FileReader error:", reader.error);
          this.logMidi(`[SoundFont Error] Could not read file: ${reader.error?.message || "Read error"}`);
          alert("Error reading SoundFont file. Please check file permissions.");
        };
        reader.readAsArrayBuffer(file);
      }
      e.target.value = "";
    });

    // Clicking "Soundfont & Active Patch" header or the active patch card opens the SoundFont bank file picker
    const triggerLoadBank = () => {
      if (this.sfFileInput) {
        this.sfFileInput.value = "";
        this.sfFileInput.click();
      }
    };
    const soundfontCardTitle = document.getElementById("soundfontCardTitle");
    const patchActiveCard = document.getElementById("patchActiveCard");
    if (soundfontCardTitle) {
      soundfontCardTitle.addEventListener("click", triggerLoadBank);
    }
    if (patchActiveCard) {
      patchActiveCard.addEventListener("click", triggerLoadBank);
    }

    // Clear Cache Action
    if (this.btnClearCache) {
      this.btnClearCache.addEventListener("click", async () => {
        this.logMidi("[System] Clearing memory caches and custom offline SoundFont...");
        
        // 1. Stop all active playing notes
        this.synth.stopAll();
        
        // 2. Clear decoded in-memory AudioBuffer cache
        if (this.synth.currentSoundFont && this.synth.currentSoundFont.bufferCache) {
          this.synth.currentSoundFont.bufferCache.clear();
        }
        
        // 3. Clear IndexedDB storage
        try {
          await clearSoundFontDB();
          this.logMidi("[System] Device storage cache successfully cleared.");
        } catch (err) {
          this.logMidi(`[Warning] Could not clear offline storage: ${err.message}`);
        }
        
        // 4. Fallback to default SoundFont to maintain synth playability
        await this.loadBundledSoundFont();
      });
    }

    // Reverb controls bindings
    if (this.reverbMixSlider) {
      this.reverbMixSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        if (this.reverbMixVal) {
          this.reverbMixVal.textContent = Math.round(val * 100) + "%";
        }
        this.synth.setReverbMix(val);
        if (this.reverbStatus) {
          this.reverbStatus.textContent = val > 0 ? `${Math.round(val * 100)}% Mix` : "Disabled";
        }
      });
    }

    if (this.reverbDecaySlider) {
      this.reverbDecaySlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        if (this.reverbDecayVal) {
          this.reverbDecayVal.textContent = val.toFixed(1) + "s";
        }
      });

      this.reverbDecaySlider.addEventListener("change", (e) => {
        const val = parseFloat(e.target.value);
        this.synth.setReverbDecay(val);
        this.logMidi(`Reverb decay time changed to ${val.toFixed(1)}s`);
      });
    }

    this.volumeSlider.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      this.volVal.textContent = Math.round(val * 100) + "%";
      this.synth.setVolume(val);
    });

    this.channelSelect.addEventListener("change", (e) => {
      this.selectChannelAndSync(e.target.value);
    });

    // Bind click events on channel boxes to select them
    document.querySelectorAll(".channel-box").forEach(box => {
      box.addEventListener("click", () => {
        const ch = parseInt(box.dataset.ch);
        this.selectChannelAndSync(ch);
      });
    });

    // Bind toggle for ignoring MIDI file program changes
    const ignoreMidiProgramsToggle = document.getElementById("ignoreMidiProgramsToggle");
    if (ignoreMidiProgramsToggle) {
      ignoreMidiProgramsToggle.addEventListener("change", (e) => {
        this.synth.setIgnoreMidiProgramChanges(e.target.checked);
        this.logMidi(`[Synth] Lock Channel Patches: ${e.target.checked ? "ENABLED" : "DISABLED"}`);
      });
    }

    this.btnOctaveDown.addEventListener("click", () => {
      if (this.baseOctave > 1) {
        this.baseOctave--;
        this.updateOctaveUI();
      }
    });

    this.btnOctaveUp.addEventListener("click", () => {
      if (this.baseOctave < 7) {
        this.baseOctave++;
        this.updateOctaveUI();
      }
    });

    // Panic / Mute Button
    const btnPanic = document.getElementById("btnPanic");
    if (btnPanic) {
      btnPanic.addEventListener("click", () => {
        if (window.emergencyStopSynth) {
          window.emergencyStopSynth();
        }
        this.logMidi(`[PANIC] All 16 channels silenced. All active notes cut.`);
      });
    }

    // MIDI File Player Event Listeners & Callbacks
    if (this.midiFileInput) {
      this.midiFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
          this.logMidi(`[Player] Reading MIDI file: ${file.name} (${file.size} bytes)...`);
          const reader = new FileReader();
          reader.onload = (evt) => {
            this.logMidi(`[Player] Parsing MIDI file: ${file.name}...`);
            const success = this.sequencer.loadMidi(evt.target.result, file.name);
            if (success) {
              if (this.midiFileName) this.midiFileName.textContent = file.name;
              if (this.btnMidiPlay) this.btnMidiPlay.disabled = false;
              if (this.btnMidiStop) this.btnMidiStop.disabled = false;
              if (this.midiProgressSlider) {
                this.midiProgressSlider.disabled = false;
                this.midiProgressSlider.value = 0;
              }
              if (this.playerStatus) this.playerStatus.textContent = "Loaded";
              this.logMidi(`[Player] MIDI file parsed and loaded. Duration: ${this.formatTime(this.sequencer.durationMs)}`);
            } else {
              this.logMidi(`[Player Error] Failed to parse or read MIDI file.`);
              alert("Error parsing MIDI. Please verify it is a valid Standard MIDI File (SMF).");
            }
          };
          reader.onerror = (err) => {
            console.error("FileReader error:", reader.error);
            this.logMidi(`[Player Error] Could not read file: ${reader.error?.message || "Read error"}`);
            alert("Error reading MIDI file. Please check file permissions.");
          };
          reader.readAsArrayBuffer(file);
        }
        e.target.value = "";
      });
    }

    if (this.btnMidiPlay) {
      this.btnMidiPlay.addEventListener("click", async () => {
        await this.ensureEngineRunning(); // Assure audio context is active
        if (this.sequencer.isPlaying) {
          this.sequencer.pause();
          this.btnMidiPlay.textContent = "▶ Play";
          if (this.playerStatus) this.playerStatus.textContent = "Paused";
          this.logMidi("[Player] Playback paused.");
        } else {
          this.sequencer.play();
          this.btnMidiPlay.textContent = "⏸ Pause";
          if (this.playerStatus) this.playerStatus.textContent = "Playing";
          this.logMidi("[Player] Playback started.");
        }
      });
    }

    if (this.btnMidiStop) {
      this.btnMidiStop.addEventListener("click", () => {
        this.sequencer.stop();
        if (this.btnMidiPlay) this.btnMidiPlay.textContent = "▶ Play";
        if (this.playerStatus) this.playerStatus.textContent = "Stopped";
        this.logMidi("[Player] Playback stopped and reset.");
      });
    }

    if (this.midiProgressSlider) {
      let dragging = false;
      this.midiProgressSlider.addEventListener("pointerdown", () => { dragging = true; });
      this.midiProgressSlider.addEventListener("pointerup", () => { dragging = false; });
      this.midiProgressSlider.addEventListener("input", (e) => {
        const percent = parseFloat(e.target.value);
        const targetMs = (percent / 100) * this.sequencer.durationMs;
        this.sequencer.seek(targetMs);
      });
      // While the user is dragging, onProgress must not fight the thumb position.
      this._progressSliderDragging = () => dragging;
    }

    if (this.sequencer) {
      this.sequencer.onProgress = (currentMs, totalMs) => {
        if (this.midiTimeDisplay) {
          this.midiTimeDisplay.textContent = `${this.formatTime(currentMs)} / ${this.formatTime(totalMs)}`;
        }
        if (this.midiProgressSlider && totalMs > 0 && !(this._progressSliderDragging && this._progressSliderDragging())) {
          this.midiProgressSlider.value = (currentMs / totalMs) * 100;
        }
      };

      this.sequencer.onEnded = () => {
        if (this.btnMidiPlay) this.btnMidiPlay.textContent = "▶ Play";
        if (this.playerStatus) this.playerStatus.textContent = "Finished";
        this.logMidi("[Player] Playback finished.");
      };
    }
  }

  formatTime(ms) {
    if (isNaN(ms) || ms < 0) return "00:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  updateTelemetry(voiceCount, channel, isActive) {
    if (this.activeVoicesVal) {
      this.activeVoicesVal.textContent = voiceCount;
    }

    if (this.engineLoadVal) {
      // Real polyphony utilization instead of a fabricated figure.
      const load = Math.min(100, Math.round((voiceCount / this.synth.maxPolyphony) * 100));
      this.engineLoadVal.textContent = `${load}%`;
    }

    if (channel !== null && channel !== undefined) {
      const box = document.querySelector(`.channel-box[data-ch="${channel}"]`);
      if (box) {
        if (isActive) {
          box.classList.add("active");
        } else {
          // Keep active if other voices on channel remain
          let channelHasVoice = false;
          for (let v of this.synth.activeVoices.values()) {
            if (Array.isArray(v)) {
              if (v.some(item => item.channel === channel)) {
                channelHasVoice = true;
                break;
              }
            } else if (v && v.channel === channel) {
              channelHasVoice = true;
              break;
            }
          }
          if (!channelHasVoice) {
            box.classList.remove("active");
          }
        }
      }
    } else {
      document.querySelectorAll(".channel-box").forEach(b => b.classList.remove("active"));
    }
  }

  // Parse a SoundFont, decode its samples (SF3), and populate the UI once the
  // bank is actually playable. Returns true when a usable bank was loaded.
  async activateSoundFont(arrayBuffer, fileName) {
    const presets = this.synth.loadSoundBank(arrayBuffer, fileName);
    if (presets.length === 0) {
      this.populatePresetsUI(presets, fileName);
      return false;
    }

    if (this.synth.currentSoundFont && this.synth.currentSoundFont.compressed) {
      this.logMidi(`[System] "${fileName}" uses compressed SF3 samples; decoding Ogg Vorbis data...`);
      let lastPct = -1;
      await this.synth.decodeAllSamples((done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 10) * 10 : 100;
        if (pct > lastPct) {
          lastPct = pct;
          this.logMidi(`[System] Decoding samples: ${pct}% (${done}/${total})`);
        }
      });
      const cached = this.synth.currentSoundFont.bufferCache.size;
      if (cached === 0) {
        this.logMidi(`[Error] Could not decode any SF3 samples in "${fileName}".`);
        this.synth.loadSoundBank(new ArrayBuffer(0), fileName); // reset to empty
        this.populatePresetsUI([], fileName);
        return false;
      }
    }

    this.populatePresetsUI(presets, fileName);

    // Give every channel its own voice out of the box: sequential melodic
    // patches across channels 1-16, drum kit on channel 10.
    if (this.synth.autoMapChannels()) {
      this.logMidi("[System] Channels auto-mapped: sequential bank patches on Ch 1-16, drum kit on Ch 10.");
      this.selectChannelAndSync(this.selectedChannel);
    }
    return true;
  }

  async loadBundledSoundFont() {
    this.logMidi("[System] Checking bundled SoundFont...");
    for (const name of this.bundledSoundFontNames()) {
      try {
        const response = await fetch(name);
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        const ok = await this.activateSoundFont(buffer, name);
        if (ok) {
          this.logMidi(`[System] Bundled SoundFont "${name}" loaded successfully!`);
          return;
        }
        this.logMidi(`[System] Bundled "${name}" contains no usable presets.`);
        return;
      } catch (err) {
        this.logMidi(`[Warning] Could not load bundled "${name}": ${err.message}`);
      }
    }
    this.logMidi("[System] No usable bundled SoundFont found. Tap 'Soundfont & Active Patch' to load a .sf2/.sf3 bank.");
  }

  bundledSoundFontNames() {
    return ["FluidR3Mono_GM.sf3", "soundfont.sf2", "soundfont.sf3"];
  }

  async startAudioEngine() {
    await this.synth.initAudio();
    this.setEngineRunning(true);
    this.logMidi("[System] WebAudio SoundFont engine context running.");

    // The startup bank (bundled or cached) is already loading since app init;
    // make sure it has finished before reporting readiness.
    await this.initSoundFont();

    if (this.isMidiEnabled && !this.midiAccess) {
      this.initWebMIDI();
    }

    this.notifyNativeBridge("Audio Engine Active & Running");
  }

  async stopAudioEngine() {
    this.sequencer.stop();
    this.synth.stopAll();
    await this.synth.suspendAudio();
    if (this.btnMidiPlay) this.btnMidiPlay.textContent = "▶ Play";
    if (this.playerStatus) this.playerStatus.textContent = "Stopped";
    this.setEngineRunning(false);
    this.stopNativeBridge();
    this.logMidi("[System] Audio engine stopped. Notes silenced, context suspended, service released.");
  }

  async toggleAudioEngine() {
    if (this._engineRunning) {
      await this.stopAudioEngine();
    } else {
      await this.startAudioEngine();
    }
  }

  // Called from implicit activation paths (on-screen keys, MIDI player): runs
  // the full start sequence once; afterwards it only keeps the context live.
  async ensureEngineRunning() {
    if (this._engineRunning) {
      await this.synth.initAudio();
      return;
    }
    await this.startAudioEngine();
  }

  setEngineRunning(running) {
    this._engineRunning = running;
    if (running) {
      this.btnStartAudio.classList.add("running");
      this.btnStartAudio.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        Audio Engine Active
      `;
      this.statusBadge.classList.add("active");
      this.statusText.textContent = "Audio Active";
    } else {
      this.btnStartAudio.classList.remove("running");
      this.btnStartAudio.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        Start Audio Engine
      `;
      this.statusBadge.classList.remove("active");
      this.statusText.textContent = "Audio Idle";
    }
  }

  populatePresetsUI(presets, sfName = "") {
    this.sfName.textContent = sfName || "No SoundFont Loaded";
    this.presetCountTag.textContent = `${presets.length} Presets`;
    this.presetSelect.innerHTML = "";

    if (presets.length > 0) {
      this.presetSelect.disabled = presets.length <= 1;
      // Present patches in (bank, program) order — the same order the channel
      // auto-mapping uses — instead of the bank's raw (often scrambled) order,
      // skipping duplicate (bank, program) entries which would collide as
      // duplicate option values.
      const seen = new Set();
      const sorted = [...presets]
        .filter((p) => {
          const key = `${p.bank}_${p.program}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => (a.bank - b.bank) || (a.program - b.program));
      sorted.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = `${p.bank}_${p.program}`;
        opt.textContent = `${String(p.program).padStart(3, '0')}: ${p.name}`;
        this.presetSelect.appendChild(opt);
      });

      this.logMidi(`SoundFont loaded: ${presets.length} instrument patches ready.`);
    } else {
      this.presetSelect.disabled = true;
      this.presetSelect.innerHTML = `<option value="">No Presets Loaded</option>`;
      if (this.activePatchDisplay) {
        this.activePatchDisplay.textContent = "No Active Patch";
      }
    }
    this.selectChannelAndSync(this.selectedChannel);
  }

  selectChannelAndSync(channelVal) {
    this.selectedChannel = channelVal === "all" ? "all" : parseInt(channelVal);
    
    if (this.channelSelect) {
      this.channelSelect.value = String(channelVal);
    }

    document.querySelectorAll(".channel-box").forEach(box => {
      const boxCh = parseInt(box.dataset.ch);
      if (this.selectedChannel !== "all" && boxCh === this.selectedChannel) {
        box.classList.add("selected");
      } else {
        box.classList.remove("selected");
      }
    });

    const targetLabel = document.getElementById("patchTargetChannelLabel");
    if (targetLabel) {
      if (this.selectedChannel === "all") {
        targetLabel.textContent = "Target Channel: All Channels (Omni)";
      } else {
        targetLabel.textContent = `Target Channel: Channel ${this.selectedChannel + 1}`;
      }
    }

    const activeCh = this.selectedChannel === "all" ? 0 : this.selectedChannel;
    const prog = this.synth.channelPrograms[activeCh] || 0;
    const bank = this.synth.channelBanks[activeCh] || 0;

    // Channel 10 is percussion: mirror the engine's bank-128 preference so the
    // dropdown reflects the kit that will actually play.
    let matchingOption = null;
    if (activeCh === 9) {
      matchingOption = Array.from(this.presetSelect.options).find(opt => opt.value === `128_${prog}`)
                   || Array.from(this.presetSelect.options).find(opt => opt.value.startsWith("128_"));
    }
    if (!matchingOption) {
      const targetValue = `${bank}_${prog}`;
      matchingOption = Array.from(this.presetSelect.options).find(opt => opt.value === targetValue)
                   || Array.from(this.presetSelect.options).find(opt => opt.value.endsWith(`_${prog}`));
    }

    if (matchingOption) {
      this.presetSelect.value = matchingOption.value;
      if (this.activePatchDisplay) {
        this.activePatchDisplay.textContent = matchingOption.textContent;
      }
    } else {
      if (this.activePatchDisplay) {
        this.activePatchDisplay.textContent = this.getPatchName(bank, prog, activeCh);
      }
    }

    this.refreshChannelPatchList();
  }

  getPatchName(bank, program, channel) {
    if (!this.synth.soundBankManager.presets || this.synth.soundBankManager.presets.length === 0) {
      return "None";
    }
    const presets = this.synth.soundBankManager.presets;
    let preset = null;
    if (channel === 9) {
      preset = presets.find(p => p.bank === 128 && p.program === program)
            || presets.find(p => p.bank === 128 && p.program === 0);
    }
    if (!preset) {
      preset = presets.find(p => p.program === program && p.bank === bank)
            || presets.find(p => p.program === program)
            || presets[0];
    }
    return preset ? `${String(preset.program).padStart(3, '0')}: ${preset.name}` : "Unknown";
  }

  // Coalesce rebuilds: CC streams during playback can otherwise trigger dozens
  // of full 16-row DOM rebuilds per second.
  refreshChannelPatchList() {
    if (this._patchListRefreshScheduled) return;
    this._patchListRefreshScheduled = true;
    setTimeout(() => {
      this._patchListRefreshScheduled = false;
      this.renderChannelPatchList();
    }, 200);
  }

  renderChannelPatchList() {
    const listEl = document.getElementById("channelPatchList");
    if (!listEl) return;
    listEl.innerHTML = "";

    for (let ch = 0; ch < 16; ch++) {
      const prog = this.synth.channelPrograms[ch];
      const bank = this.synth.channelBanks[ch];
      const isSelected = this.selectedChannel !== "all" && parseInt(this.selectedChannel) === ch;
      const patchName = this.getPatchName(bank, prog, ch);

      const item = document.createElement("div");
      item.style.padding = "6px 8px";
      item.style.borderRadius = "8px";
      item.style.background = isSelected ? "rgba(208, 188, 255, 0.15)" : "#1C1B1F";
      item.style.border = isSelected ? "1px solid var(--primary)" : "1px solid var(--card-border)";
      item.style.color = isSelected ? "var(--primary)" : "var(--text-main)";
      item.style.cursor = "pointer";
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      item.style.alignItems = "center";
      item.style.fontSize = "0.7rem";
      item.style.transition = "all 0.15s ease";

      // Preset names come from the loaded SoundFont file: build with
      // textContent, never innerHTML, to block markup injection.
      const chLabel = document.createElement("span");
      chLabel.style.fontWeight = "800";
      chLabel.textContent = `Ch ${String(ch + 1).padStart(2, '0')}`;

      const nameLabel = document.createElement("span");
      nameLabel.style.overflow = "hidden";
      nameLabel.style.textOverflow = "ellipsis";
      nameLabel.style.whiteSpace = "nowrap";
      nameLabel.style.maxWidth = "100px";
      nameLabel.style.opacity = "0.85";
      nameLabel.textContent = patchName;

      item.appendChild(chLabel);
      item.appendChild(nameLabel);

      item.addEventListener("click", () => {
        this.selectChannelAndSync(ch);
      });

      listEl.appendChild(item);
    }
  }

  handleMidiToggleChange() {
    if (this.isMidiEnabled) {
      this.midiStatusDesc.textContent = "Listening to connected MIDI devices";
      this.logMidi("[MIDI] Virtual MIDI Input ENABLED.");
      if (this.midiAccess) {
        this.attachMidiInputs();
      } else {
        this.initWebMIDI();
      }
      this.notifyNativeBridge("Virtual MIDI Input ENABLED");
    } else {
      this.midiStatusDesc.textContent = "MIDI Input Disabled (Muted)";
      this.logMidi("[MIDI] Virtual MIDI Input DISABLED. Cutting all notes...");
      
      this.synth.stopAll();

      if (this.midiAccess) {
        for (let input of this.midiAccess.inputs.values()) {
          input.onmidimessage = null;
        }
      }
      this.notifyNativeBridge("Virtual MIDI Input DISABLED (Idle)");
    }
  }

  async initWebMIDI() {
    if (!navigator.requestMIDIAccess) {
      this.logMidi("[Warning] Web MIDI API not supported in this WebView instance.");
      return;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.logMidi("[MIDI] Web MIDI Access Granted.");
      
      this.midiAccess.onstatechange = (e) => {
        this.logMidi(`[MIDI] Port state change: ${e.port.name} -> ${e.port.state}`);
        if (this.isMidiEnabled) {
          this.attachMidiInputs();
        }
      };

      if (this.isMidiEnabled) {
        this.attachMidiInputs();
      }
    } catch (err) {
      this.logMidi(`[MIDI Error] Could not access MIDI devices: ${err.message}`);
    }
  }

  attachMidiInputs() {
    if (!this.midiAccess) return;
    let inputs = Array.from(this.midiAccess.inputs.values());
    this.portCount.textContent = `${inputs.length} Devices Connected`;

    inputs.forEach((input) => {
      input.onmidimessage = (msg) => this.handleMidiMessage(msg, input.name);
    });

    if (inputs.length > 0) {
      this.logMidi(`[MIDI] Attached to ${inputs.length} input port(s): ${inputs.map(i => i.name).join(", ")}`);
    } else {
      this.logMidi("[MIDI] No physical MIDI devices connected yet. Virtual port active.");
    }
  }

  handleMidiMessage(event, portName = "Virtual") {
    // The MIDI Interface toggle governs external INPUT; sequencer file playback
    // must keep working regardless of it.
    if (!this.isMidiEnabled && portName !== "Sequencer") return;
    // A stopped engine means no audio: drop events rather than silently
    // scheduling voices on a suspended context.
    if (!this._engineRunning) return;

    const [status, data1, data2] = event.data;
    const command = status & 0xf0;
    const channel = status & 0x0f;

    // Note-offs must never be dropped by the channel filter: if the selection
    // changes while a note is held, dropping its release leaves it ringing
    // until the watchdog fires.
    const isNoteOff = command === 0x80 || (command === 0x90 && data2 === 0);
    const isSequencer = portName === "Sequencer";

    // Skip channel filtering for Sequencer playback so multi-channel MIDI files play fully
    if (!isSequencer && this.selectedChannel !== "all" && parseInt(this.selectedChannel) !== channel && !isNoteOff) {
      return;
    }

    const logNoteEvents = !isSequencer; // avoid per-note log floods during file playback

    switch (command) {
      case 0x90: // Note On
        if (data2 > 0) {
          this.synth.noteOn(channel, data1, data2);
          this.highlightKey(data1, true);
          if (logNoteEvents) this.logMidi(`[Ch ${channel + 1}] Note On: ${this.midiNoteName(data1)} (${data1}) Vel: ${data2}`);
        } else {
          this.synth.noteOff(channel, data1);
          this.highlightKey(data1, false);
          if (logNoteEvents) this.logMidi(`[Ch ${channel + 1}] Note Off: ${this.midiNoteName(data1)} (${data1})`);
        }
        break;

      case 0x80: // Note Off
        this.synth.noteOff(channel, data1);
        this.highlightKey(data1, false);
        if (logNoteEvents) this.logMidi(`[Ch ${channel + 1}] Note Off: ${this.midiNoteName(data1)} (${data1})`);
        break;

      case 0xb0: // Control Change
        this.synth.controllerChange(channel, data1, data2);
        this.logMidi(`[Ch ${channel + 1}] CC #${data1} Val: ${data2}`);
        this.refreshChannelPatchList();
        break;

      case 0xc0: // Program Change
        this.synth.programChange(channel, data1);
        this.logMidi(`[Ch ${channel + 1}] Program Change: ${data1}`);
        if (!this.synth.ignoreMidiProgramChanges &&
            (this.selectedChannel === "all" || parseInt(this.selectedChannel) === channel)) {
          this.updatePresetDropdown(channel, data1);
        }
        this.refreshChannelPatchList();
        break;

      case 0xe0: // Pitch Bend
        this.synth.pitchBend(channel, data1, data2);
        break;
    }
  }

  updatePresetDropdown(channel, program) {
    // Channel 10 shows the percussion kit, not the melodic patch.
    for (let opt of this.presetSelect.options) {
      const [bankStr, progStr] = opt.value.split("_").map(Number);
      const matches = channel === 9
        ? bankStr === 128 && progStr === program
        : progStr === program;
      if (matches) {
        this.presetSelect.value = opt.value;
        if (this.activePatchDisplay) {
          this.activePatchDisplay.textContent = opt.textContent;
        }
        break;
      }
    }
  }

  buildKeyboard() {
    this.pianoContainer.innerHTML = "";
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const startNote = (this.baseOctave + 1) * 12; // e.g. C4 = 60
    const totalKeys = 15;

    const whiteKeys = [];
    for (let i = 0; i < totalKeys; i++) {
      const midiNote = startNote + i;
      const noteName = noteNames[midiNote % 12];
      const isBlack = noteName.includes("#");

      if (!isBlack) {
        whiteKeys.push({ midiNote, noteName });
      }
    }

    whiteKeys.forEach((k) => {
      const keyEl = document.createElement("div");
      keyEl.className = "key-white";
      keyEl.dataset.note = k.midiNote;
      keyEl.textContent = `${k.noteName}${Math.floor(k.midiNote / 12) - 1}`;

      keyEl.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const ch = this.selectedChannel === "all" ? 0 : parseInt(this.selectedChannel);
        this.ensureEngineRunning();
        this.synth.noteOn(ch, k.midiNote, 100);
        keyEl.classList.add("active");
      });

      const releaseKey = (e) => {
        e.preventDefault();
        const ch = this.selectedChannel === "all" ? 0 : parseInt(this.selectedChannel);
        this.synth.noteOff(ch, k.midiNote);
        keyEl.classList.remove("active");
      };

      keyEl.addEventListener("pointerup", releaseKey);
      keyEl.addEventListener("pointerleave", releaseKey);

      this.pianoContainer.appendChild(keyEl);
    });

    let whiteIndex = 0;
    for (let i = 0; i < totalKeys; i++) {
      const midiNote = startNote + i;
      const noteName = noteNames[midiNote % 12];
      const isBlack = noteName.includes("#");

      if (isBlack) {
        const blackEl = document.createElement("div");
        blackEl.className = "key-black";
        blackEl.dataset.note = midiNote;
        
        const leftPercent = (whiteIndex / whiteKeys.length) * 100 - 3.5;
        blackEl.style.left = `${leftPercent}%`;

        blackEl.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const ch = this.selectedChannel === "all" ? 0 : parseInt(this.selectedChannel);
          this.ensureEngineRunning();
          this.synth.noteOn(ch, midiNote, 100);
          blackEl.classList.add("active");
        });

        const releaseBlack = (e) => {
          e.preventDefault();
          const ch = this.selectedChannel === "all" ? 0 : parseInt(this.selectedChannel);
          this.synth.noteOff(ch, midiNote);
          blackEl.classList.remove("active");
        };

        blackEl.addEventListener("pointerup", releaseBlack);
        blackEl.addEventListener("pointerleave", releaseBlack);

        this.pianoContainer.appendChild(blackEl);
      } else {
        whiteIndex++;
      }
    }
  }

  updateOctaveUI() {
    // The keyboard spans 15 semitones starting at the base octave: C(base)..E(base+1)
    this.octaveLabel.textContent = `C${this.baseOctave} - E${this.baseOctave + 1}`;
    this.buildKeyboard();
  }

  highlightKey(midiNote, isActive) {
    const key = this.pianoContainer.querySelector(`[data-note="${midiNote}"]`);
    if (key) {
      if (isActive) {
        key.classList.add("active");
      } else {
        key.classList.remove("active");
      }
    }
  }

  midiNoteName(note) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return `${names[note % 12]}${Math.floor(note / 12) - 1}`;
  }

  logMidi(message) {
    const log = this.midiLog;
    const entry = document.createElement("div");
    entry.className = "log-entry";
    const time = new Date().toLocaleTimeString().split(" ")[0];
    entry.textContent = `[${time}] ${message}`;
    // Only autoscroll when the user is already at (or near) the bottom, and cap
    // history so dense event streams cannot grow the DOM unboundedly.
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(entry);
    while (log.children.length > 200) {
      log.removeChild(log.firstChild);
    }
    if (nearBottom) {
      log.scrollTop = log.scrollHeight;
    }
  }

  notifyNativeBridge(status) {
    if (window.AndroidBridge && window.AndroidBridge.startForegroundService) {
      try {
        window.AndroidBridge.startForegroundService(status);
      } catch (e) {
        console.log("Native bridge call:", e);
      }
    }
  }

  stopNativeBridge() {
    if (window.AndroidBridge && window.AndroidBridge.stopForegroundService) {
      try {
        window.AndroidBridge.stopForegroundService();
      } catch (e) {
        console.log("Native bridge stop call:", e);
      }
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.app = new App();
});

window.emergencyStopSynth = function() {
  if (window.app) {
    if (window.app.synth) {
      window.app.synth.stopAll();
    }
    if (window.app.sequencer) {
      window.app.sequencer.stop();
      if (window.app.btnMidiPlay) window.app.btnMidiPlay.textContent = "▶ Play";
      if (window.app.playerStatus) window.app.playerStatus.textContent = "Stopped";
    }
    // Reset all UI channel indicators
    const indicators = document.querySelectorAll(".channel-indicator");
    indicators.forEach(ind => ind.classList.remove("active"));
    const keys = document.querySelectorAll(".key-white.active, .key-black.active");
    keys.forEach(k => k.classList.remove("active"));
  }
};

window.addEventListener("beforeunload", () => {
  if (window.emergencyStopSynth) {
    window.emergencyStopSynth();
  }
});

window.addEventListener("pagehide", () => {
  if (window.emergencyStopSynth) {
    window.emergencyStopSynth();
  }
});

window.receiveNativeMidiBytes = function(bytes) {
  if (!window.app) return;
  let i = 0;
  while (i < bytes.length) {
    const status = bytes[i];
    if (status >= 0x80) {
      const command = status & 0xf0;
      if (command === 0xf0) {
        i++;
        continue;
      }
      
      let msgLength = 1;
      if (command === 0x80 || command === 0x90 || command === 0xa0 || command === 0xb0 || command === 0xe0) {
        msgLength = 3;
      } else if (command === 0xc0 || command === 0xd0) {
        msgLength = 2;
      }
      
      if (i + msgLength <= bytes.length) {
        const msgBytes = bytes.slice(i, i + msgLength);
        window.app.handleMidiMessage({ data: msgBytes }, "AndroidNativeVirtualMidi");
        i += msgLength;
      } else {
        break;
      }
    } else {
      i++;
    }
  }
};
