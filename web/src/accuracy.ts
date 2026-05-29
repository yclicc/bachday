/** Share-image renderer: the trace-and-target overlay composited on top of
 * the Bach portrait, with a title and score readout. */

import type { LiveTraceRenderer } from "./live-trace";

export interface AccuracyReport {
  score: number;
  meanCentsError: number;
  /** Carried through for the history table; not used by renderShareCanvas. */
  frames: Array<{ time: number; target: number; sung: number | null; centsError: number | null }>;
}

export async function renderShareCanvas(
  canvas: HTMLCanvasElement,
  portraitSrc: string,
  trace: LiveTraceRenderer,
  score: { score: number; meanCentsError: number },
  caption: string,
): Promise<void> {
  const img = await loadImage(portraitSrc).catch(() => null);
  const W = 1080, H = 1080;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#1f1a14";
  ctx.fillRect(0, 0, W, H);
  if (img) {
    const scale = Math.max(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.globalAlpha = 0.45;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.globalAlpha = 1;
  }

  // panel that the trace sits in
  const panelX = 60, panelY = H - 540, panelW = W - 120, panelH = 360;
  ctx.fillStyle = "rgba(250, 247, 240, 0.92)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "#6b3f1d";
  ctx.lineWidth = 3;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  drawTraceInto(ctx, trace, panelX + 16, panelY + 16, panelW - 32, panelH - 32);

  // header
  ctx.fillStyle = "#faf7f0";
  ctx.font = "bold 64px Georgia, serif";
  ctx.textAlign = "left";
  ctx.fillText("BachDay", 60, 120);
  ctx.font = "32px Georgia, serif";
  ctx.fillText(caption, 60, 170);
  ctx.font = "bold 96px Georgia, serif";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(score.score * 100)}%`, W - 60, 130);
  ctx.font = "italic 28px Georgia, serif";
  ctx.textAlign = "right";
  ctx.fillText(`mean error ${score.meanCentsError.toFixed(0)}¢`, W - 60, 170);
}

function drawTraceInto(
  ctx: CanvasRenderingContext2D,
  trace: LiveTraceRenderer,
  x: number, y: number, w: number, h: number,
): void {
  const view = trace.getView();
  const span = view.end - view.start || 1;
  const top = view.centre + view.range;
  const pitchSpan = view.range * 2;
  const midiToY = (m: number) => y + ((top - m) / pitchSpan) * h;
  const timeToX = (t: number) => x + ((t - view.start) / span) * w;

  // gridlines
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(31, 26, 20, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = Math.floor(view.centre - view.range); m <= Math.ceil(view.centre + view.range); m++) {
    const yy = midiToY(m);
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
  }
  ctx.stroke();

  // target bars (laid out by note duration)
  const target = trace.getTargetNotes();
  const edges = trace.getSlotEdges();
  const N = target.length;
  if (N > 0) {
    ctx.fillStyle = "rgba(107, 63, 29, 0.22)";
    ctx.strokeStyle = "#6b3f1d";
    ctx.lineWidth = 4;
    for (let i = 0; i < N; i++) {
      const x0 = timeToX(view.start + edges[i] * span);
      const x1 = timeToX(view.start + edges[i + 1] * span);
      const yy = midiToY(target[i].midi);
      ctx.fillRect(x0 + 3, yy - 8, x1 - x0 - 6, 16);
      ctx.beginPath();
      ctx.moveTo(x0 + 3, yy);
      ctx.lineTo(x1 - 3, yy);
      ctx.stroke();
    }
  }

  // user pitch trace
  ctx.strokeStyle = "#1f1a14";
  ctx.lineWidth = 3;
  ctx.beginPath();
  let pen = false;
  for (const p of trace.getPoints()) {
    if (p.midi == null) { pen = false; continue; }
    const px = timeToX(p.time);
    const py = midiToY(p.midi);
    if (!pen) { ctx.moveTo(px, py); pen = true; }
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
