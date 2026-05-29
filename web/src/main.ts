import abcjs from "abcjs";
import {
  VOICE_TYPES, VOICE_RANGE, chooseTransposition, chooseClef, CLEF_STAFF_OFFSET,
  type VoiceType,
} from "./voice";
import { phraseForDate, todayKey, type Dataset, type PhraseRow } from "./schedule";
import {
  addSolfegeLyrics, addChoraleLyrics, setAbcClef, extractKey,
  abcSourceNoteSequence,
  type VisualObj,
} from "./abc";
import { tonicPc } from "./solfege";
import { LivePitchDetector, preloadCrepe } from "./pitch";
import { LiveTraceRenderer } from "./live-trace";
import { playDoSolDo } from "./cue";
import { renderShareCanvas, type AccuracyReport } from "./accuracy";
import { loadPrefs, savePrefs, loadHistory, appendHistory, type Prefs } from "./storage";
import type { SolfegeMode } from "./solfege";

const PORTRAIT_URL = "/bach.jpg";
let prefs: Prefs = loadPrefs();
let dataset: Dataset = { chorales: {}, lyrics: {}, phrases: [] };
let currentPhrase: PhraseRow | null = null;
let currentTranspose = 0;
let currentVisual: VisualObj | null = null;
let trace: LiveTraceRenderer | null = null;
let lastReport: AccuracyReport | null = null;

async function main() {
  try {
    const raw = await (await fetch("/phrases.json")).json();
    dataset = Array.isArray(raw)
      ? { chorales: {}, lyrics: {}, phrases: raw as PhraseRow[] }  // legacy flat format
      : (raw as Dataset);
  } catch {
    document.getElementById("app")!.innerHTML =
      `<p>Could not load <code>phrases.json</code>. Run <code>uv run python process_dataset.py</code> and copy the result to <code>web/public/phrases.json</code>.</p>`;
    return;
  }
  if (!prefs.voice) renderVoicePrompt();
  else renderPhraseView();
  renderHeaderControls();
  preloadCrepe();
}

function renderHeaderControls() {
  const root = document.getElementById("header-controls")!;
  root.innerHTML = "";
  if (!prefs.voice) return;
  const voice = document.createElement("select");
  for (const v of VOICE_TYPES) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    if (v === prefs.voice) opt.selected = true;
    voice.appendChild(opt);
  }
  voice.onchange = () => {
    prefs.voice = voice.value as VoiceType;
    savePrefs(prefs);
    renderPhraseView();
  };

  const solfege = document.createElement("select");
  const modes: Array<[SolfegeMode, string]> = [
    ["none", "no solfege"],
    ["chromatic", "chromatic only"],
    ["all", "all solfege"],
  ];
  for (const [v, label] of modes) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = label;
    if (v === prefs.solfege) opt.selected = true;
    solfege.appendChild(opt);
  }
  solfege.onchange = () => {
    prefs.solfege = solfege.value as SolfegeMode;
    savePrefs(prefs);
    renderPhraseView();
  };

  const makeToggle = (label: string, checked: boolean, onChange: (b: boolean) => void) => {
    const wrapper = document.createElement("label");
    wrapper.style.fontSize = "0.85em";
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "0.3rem";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.onchange = () => onChange(box.checked);
    wrapper.append(box, document.createTextNode(label));
    return wrapper;
  };

  const lyricsToggle = makeToggle("show lyrics", !!prefs.showLyrics, (b) => {
    prefs.showLyrics = b;
    savePrefs(prefs);
    renderPhraseView();
  });
  const showTargetToggle = makeToggle("beginner: show target", !!prefs.showTargetWhileSinging, (b) => {
    prefs.showTargetWhileSinging = b;
    savePrefs(prefs);
    trace?.setShowTargetWhileSinging(b);
  });

  root.append(voice, solfege, lyricsToggle, showTargetToggle);
}

function renderVoicePrompt() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <h2>Welcome to BachDay</h2>
    <p>Every day, a single phrase from one of Bach's chorales — transposed for your voice, sung by you, scored against Bach himself.</p>
    <p>First, what's your voice type?</p>
    <div id="voice-buttons" class="row"></div>
  `;
  const row = app.querySelector("#voice-buttons")!;
  for (const v of VOICE_TYPES) {
    const b = document.createElement("button");
    b.textContent = v;
    b.onclick = () => {
      prefs.voice = v;
      savePrefs(prefs);
      renderHeaderControls();
      renderPhraseView();
    };
    row.appendChild(b);
  }
}

function partLabel(p: "S" | "A" | "T" | "B"): string {
  return { S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" }[p];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function renderPhraseView() {
  if (!prefs.voice) return renderVoicePrompt();
  currentPhrase = phraseForDate(dataset.phrases);
  currentTranspose = chooseTransposition(
    currentPhrase.ambitus_lo, currentPhrase.ambitus_hi, prefs.voice, currentPhrase.part,
  );
  const soundingLo = currentPhrase.ambitus_lo + currentTranspose;
  const soundingHi = currentPhrase.ambitus_hi + currentTranspose;
  const clef = chooseClef(prefs.voice, soundingLo, soundingHi);
  const staffOffset = CLEF_STAFF_OFFSET[clef] ?? 0;
  const abcWithClef = setAbcClef(currentPhrase.abc, clef);

  const lyricsKey = `${currentPhrase.chorale}.${currentPhrase.phrase}`;
  const verses = (prefs.showLyrics ? dataset.lyrics[lyricsKey] : null) ?? null;
  const abcWithChoraleLyrics = verses ? addChoraleLyrics(abcWithClef, verses) : abcWithClef;
  const abcWithLyrics = addSolfegeLyrics(abcWithChoraleLyrics, prefs.solfege);

  const choraleInfo = dataset.chorales[String(currentPhrase.chorale)];
  const choraleTitle = choraleInfo?.title ?? `BWV ${currentPhrase.chorale}`;

  const app = document.getElementById("app")!;
  app.innerHTML = `
    <h2>${escapeHtml(choraleTitle)} <span class="muted">— BWV ${currentPhrase.chorale}, ${
      partLabel(currentPhrase.part)
    }, phrase ${currentPhrase.phrase}</span></h2>
    <div class="muted">Transposed ${currentTranspose >= 0 ? "+" : ""}${currentTranspose} semitones for ${prefs.voice}. Clef: ${clef}.</div>
    <div id="score"></div>
    <div class="row">
      <button id="cue-btn" class="secondary">♪ Give me the key (do – sol – do)</button>
      <button id="rec-btn">● Record</button>
      <span id="rec-status" class="muted"></span>
    </div>
    <canvas id="trace-canvas"></canvas>
    <div class="row" id="score-row" hidden>
      <strong id="score-text"></strong>
    </div>
    <canvas id="share-canvas" hidden></canvas>
    <div class="row" id="share-row" hidden>
      <button id="dl-btn" class="secondary">Download share image</button>
    </div>
    <section class="history" id="history"></section>
  `;
  const rendered = abcjs.renderAbc("score", abcWithLyrics, {
    visualTranspose: currentTranspose + staffOffset,
    responsive: "resize",
    staffwidth: 720,
    add_classes: true,
  });
  currentVisual = (rendered[0] as VisualObj) ?? null;

  wireCue();
  wireRecorder();
  renderHistory();
}

function wireCue() {
  const btn = document.getElementById("cue-btn") as HTMLButtonElement;
  btn.onclick = () => {
    if (!currentPhrase || !prefs.voice) return;
    const range = VOICE_RANGE[prefs.voice];
    const voiceMid = (range.lo + range.hi) / 2;
    playDoSolDo(currentPhrase.abc, currentTranspose, voiceMid);
  };
}

function wireRecorder() {
  const btn = document.getElementById("rec-btn") as HTMLButtonElement;
  const status = document.getElementById("rec-status")!;
  const canvas = document.getElementById("trace-canvas") as HTMLCanvasElement;
  const scoreRow = document.getElementById("score-row")!;
  const scoreText = document.getElementById("score-text")!;
  const detector = new LivePitchDetector();
  let isRecording = false;

  const targetNotes = currentPhrase
    ? abcSourceNoteSequence(currentPhrase.abc)
        .map((n) => ({ midi: n.midi + currentTranspose, duration: n.duration }))
    : [];
  const sourceTonic = currentPhrase ? tonicPc(extractKey(currentPhrase.abc)).pc : 0;
  const transposedTonicPc = ((sourceTonic + currentTranspose) % 12 + 12) % 12;
  trace = new LiveTraceRenderer(
    canvas, targetNotes, Math.max(2, targetNotes.length * 0.6),
    {
      showTargetWhileSinging: !!prefs.showTargetWhileSinging,
      tonicPc: transposedTonicPc,
    },
  );

  btn.onclick = async () => {
    if (!isRecording) {
      status.textContent = "loading pitch model…";
      try {
        await detector.start((p) => trace?.addPoint(p));
      } catch (e) {
        status.textContent = `start failed: ${(e as Error).message}`;
        return;
      }
      isRecording = true;
      btn.textContent = "■ Stop";
      status.textContent = "recording — sing the phrase…";
      scoreRow.hidden = true;
      return;
    }

    btn.disabled = true;
    await detector.stop();
    isRecording = false;
    btn.textContent = "● Record";
    btn.disabled = false;
    trace?.freeze();

    const { score, meanCentsError, perNote } = trace!.computeScore();
    const hits = perNote.filter((n) => n.cents != null && Math.abs(n.cents) <= 60).length;
    status.textContent = "";
    scoreRow.hidden = false;
    scoreText.textContent =
      `${hits}/${perNote.length} notes within ±60¢` +
      (meanCentsError > 0 ? ` · mean error ${meanCentsError.toFixed(0)}¢` : "");

    lastReport = { score, meanCentsError, frames: [] };
    appendHistory({
      date: todayKey(),
      chorale: currentPhrase!.chorale,
      part: currentPhrase!.part,
      phrase: currentPhrase!.phrase,
      score,
      meanCentsError,
    });
    renderHistory();
    await drawShare();
  };
}

async function drawShare() {
  if (!lastReport || !currentPhrase || !trace) return;
  const canvas = document.getElementById("share-canvas") as HTMLCanvasElement;
  const row = document.getElementById("share-row")!;
  try {
    await renderShareCanvas(
      canvas, PORTRAIT_URL, trace,
      { score: lastReport.score, meanCentsError: lastReport.meanCentsError },
      `${todayKey()} · Chorale ${currentPhrase.chorale} ${currentPhrase.part}${currentPhrase.phrase}`,
    );
    canvas.hidden = false;
    row.hidden = false;
    const dl = document.getElementById("dl-btn") as HTMLButtonElement;
    dl.onclick = () => {
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `bachday-${todayKey()}.png`;
      a.click();
    };
  } catch (e) {
    console.warn("share canvas failed", e);
  }
}

function renderHistory() {
  const root = document.getElementById("history")!;
  const entries = loadHistory().slice(0, 10);
  if (entries.length === 0) {
    root.innerHTML = `<p class="muted">No attempts yet.</p>`;
    return;
  }
  root.innerHTML =
    `<h3>Recent attempts</h3>
     <table><thead><tr><th>Date</th><th>Phrase</th><th>Score</th><th>Mean error</th></tr></thead>
     <tbody>${entries.map((e) =>
       `<tr><td>${e.date}</td><td>Ch.${e.chorale} ${e.part}${e.phrase}</td>` +
       `<td>${(e.score * 100).toFixed(0)}%</td><td>${e.meanCentsError.toFixed(0)}¢</td></tr>`,
     ).join("")}</tbody></table>`;
}

main();
