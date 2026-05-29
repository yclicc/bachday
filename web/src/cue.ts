/** Play a "do – sol – do" pitch cue in the current (transposed) key.
 *
 * Gives the singer their tonic and dominant without spoiling the melody.
 * Synthesised directly with WebAudio so there's no soundfont round-trip.
 */

import { tonicPc } from "./solfege";
import { extractKey } from "./abc";

function pickTonicMidi(tonicPC: number, voiceMid: number): number {
  // pick the octave whose tonic is closest to the middle of the voice's range
  let best = tonicPC;
  let bestDist = Infinity;
  for (let oct = -1; oct < 9; oct++) {
    const midi = oct * 12 + tonicPC;
    const d = Math.abs(midi - voiceMid);
    if (d < bestDist) { bestDist = d; best = midi; }
  }
  return best;
}

function tone(ctx: AudioContext, freq: number, t0: number, dur: number, gain = 0.18) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.setValueAtTime(gain, t0 + dur - 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Play tonic – dominant – tonic of the transposed key inside the voice range. */
export function playDoSolDo(abc: string, transposeSemitones: number, voiceMidMidi: number): void {
  const keyStr = extractKey(abc);
  const { pc } = tonicPc(keyStr);
  const transposedPc = ((pc + transposeSemitones) % 12 + 12) % 12;
  const tonic = pickTonicMidi(transposedPc, voiceMidMidi);
  const dominant = tonic + 7;

  const ctx = new AudioContext();
  const t0 = ctx.currentTime + 0.05;
  const dur = 0.55;
  tone(ctx, midiToHz(tonic), t0, dur);
  tone(ctx, midiToHz(dominant), t0 + dur, dur);
  tone(ctx, midiToHz(tonic), t0 + dur * 2, dur);
  setTimeout(() => { void ctx.close(); }, (dur * 3 + 0.5) * 1000);
}
