/** Real-time pitch detection.
 *
 * Primary backend: CREPE (https://marl.github.io/crepe/) via tfjs. The model
 * is ~4MB and is fetched once per session (browser cache permitting).
 *
 * Fallback backend: YIN autocorrelation (de Cheveigné & Kawahara, "YIN, a
 * fundamental frequency estimator for speech and music", JASA 2002). YIN is
 * pure JS, runs in well under a millisecond per frame on any device, and is
 * accurate enough for monophonic singing. We switch to it automatically on
 * devices where CREPE inference is too slow to keep up with the 64ms frame
 * budget (or where the model fails to load), and remember the choice in
 * localStorage so subsequent sessions skip CREPE entirely on that device.
 */

import * as tf from "@tensorflow/tfjs";

const MODEL_URL = "https://marl.github.io/crepe/model/model.json";
const SR = 16000;
const FRAME = 1024;
/** The CREPE output bin → cents mapping from the upstream paper: bins are
 * 20 cents wide, starting at 1997.379 cents (≈ C1 + a few cents). */
const CENTS_BIN0 = 1997.3794084376191;
const CENTS_BIN_WIDTH = 20.0;
/** Voicing threshold: bins below this confidence are reported as unvoiced. */
const VOICING_THRESHOLD = 0.3;
/** Frame duration in ms (FRAME / SR). If CREPE inference can't average below
 *  this it can't keep up with real-time audio. */
const FRAME_MS = (FRAME / SR) * 1000;
/** Median inference latency over the first N frames above which we fall back
 *  to YIN. Slightly above frame duration so we tolerate brief spikes. */
const SLOW_THRESHOLD_MS = 80;
const LATENCY_WINDOW = 8;
const BACKEND_KEY = "bachday:pitchBackend";

type Backend = "crepe" | "yin";

export interface PitchPoint {
  time: number;
  midi: number | null;
  confidence: number;
}

function getStoredBackend(): Backend | null {
  try {
    const v = localStorage.getItem(BACKEND_KEY);
    if (v === "crepe" || v === "yin") return v;
  } catch {}
  return null;
}

function setStoredBackend(b: Backend): void {
  try { localStorage.setItem(BACKEND_KEY, b); } catch {}
}

let modelPromise: Promise<tf.LayersModel> | null = null;
function getModel(): Promise<tf.LayersModel> {
  if (!modelPromise) modelPromise = tf.loadLayersModel(MODEL_URL);
  return modelPromise;
}

/** Eagerly start loading the CREPE model so the first record click doesn't
 *  pay the download/init latency. Skipped if a previous session already
 *  decided this device is too slow for CREPE. */
export function preloadCrepe(): void {
  if (getStoredBackend() === "yin") return;
  getModel().catch((e) => {
    console.warn("CREPE preload failed:", e);
    modelPromise = null;
  });
}

function decodePitch(activation: Float32Array): { midi: number; confidence: number } {
  let peakIdx = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < activation.length; i++) {
    if (activation[i] > peakVal) { peakVal = activation[i]; peakIdx = i; }
  }
  // weighted average over a ±4-bin window around the peak for sub-bin accuracy
  const lo = Math.max(0, peakIdx - 4);
  const hi = Math.min(activation.length, peakIdx + 5);
  let num = 0, den = 0;
  for (let i = lo; i < hi; i++) {
    num += activation[i] * i;
    den += activation[i];
  }
  const refined = den > 0 ? num / den : peakIdx;
  const cents = CENTS_BIN0 + CENTS_BIN_WIDTH * refined;
  const hz = 10 * Math.pow(2, cents / 1200);
  const midi = 69 + 12 * Math.log2(hz / 440);
  return { midi, confidence: peakVal };
}

async function runCrepeInference(
  model: tf.LayersModel,
  frame: Float32Array,
): Promise<{ midi: number | null; confidence: number }> {
  const result = tf.tidy(() => {
    const t = tf.tensor1d(frame);
    const mean = tf.mean(t);
    const zeroMean = t.sub(mean);
    const std = tf.moments(zeroMean).variance.sqrt().add(tf.scalar(1e-8));
    const normalized = zeroMean.div(std);
    const input = normalized.reshape([1, FRAME]);
    return model.predict(input) as tf.Tensor;
  });
  const data = await result.data() as Float32Array;
  result.dispose();
  const { midi, confidence } = decodePitch(data);
  return { midi: confidence > VOICING_THRESHOLD ? midi : null, confidence };
}

/** YIN pitch estimator. Returns null midi when unvoiced.
 *
 * Implemented from the original paper (de Cheveigné & Kawahara, JASA 2002):
 *   step 2 (difference function), step 3 (cumulative mean normalized
 *   difference), step 4 (absolute threshold), step 5 (parabolic interpolation
 *   on the chosen tau). Step 6 (best local estimate) is skipped — it
 *   marginally helps speech with rapid pitch changes and is overkill for
 *   sustained singing notes.
 */
function yinPitch(buf: Float32Array, sr: number): { midi: number | null; confidence: number } {
  const halfN = buf.length >> 1;
  const d = new Float32Array(halfN);
  for (let tau = 1; tau < halfN; tau++) {
    let sum = 0;
    for (let i = 0; i < halfN; i++) {
      const diff = buf[i] - buf[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cmnd = new Float32Array(halfN);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau < halfN; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
  }
  const threshold = 0.15;
  let tauEst = -1;
  for (let tau = 2; tau < halfN; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 < halfN && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst === -1) return { midi: null, confidence: 0 };
  let betterTau = tauEst;
  if (tauEst > 1 && tauEst + 1 < halfN) {
    const s0 = cmnd[tauEst - 1], s1 = cmnd[tauEst], s2 = cmnd[tauEst + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEst + (s2 - s0) / denom;
  }
  const f0 = sr / betterTau;
  if (f0 < 50 || f0 > 1500) return { midi: null, confidence: 0 };
  const midi = 69 + 12 * Math.log2(f0 / 440);
  return { midi, confidence: 1 - cmnd[tauEst] };
}

export class LivePitchDetector {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private points: PitchPoint[] = [];
  private ring = new Float32Array(FRAME * 4);
  private writePos = 0;
  private fillLen = 0;
  private srcRate = SR;
  private samplesAt16k = 0;
  private inflight = false;
  private backend: Backend = "crepe";
  private model: tf.LayersModel | null = null;
  private latencies: number[] = [];

  async start(onPitch: (p: PitchPoint) => void): Promise<void> {
    const stored = getStoredBackend();
    if (stored === "yin") {
      this.backend = "yin";
    } else {
      try {
        this.model = await getModel();
        this.backend = "crepe";
      } catch (e) {
        console.warn("CREPE unavailable, using YIN:", e);
        this.backend = "yin";
        setStoredBackend("yin");
      }
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    this.srcRate = this.ctx.sampleRate;
    this.points = [];
    this.writePos = 0;
    this.fillLen = 0;
    this.samplesAt16k = 0;
    this.inflight = false;
    this.latencies = [];

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.appendResampled(input);
      this.tryInfer(onPitch);
    };
    source.connect(this.node);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // monitor would feedback, mute the sink
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  /** Linear-interpolation resample of `src` to 16 kHz, written into the ring. */
  private appendResampled(src: Float32Array): void {
    const ratio = SR / this.srcRate;
    const outLen = Math.floor(src.length * ratio);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i / ratio;
      const i0 = Math.floor(srcIdx);
      const frac = srcIdx - i0;
      const sample = src[i0] * (1 - frac) + (src[i0 + 1] ?? src[i0]) * frac;
      this.ring[this.writePos] = sample;
      this.writePos = (this.writePos + 1) % this.ring.length;
      if (this.fillLen < this.ring.length) this.fillLen++;
    }
  }

  private async inferFrame(frame: Float32Array): Promise<{ midi: number | null; confidence: number }> {
    if (this.backend === "crepe" && this.model) {
      return runCrepeInference(this.model, frame);
    }
    return yinPitch(frame, SR);
  }

  /** If the CREPE inference latency window is consistently above budget,
   *  swap to YIN mid-stream and remember it for next time. */
  private maybeSwitchToYin(latencyMs: number): void {
    if (this.backend !== "crepe") return;
    this.latencies.push(latencyMs);
    if (this.latencies.length < LATENCY_WINDOW) return;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median > SLOW_THRESHOLD_MS) {
      console.warn(
        `CREPE inference median ${median.toFixed(0)}ms exceeds budget ${FRAME_MS.toFixed(0)}ms; switching to YIN.`,
      );
      this.backend = "yin";
      this.model = null;
      setStoredBackend("yin");
    }
    // only need the first window — stop tracking once we've decided
    if (this.latencies.length >= LATENCY_WINDOW) this.latencies = [];
  }

  /** Pull one non-overlapping frame off the ring and submit it. We only ever
   *  keep one inference in flight so the GPU queue doesn't pile up. */
  private tryInfer(onPitch: (p: PitchPoint) => void): void {
    if (this.inflight || this.fillLen < FRAME) return;
    const frame = new Float32Array(FRAME);
    const readStart = (this.writePos - this.fillLen + this.ring.length) % this.ring.length;
    for (let i = 0; i < FRAME; i++) frame[i] = this.ring[(readStart + i) % this.ring.length];
    this.fillLen -= FRAME;
    const frameTime = this.samplesAt16k / SR + (FRAME / SR) / 2;
    this.samplesAt16k += FRAME;

    this.inflight = true;
    const t0 = performance.now();
    this.inferFrame(frame).then(({ midi, confidence }) => {
      this.inflight = false;
      this.maybeSwitchToYin(performance.now() - t0);
      const point: PitchPoint = { time: frameTime, midi, confidence };
      this.points.push(point);
      onPitch(point);
      // chase the buffer if we fell behind during inference
      if (this.fillLen >= FRAME) this.tryInfer(onPitch);
    }).catch((e) => {
      this.inflight = false;
      console.warn("Pitch inference failed:", e);
    });
  }

  async stop(): Promise<PitchPoint[]> {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    return this.points;
  }
}
