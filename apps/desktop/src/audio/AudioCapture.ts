/**
 * Capture microphone + optional system loopback, mix to 16 kHz mono PCM,
 * and stream chunks to the Electron main process.
 *
 * System audio strategy:
 * 1. Linux: PulseAudio / PipeWire sink monitor via getUserMedia (no picker)
 * 2. All platforms: Chromium display-media loopback (electron-audio-loopback)
 */
export class AudioCapture {
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mixGain: GainNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private sysAnalyser: AnalyserNode | null = null;
  private running = false;
  private targetRate = 16000;
  private meterRaf = 0;
  private onLevels: ((mic: number, system: number) => void) | null = null;

  async listMics(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput' && !isMonitorDevice(d));
  }

  async start(opts: {
    micDeviceId?: string;
    systemAudioEnabled: boolean;
    onChunk: (pcm: ArrayBuffer, micLevel: number, systemLevel: number) => void;
    onLevels?: (mic: number, system: number) => void;
  }) {
    await this.stop();
    this.running = true;
    this.onLevels = opts.onLevels ?? null;

    this.audioCtx = new AudioContext();
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    };
    if (opts.micDeviceId && opts.micDeviceId !== 'default') {
      audioConstraints.deviceId = { exact: opts.micDeviceId };
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });

    let systemSource: MediaStreamAudioSourceNode | null = null;
    if (opts.systemAudioEnabled) {
      this.systemStream = await captureSystemAudio();
      if (this.systemStream) {
        systemSource = ctx.createMediaStreamSource(this.systemStream);
      } else {
        console.warn('No system audio track; continuing with mic only');
      }
    }

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const micSource = ctx.createMediaStreamSource(this.micStream);
    this.mixGain = ctx.createGain();
    this.mixGain.gain.value = 1;

    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 2048;
    this.micAnalyser.smoothingTimeConstant = 0.3;
    this.sysAnalyser = ctx.createAnalyser();
    this.sysAnalyser.fftSize = 2048;
    this.sysAnalyser.smoothingTimeConstant = 0.3;

    micSource.connect(this.micAnalyser);
    micSource.connect(this.mixGain);
    if (systemSource) {
      systemSource.connect(this.sysAnalyser);
      systemSource.connect(this.mixGain);
    }

    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    this.mixGain.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(ctx.destination);

    const micData = new Float32Array(this.micAnalyser.fftSize);
    const sysData = new Float32Array(this.sysAnalyser.fftSize);
    let leftover = new Float32Array(0);
    let lastMic = 0;
    let lastSys = 0;

    const tickMeters = () => {
      if (!this.running || !this.micAnalyser || !this.sysAnalyser) return;
      this.micAnalyser.getFloatTimeDomainData(micData);
      lastMic = rmsFloat(micData);
      if (this.systemStream) {
        this.sysAnalyser.getFloatTimeDomainData(sysData);
        lastSys = rmsFloat(sysData);
      } else {
        lastSys = 0;
      }
      this.onLevels?.(lastMic, lastSys);
      this.meterRaf = requestAnimationFrame(tickMeters);
    };
    this.meterRaf = requestAnimationFrame(tickMeters);

    this.processor.onaudioprocess = (ev) => {
      if (!this.running || !this.audioCtx) return;
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }
      const input = ev.inputBuffer.getChannelData(0);
      const resampled = downsampleTo16k(input, this.audioCtx.sampleRate, this.targetRate);
      const merged = new Float32Array(leftover.length + resampled.length);
      merged.set(leftover);
      merged.set(resampled, leftover.length);

      const frameSize = Math.floor(this.targetRate * 0.25);
      let offset = 0;
      while (offset + frameSize <= merged.length) {
        const frame = merged.subarray(offset, offset + frameSize);
        const pcm = floatTo16BitPCM(frame);
        // Copy buffer — Int16Array.buffer can be transferred/detached by IPC.
        const copy = pcm.buffer.slice(
          pcm.byteOffset,
          pcm.byteOffset + pcm.byteLength,
        ) as ArrayBuffer;
        opts.onChunk(copy, lastMic, lastSys);
        offset += frameSize;
      }
      leftover = merged.slice(offset);
    };
  }

  async stop() {
    this.running = false;
    if (this.meterRaf) {
      cancelAnimationFrame(this.meterRaf);
      this.meterRaf = 0;
    }
    this.onLevels?.(0, 0);
    this.onLevels = null;
    try {
      this.processor?.disconnect();
    } catch {
      // ignore
    }
    this.processor = null;
    try {
      this.mixGain?.disconnect();
    } catch {
      // ignore
    }
    this.mixGain = null;
    this.micAnalyser = null;
    this.sysAnalyser = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.systemStream = null;
    if (this.audioCtx) {
      await this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }
}

/** PulseAudio / PipeWire playback monitors show up as capture devices. */
function isMonitorDevice(d: MediaDeviceInfo): boolean {
  const label = d.label || '';
  return (
    /monitor of/i.test(label) ||
    /\.monitor\b/i.test(label) ||
    /\bmonitor\b/i.test(label)
  );
}

function pickMonitorDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | null {
  const monitors = devices.filter((d) => d.kind === 'audioinput' && isMonitorDevice(d));
  if (monitors.length === 0) return null;
  // Prefer the default sink monitor when the label looks like speakers/headphones.
  const preferred =
    monitors.find((d) => /speaker|headphone|output|analog|hdmi|built-in/i.test(d.label)) ??
    monitors[0];
  return preferred;
}

async function captureViaMonitorSource(): Promise<MediaStream | null> {
  // Mic permission already granted — labels should be populated.
  const devices = await navigator.mediaDevices.enumerateDevices();
  const monitor = pickMonitorDevice(devices);
  if (!monitor?.deviceId) return null;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: monitor.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    console.info('[audio] system capture via monitor source:', monitor.label);
    return stream;
  } catch (err) {
    console.warn('Monitor source capture failed', err);
    return null;
  }
}

async function captureViaDisplayLoopback(): Promise<MediaStream | null> {
  const api = window.transcriber;
  try {
    await api.enableLoopbackAudio();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    } as DisplayMediaStreamOptions);
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    console.info('[audio] system capture via display-media loopback');
    return stream;
  } catch (err) {
    console.warn('Display-media loopback unavailable', err);
    return null;
  } finally {
    try {
      await api.disableLoopbackAudio();
    } catch {
      // ignore
    }
  }
}

async function captureSystemAudio(): Promise<MediaStream | null> {
  // Linux: monitor sources are the reliable path for Discord/Meet/Zoom playback.
  const viaMonitor = await captureViaMonitorSource();
  if (viaMonitor) return viaMonitor;

  const viaLoopback = await captureViaDisplayLoopback();
  if (viaLoopback) return viaLoopback;

  return null;
}

function rmsFloat(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const newLen = Math.floor(input.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = Math.floor(i * ratio);
    result[i] = input[idx];
  }
  return result;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
