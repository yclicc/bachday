/** Real-time pitch detection using CREPE.
 *
 * Loads the same stripped-down CREPE model the official demo uses
 * (https://marl.github.io/crepe/), runs each ~64ms audio frame through it
 * via tfjs, and emits MIDI estimates with a confidence value. The model is
 * ~4MB and is fetched once per session (browser cache permitting).
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

export interface PitchPoint {
  time: number;
  midi: number | null;
  confidence: number;
}

let modelPromise: Promise<tf.LayersModel> | null = null;
function getModel(): Promise<tf.LayersModel> {
  if (!modelPromise) modelPromise = tf.loadLayersModel(MODEL_URL);
  return modelPromise;
}

/** Eagerly start loading the model (call on page load so the first record
 *  click doesn't pay the download/init latency). */
export function preloadCrepe(): void {
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

async function runInference(model: tf.LayersModel, frame: Float32Array): Promise<{ midi: number; confidence: number }> {
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
  return decodePitch(data);
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

  async start(onPitch: (p: PitchPoint) => void): Promise<void> {
    const model = await getModel();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    this.srcRate = this.ctx.sampleRate;
    this.points = [];
    this.writePos = 0;
    this.fillLen = 0;
    this.samplesAt16k = 0;
    this.inflight = false;

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.appendResampled(input);
      this.tryInfer(model, onPitch);
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

  /** Pull one non-overlapping frame off the ring and submit it. We only ever
   *  keep one inference in flight so the GPU queue doesn't pile up. */
  private tryInfer(model: tf.LayersModel, onPitch: (p: PitchPoint) => void): void {
    if (this.inflight || this.fillLen < FRAME) return;
    const frame = new Float32Array(FRAME);
    const readStart = (this.writePos - this.fillLen + this.ring.length) % this.ring.length;
    for (let i = 0; i < FRAME; i++) frame[i] = this.ring[(readStart + i) % this.ring.length];
    this.fillLen -= FRAME;
    const frameTime = this.samplesAt16k / SR + (FRAME / SR) / 2;
    this.samplesAt16k += FRAME;

    this.inflight = true;
    runInference(model, frame).then(({ midi, confidence }) => {
      this.inflight = false;
      const point: PitchPoint = {
        time: frameTime,
        midi: confidence > VOICING_THRESHOLD ? midi : null,
        confidence,
      };
      this.points.push(point);
      onPitch(point);
      // chase the buffer if we fell behind during inference
      if (this.fillLen >= FRAME) this.tryInfer(model, onPitch);
    }).catch((e) => {
      this.inflight = false;
      console.warn("CREPE inference failed:", e);
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
