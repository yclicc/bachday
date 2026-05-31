/** Share-image renderer. Bach portrait fills the whole frame (low-res but
 * shareable). A translucent panel at the bottom hosts the trace and score;
 * the chorale title sits in a header strip at the top. The user's pitch
 * line is coloured per segment: green where on the target note, red where
 * not — matching the live trace. */

import type { LiveTraceRenderer } from "./live-trace";
import QRCode from "qrcode";

export interface AccuracyReport {
  score: number;
  meanCentsError: number;
  /** Carried through for the history table; not used by renderShareCanvas. */
  frames: Array<{ time: number; target: number; sung: number | null; centsError: number | null }>;
}

export interface ShareCaption {
  title: string;
  subtitle: string;
  date: string;
}

export async function renderShareCanvas(
  canvas: HTMLCanvasElement,
  portraitSrc: string,
  trace: LiveTraceRenderer,
  score: { score: number; meanCentsError: number },
  caption: ShareCaption,
  /** Permalink URL to the specific phrase. Rendered as a QR code in the
   *  share image's bottom corner so paper-printed shares can scan straight to
   *  the right passage. */
  permalinkUrl?: string,
  /** URL printed in plain text under the QR. Defaults to the permalink, but
   *  callers usually pass the bare root URL — the permalink is already in the
   *  QR and the visible line is just there to tell someone reading on paper
   *  what site to visit. */
  displayUrl?: string,
): Promise<void> {
  const img = await loadImage(portraitSrc).catch(() => null);

  // 800x800: low-res, social-friendly square. Bach fills the canvas
  // (cover scale, like the original layout) so he reads instantly in a feed.
  const W = 800, H = 800;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Portrait, cover-scaled
  ctx.fillStyle = "#1f1a14";
  ctx.fillRect(0, 0, W, H);
  if (img) {
    const scale = Math.max(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  // Top gradient strip for the title's legibility against the painting
  const topGrad = ctx.createLinearGradient(0, 0, 0, 200);
  topGrad.addColorStop(0, "rgba(0, 0, 0, 0.6)");
  topGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, 200);

  ctx.fillStyle = "#ffffff";
  ctx.font = "600 30px 'Cormorant Garamond', Georgia, serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("BachDay", 28, 46);
  ctx.font = "italic 28px 'Cormorant Garamond', Georgia, serif";
  ctx.fillText(truncateToWidth(ctx, caption.title, W - 240), 28, 84);

  ctx.font = "600 56px -apple-system, 'Inter', sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(score.score * 100)}%`, W - 28, 60);
  ctx.font = "400 16px -apple-system, 'Inter', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(`mean error ${score.meanCentsError.toFixed(0)}¢`, W - 28, 86);

  // Trace panel at the bottom — translucent so Bach still shows through.
  const panelH = 240;
  const panelY = H - panelH - 20;
  const panelX = 20;
  const panelW = W - 40;
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  roundRect(ctx, panelX, panelY, panelW, panelH, 14);
  ctx.fill();

  // Reserve room on the right of the panel for a QR + URL block when a
  // permalink is supplied; otherwise the trace uses the full panel width.
  const qrSize = permalinkUrl ? 140 : 0;
  const qrGutter = permalinkUrl ? 20 : 0;
  const traceW = panelW - 32 - qrSize - qrGutter;
  drawTraceInto(ctx, trace, panelX + 16, panelY + 16, traceW, panelH - 48);

  if (permalinkUrl) {
    const qrX = panelX + panelW - 16 - qrSize;
    const qrY = panelY + 16;
    try {
      const qrDataUrl = await QRCode.toDataURL(permalinkUrl, {
        margin: 1, width: qrSize, color: { dark: "#15171a", light: "#ffffff" },
      });
      const qrImg = await loadImage(qrDataUrl);
      ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
    } catch {
      // QR generation failed — draw a placeholder box so layout stays stable.
      ctx.strokeStyle = "#15171a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(qrX, qrY, qrSize, qrSize);
    }
    ctx.fillStyle = "#15171a";
    ctx.font = "400 11px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(stripScheme(displayUrl ?? permalinkUrl), qrX + qrSize / 2, qrY + qrSize + 6);
    ctx.textBaseline = "alphabetic";
  }

  ctx.fillStyle = "#6b7280";
  ctx.font = "400 14px -apple-system, 'Inter', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(caption.subtitle, panelX + 16, panelY + panelH - 14);
  ctx.textAlign = "right";
  const dateRightEdge = permalinkUrl
    ? panelX + panelW - 16 - qrSize - qrGutter
    : panelX + panelW - 16;
  ctx.fillText(caption.date, dateRightEdge, panelY + panelH - 14);
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(15, 23, 42, 0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = Math.floor(view.centre - view.range); m <= Math.ceil(view.centre + view.range); m++) {
    const yy = midiToY(m);
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
  }
  ctx.stroke();

  // Target bars
  const target = trace.getTargetNotes();
  const edges = trace.getSlotEdges();
  const N = target.length;
  if (N > 0) {
    ctx.fillStyle = "rgba(31, 26, 20, 0.14)";
    ctx.strokeStyle = "#15171a";
    ctx.lineWidth = 2.5;
    for (let i = 0; i < N; i++) {
      const x0 = timeToX(view.start + edges[i] * span);
      const x1 = timeToX(view.start + edges[i + 1] * span);
      const yy = midiToY(target[i].midi);
      ctx.fillRect(x0 + 2, yy - 6, x1 - x0 - 4, 12);
      ctx.beginPath();
      ctx.moveTo(x0 + 2, yy);
      ctx.lineTo(x1 - 2, yy);
      ctx.stroke();
    }
  }

  // User pitch trace, coloured per-segment by hit/miss
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let prev: { x: number; y: number } | null = null;
  for (const p of trace.getPoints()) {
    if (p.midi == null) { prev = null; continue; }
    const px = timeToX(p.time);
    const py = midiToY(p.midi);
    if (prev) {
      ctx.strokeStyle = trace.hitColor(p) ?? "#9ca3af";
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
    prev = { x: px, y: py };
  }
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
