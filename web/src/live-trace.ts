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
  private practiceMode = false;
  private tonicPc: number | null;
  private rafHandle = 0;
  private centreMidi: number;
  private pitchRange: number;
  /** Initial view width — retained so {@link resetPoints} can restore the
   *  view after a previous take has narrowed it via freeze(). */
  private initialDuration: number;

  constructor(
    private canvas: HTMLCanvasElement,
    targetNotes: TargetNote[],
    estimatedDuration: number,
    opts: TraceOptions = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.targetNotes = targetNotes;
    this.initialDuration = Math.max(1, estimatedDuration);
    this.viewEnd = this.initialDuration;
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

  setPracticeMode(b: boolean) {
    this.practiceMode = b;
    this.draw();
  }

  /** Drop accumulated points and unfreeze the view, so a new live session
   *  (practice or recording) starts on a blank trace. If a previous take
   *  froze the view to its voiced span, restore the original time window so
   *  incoming points have somewhere to land. */
  resetPoints() {
    this.points = [];
    this.frozen = false;
    this.viewStart = 0;
    this.viewEnd = this.initialDuration;
    this.draw();
  }

  /** True when the singer's current pitch is within tolerance of *any*
   * target note in the phrase (octave-folded). Used by practice mode to
   * give immediate green/red feedback without committing to a slot. */
  private practiceColor(midi: number): string {
    let bestErr = Infinity;
    let bestTarget = 0;
    for (const t of this.targetNotes) {
      let s = midi;
      while (s - t.midi > 6) s -= 12;
      while (t.midi - s > 6) s += 12;
      const e = Math.abs((s - t.midi) * 100);
      if (e < bestErr) { bestErr = e; bestTarget = t.midi; }
    }
    if (!isFinite(bestErr)) return "#1f1a14";
    return bestErr <= this.toleranceForTarget(bestTarget) ? "#15803d" : "#1f1a14";
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

    const showTarget = this.frozen || this.showTargetWhileSinging || this.practiceMode;
    if (showTarget) this.drawTargetBars();

    if (this.referenceMidi != null) this.drawReferencePitchLine();

    if (this.practiceMode) {
      // Tuner-style display: a full-width horizontal line at the singer's
      // current pitch so it's easy to slide it onto a target bar.
      const last = [...this.points].reverse().find((p) => p.midi != null);
      if (last) {
        const y = this.midiToY(last.midi!);
        ctx.strokeStyle = this.practiceColor(last.midi!);
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }

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

  private drawReferencePitchLine() {
    if (this.referenceMidi == null) return;
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const y = this.midiToY(this.referenceMidi);
    if (y < 0 || y > this.canvas.height / (window.devicePixelRatio || 1)) return;
    ctx.save();
    ctx.strokeStyle = "#9333ea";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9333ea";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("ref", 4, y - 8);
    ctx.restore();
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
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Only colour the line green/red once the recording is frozen — while
    // live we don't yet know the singer's true rhythm, so per-slot hit
    // judgements would be misleading.
    const colourise = this.frozen;
    let prev: { x: number; y: number } | null = null;
    for (const p of this.points) {
      if (p.midi == null) { prev = null; continue; }
      const x = this.timeToX(p.time);
      const y = this.midiToY(p.midi);
      const color = colourise ? (this.hitColor(p) ?? "#9ca3af") : "#1f1a14";
      if (prev) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      prev = { x, y };
    }
  }

  /** Per-note tolerance, in cents. A flat ±50¢ baseline (half a quarter-tone
   * either way) plus the worst-case deviation between equal-tempered and
   * pure / Pythagorean tuning for the note's scale-degree relative to the
   * tonic. So a major 3rd or 6th gets ±70¢, a perfect 5th stays at ±56¢. */
  toleranceForTarget(target: number): number {
    const base = 50;
    if (this.tonicPc == null) return base + 15; // no tonic known → generous default
    const interval = ((target - this.tonicPc) % 12 + 12) % 12;
    return base + JI_DEVIATION_CENTS[interval];
  }

  /** Index of the target slot containing time `t`, or -1 if outside the
   * current view. Uses the (mutable) viewStart/viewEnd so coloring stays
   * consistent as the live trace scrolls. */
  targetSlotAt(t: number): number {
    const span = this.viewEnd - this.viewStart;
    if (span <= 0) return -1;
    const u = (t - this.viewStart) / span;
    if (u < 0 || u > 1) return -1;
    for (let i = 0; i < this.targetNotes.length; i++) {
      if (u >= this.slotEdges[i] && u < this.slotEdges[i + 1]) return i;
    }
    return this.targetNotes.length - 1;
  }

  /** Tri-state colour for a sung point relative to its target slot.
   * Returns a hex string or null if no target / unvoiced. */
  hitColor(p: PitchPoint): string | null {
    if (p.midi == null) return null;
    const i = this.targetSlotAt(p.time);
    if (i < 0) return null;
    const target = this.targetNotes[i].midi;
    let s = p.midi;
    while (s - target > 6) s -= 12;
    while (target - s > 6) s += 12;
    const cents = Math.abs((s - target) * 100);
    return cents <= this.toleranceForTarget(target) ? "#15803d" : "#b91c1c";
  }

  /** Score for one specific (start, end) voiced window of the recording.
   *  Used internally by {@link computeScore} which searches over candidate
   *  windows to find the alignment that best matches the target rhythm. */
  /** Score for one specific (start, end) window. A target slot counts as a
   *  hit only if at least 50% of its total frames sit within the per-target
   *  tolerance — so brushing past the right pitch is no longer enough. The
   *  reported `sung` is still the in-slot median (informational only). */
  private scoreForWindow(start: number, end: number): TraceScore {
    const N = this.targetNotes.length;
    const span = end - start;
    if (N === 0 || span <= 0) return { score: 0, meanCentsError: 0, perNote: [] };
    const perNote: TraceScore["perNote"] = [];
    let hits = 0, voicedSlots = 0, errSum = 0;
    const HIT_FRACTION_THRESHOLD = 0.5;
    for (let i = 0; i < N; i++) {
      const t0 = start + this.slotEdges[i] * span;
      const t1 = start + this.slotEdges[i + 1] * span;
      const inSlot = this.points.filter((p) => p.time >= t0 && p.time < t1);
      const voicedFrames = inSlot.filter((p) => p.midi != null).map((p) => p.midi!) as number[];

      let sung: number | null = null;
      let cents: number | null = null;
      const target = this.targetNotes[i].midi;
      const tol = this.toleranceForTarget(target);

      if (voicedFrames.length) {
        const sorted = [...voicedFrames].sort((a, b) => a - b);
        sung = sorted[Math.floor(sorted.length / 2)];
        let s = sung;
        while (s - target > 6) s -= 12;
        while (target - s > 6) s += 12;
        cents = (s - target) * 100;
        voicedSlots++;
        errSum += Math.abs(cents);
      }

      // Hit test uses the fraction of TOTAL slot frames (voiced or not) that
      // landed within tolerance. Silent frames count against the singer.
      const totalSlotFrames = inSlot.length;
      if (totalSlotFrames > 0) {
        let inTol = 0;
        for (const m of voicedFrames) {
          let s = m;
          while (s - target > 6) s -= 12;
          while (target - s > 6) s += 12;
          if (Math.abs((s - target) * 100) <= tol) inTol++;
        }
        if (inTol / totalSlotFrames >= HIT_FRACTION_THRESHOLD) hits++;
      }
      perNote.push({ target, sung, cents });
    }
    return { score: hits / N, meanCentsError: voicedSlots ? errSum / voicedSlots : 0, perNote };
  }

  /** Per-target-note score using the voiced span as the time base. Searches
   * over a small grid of (start, end) windows around the trimmed voiced span
   * so leading/trailing silence — or a slight tempo mismatch — doesn't
   * penalise the singer. The best-scoring window also updates viewStart /
   * viewEnd so the rendered target bars line up with the chosen alignment. */
  computeScore(): TraceScore {
    const N = this.targetNotes.length;
    if (N === 0) return { score: 0, meanCentsError: 0, perNote: [] };

    // Use the voiced span as the search anchor — falls back to the current
    // view if too few voiced frames to be meaningful.
    const voiced = this.points.filter((p) => p.midi != null);
    let anchorStart = this.viewStart;
    let anchorEnd = this.viewEnd;
    if (voiced.length >= 2) {
      anchorStart = voiced[0].time;
      anchorEnd = voiced[voiced.length - 1].time;
    }
    const anchorSpan = anchorEnd - anchorStart;
    if (anchorSpan <= 0) return this.scoreForWindow(anchorStart, anchorEnd);

    // Affine time-warp search: independent start- and end-shifts as a
    // fraction of the voiced span. Equivalent to t' = a·t + b — any linear /
    // affine rescaling that improves the score is accepted. Range goes out
    // to ±30% so leading or trailing silence can be shrunk away.
    const SHIFTS = [-0.30, -0.20, -0.12, -0.06, -0.03, 0, 0.03, 0.06, 0.12, 0.20, 0.30];
    let best: TraceScore | null = null;
    let bestStart = anchorStart, bestEnd = anchorEnd;
    for (const ds of SHIFTS) {
      for (const de of SHIFTS) {
        const s = anchorStart + ds * anchorSpan;
        const e = anchorEnd + de * anchorSpan;
        if (e - s <= 0.2 * anchorSpan) continue;
        const res = this.scoreForWindow(s, e);
        const better = !best
          || res.score > best.score
          || (res.score === best.score && res.meanCentsError < best.meanCentsError);
        if (better) { best = res; bestStart = s; bestEnd = e; }
      }
    }
    if (best) {
      this.viewStart = bestStart;
      this.viewEnd = bestEnd;
      this.draw();
      return best;
    }
    return this.scoreForWindow(anchorStart, anchorEnd);
  }


  /** Draw a single horizontal "reference pitch" line — used when the user has
   * the on-load reference-pitch toggle on. Returns whether the pitch lies
   * within the visible MIDI range (so callers can decide to scroll labels). */
  setReferencePitch(midi: number | null) {
    this.referenceMidi = midi;
    this.draw();
  }
  private referenceMidi: number | null = null;

  getPoints(): PitchPoint[] { return this.points; }
  getTargetNotes(): TargetNote[] { return this.targetNotes; }
  getSlotEdges(): number[] { return this.slotEdges; }
  getView(): { start: number; end: number; centre: number; range: number } {
    return { start: this.viewStart, end: this.viewEnd, centre: this.centreMidi, range: this.pitchRange };
  }
}
