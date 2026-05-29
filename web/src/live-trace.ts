/** Live pitch-trace canvas.
 *
 * Two phases:
 *  - During recording: only the user's detected pitch is plotted (scrolling
 *    in real time). Target bars are hidden so this stays a real sight-singing
 *    exercise. A beginner flag can opt back into seeing the target while
 *    singing.
 *  - After freeze(): the X axis is rescaled to the user's voiced span and the
 *    target bars are drawn underneath the trace for direct comparison.
 */

import type { PitchPoint } from "./pitch";

export interface TraceOptions {
  /** When true, target bars are shown during the live recording too. */
  showTargetWhileSinging?: boolean;
  /** Pitch class (0–11) of the (transposed) tonic, used to widen the
   * tolerance for intervals that drift between temperaments. */
  tonicPc?: number;
}

/** Worst-case deviation between equal-tempered and pure / Pythagorean
 * tuning, per semitone interval above the tonic. A singer doing 12-bar
 * tonic-to-leading-tone melody work will naturally sing a Major 3rd flat
 * of ET, a minor 3rd sharp, etc., so we widen tolerance on those degrees. */
const JI_DEVIATION_CENTS: number[] = [
  0,   // P1 / P8
  15,  // m2
  12,  // M2
  20,  // m3
  20,  // M3
  6,   // P4
  25,  // tritone
  6,   // P5
  20,  // m6
  20,  // M6
  18,  // m7
  15,  // M7
];

export interface TraceScore {
  score: number;
  meanCentsError: number;
  perNote: Array<{ target: number; sung: number | null; cents: number | null }>;
}

export interface TargetNote { midi: number; duration: number; }

export class LiveTraceRenderer {
  private ctx: CanvasRenderingContext2D;
  private points: PitchPoint[] = [];
  private targetNotes: TargetNote[];
  /** Cumulative duration start of each target note, normalised to [0,1]. */
  private slotEdges: number[];
  private viewStart = 0;
  private viewEnd: number;
  private frozen = false;
  private showTargetWhileSinging: boolean;
  private tonicPc: number | null;
  private rafHandle = 0;
  private centreMidi: number;
  private pitchRange: number;

  constructor(
    private canvas: HTMLCanvasElement,
    targetNotes: TargetNote[],
    estimatedDuration: number,
    opts: TraceOptions = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.targetNotes = targetNotes;
    this.viewEnd = Math.max(1, estimatedDuration);
    this.showTargetWhileSinging = !!opts.showTargetWhileSinging;
    this.tonicPc = opts.tonicPc ?? null;

    const totalDur = targetNotes.reduce((s, n) => s + n.duration, 0) || 1;
    this.slotEdges = [0];
    let cum = 0;
    for (const n of targetNotes) {
      cum += n.duration;
      this.slotEdges.push(cum / totalDur);
    }

    if (targetNotes.length) {
      const lo = Math.min(...targetNotes.map((n) => n.midi));
      const hi = Math.max(...targetNotes.map((n) => n.midi));
      this.centreMidi = (lo + hi) / 2;
      this.pitchRange = Math.max(8, (hi - lo) / 2 + 6);
    } else {
      this.centreMidi = 60;
      this.pitchRange = 12;
    }
    this.fitCanvas();
    this.draw();
  }

  private fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(400, rect.width) * dpr;
    this.canvas.height = 220 * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setShowTargetWhileSinging(b: boolean) {
    this.showTargetWhileSinging = b;
    this.draw();
  }

  addPoint(p: PitchPoint) {
    if (this.frozen) return;
    this.points.push(p);
    // grow the view so the trace doesn't run off the right edge
    if (p.time > this.viewEnd) this.viewEnd = p.time * 1.05;
    if (!this.rafHandle) {
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = 0;
        this.draw();
      });
    }
  }

  /** Lock the canvas and rescale X to the user's voiced span so the target
   * bars line up with what they actually sang. */
  freeze() {
    this.frozen = true;
    const voiced = this.points.filter((p) => p.midi != null);
    if (voiced.length >= 2) {
      const span = voiced[voiced.length - 1].time - voiced[0].time;
      if (span > 0.4) {
        this.viewStart = voiced[0].time;
        this.viewEnd = voiced[voiced.length - 1].time;
      }
    }
    this.draw();
  }

  private midiToY(midi: number): number {
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const top = this.centreMidi + this.pitchRange;
    const span = this.pitchRange * 2;
    return ((top - midi) / span) * h;
  }

  private timeToX(t: number): number {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const span = this.viewEnd - this.viewStart;
    if (span <= 0) return 0;
    return ((t - this.viewStart) / span) * w;
  }

  private draw() {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);

    // gridlines on integer MIDI values
    ctx.strokeStyle = "#eee";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const lo = Math.floor(this.centreMidi - this.pitchRange);
    const hi = Math.ceil(this.centreMidi + this.pitchRange);
    for (let m = lo; m <= hi; m++) {
      const y = this.midiToY(m);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const showTarget = this.frozen || this.showTargetWhileSinging;
    if (showTarget) this.drawTargetBars();
    this.drawUserTrace();

    if (!this.frozen) {
      const last = [...this.points].reverse().find((p) => p.midi != null);
      if (last) {
        ctx.fillStyle = "#6b3f1d";
        ctx.beginPath();
        ctx.arc(this.timeToX(last.time), this.midiToY(last.midi!), 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawTargetBars() {
    const N = this.targetNotes.length;
    if (N === 0) return;
    const ctx = this.ctx;
    const span = this.viewEnd - this.viewStart;
    ctx.fillStyle = "rgba(107, 63, 29, 0.18)";
    ctx.strokeStyle = "#6b3f1d";
    ctx.lineWidth = 3;
    for (let i = 0; i < N; i++) {
      const x0 = this.timeToX(this.viewStart + this.slotEdges[i] * span);
      const x1 = this.timeToX(this.viewStart + this.slotEdges[i + 1] * span);
      const y = this.midiToY(this.targetNotes[i].midi);
      ctx.fillRect(x0 + 2, y - 6, x1 - x0 - 4, 12);
      ctx.beginPath();
      ctx.moveTo(x0 + 2, y);
      ctx.lineTo(x1 - 2, y);
      ctx.stroke();
    }
  }

  private drawUserTrace() {
    const ctx = this.ctx;
    ctx.strokeStyle = "#1f1a14";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let pen = false;
    for (const p of this.points) {
      if (p.midi == null) { pen = false; continue; }
      const x = this.timeToX(p.time);
      const y = this.midiToY(p.midi);
      if (!pen) { ctx.moveTo(x, y); pen = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** Per-note tolerance, in cents. A flat ±50¢ baseline (half a quarter-tone
   * either way) plus the worst-case deviation between equal-tempered and
   * pure / Pythagorean tuning for the note's scale-degree relative to the
   * tonic. So a major 3rd or 6th gets ±70¢, a perfect 5th stays at ±56¢. */
  private toleranceForTarget(target: number): number {
    const base = 50;
    if (this.tonicPc == null) return base + 15; // no tonic known → generous default
    const interval = ((target - this.tonicPc) % 12 + 12) % 12;
    return base + JI_DEVIATION_CENTS[interval];
  }

  /** Per-target-note score using the voiced span as the time base. */
  computeScore(): TraceScore {
    const N = this.targetNotes.length;
    const span = this.viewEnd - this.viewStart;
    if (N === 0 || span <= 0) return { score: 0, meanCentsError: 0, perNote: [] };
    const perNote: TraceScore["perNote"] = [];
    let hits = 0, voiced = 0, errSum = 0;
    for (let i = 0; i < N; i++) {
      const t0 = this.viewStart + this.slotEdges[i] * span;
      const t1 = this.viewStart + this.slotEdges[i + 1] * span;
      const candidates = this.points
        .filter((p) => p.midi != null && p.time >= t0 && p.time < t1)
        .map((p) => p.midi!) as number[];
      let sung: number | null = null;
      if (candidates.length) {
        candidates.sort((a, b) => a - b);
        sung = candidates[Math.floor(candidates.length / 2)];
      }
      const target = this.targetNotes[i].midi;
      let cents: number | null = null;
      if (sung != null) {
        let s = sung;
        while (s - target > 6) s -= 12;
        while (target - s > 6) s += 12;
        cents = (s - target) * 100;
        voiced++;
        errSum += Math.abs(cents);
        if (Math.abs(cents) <= this.toleranceForTarget(target)) hits++;
      }
      perNote.push({ target, sung, cents });
    }
    return { score: hits / N, meanCentsError: voiced ? errSum / voiced : 0, perNote };
  }

  getPoints(): PitchPoint[] { return this.points; }
  getTargetNotes(): TargetNote[] { return this.targetNotes; }
  getSlotEdges(): number[] { return this.slotEdges; }
  getView(): { start: number; end: number; centre: number; range: number } {
    return { start: this.viewStart, end: this.viewEnd, centre: this.centreMidi, range: this.pitchRange };
  }
}
