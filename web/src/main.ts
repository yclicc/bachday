import abcjs from "abcjs";
import {
  VOICE_TYPES, chooseTransposition, chooseClef, CLEF_STAFF_OFFSET,
  type VoiceType,
} from "./voice";
import { phraseForDate, randomPhrase, todayKey, type Dataset, type PhraseRow } from "./schedule";
import {
  addSolfegeLyrics, setAbcClef, extractKey, midiToAbcToken,
  abcSourceNoteSequence,
  type VisualObj,
} from "./abc";
import { tonicPc } from "./solfege";
import { LivePitchDetector, preloadCrepe } from "./pitch";
import { LiveTraceRenderer } from "./live-trace";
import { playDoSolDo, pickTonicMidi } from "./cue";
import { renderShareCanvas, type AccuracyReport } from "./accuracy";
import { loadPrefs, savePrefs, loadHistory, appendHistory, type Prefs } from "./storage";
import type { SolfegeMode } from "./solfege";

const PORTRAIT_URL = "/bach.jpg";
let prefs: Prefs = loadPrefs();
let dataset: Dataset = { chorales: {}, lyrics: {}, phrases: [] };
let currentPhrase: PhraseRow | null = null;
let currentMode: "daily" | "shuffle" = "daily";
let currentTranspose = 0;
let currentVisual: VisualObj | null = null;
let trace: LiveTraceRenderer | null = null;
let lastReport: AccuracyReport | null = null;

async function main() {
  try {
    const raw = await (await fetch("/phrases.json")).json();
    dataset = Array.isArray(raw)
      ? { chorales: {}, lyrics: {}, phrases: raw as PhraseRow[] }
      : (raw as Dataset);
  } catch {
    document.getElementById("app")!.innerHTML =
      `<p>Could not load <code>phrases.json</code>. Run <code>uv run python process_dataset.py</code> and copy the result to <code>web/public/phrases.json</code>.</p>`;
    return;
  }
  wireSettingsButton();
  if (!prefs.onboarded || !prefs.voice) {
    openOnboarding();
  } else {
    loadDaily();
  }
  preloadCrepe();
}

function loadDaily() {
  currentMode = "daily";
  currentPhrase = phraseForDate(dataset.phrases);
  renderPhraseView();
}

function loadShuffle() {
  currentMode = "shuffle";
  currentPhrase = randomPhrase(dataset.phrases);
  renderPhraseView();
}

function wireSettingsButton() {
  const btn = document.getElementById("settings-btn") as HTMLButtonElement;
  btn.onclick = () => openSettings();
}

function partLabel(p: "S" | "A" | "T" | "B"): string {
  return { S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" }[p];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

/* ------------------------------------------------------------- *
 *  Modal helpers
 * ------------------------------------------------------------- */

function closeModal() {
  const root = document.getElementById("modal-root")!;
  root.innerHTML = "";
}

function openModal(content: HTMLElement, opts: { dismissible?: boolean } = {}) {
  const root = document.getElementById("modal-root")!;
  root.innerHTML = "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  if (opts.dismissible !== false) {
    backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
  }
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.appendChild(content);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
}

function buildChoiceGrid<T extends string>(
  values: readonly { value: T; label: string }[],
  current: T | null,
  onPick: (v: T) => void,
): HTMLDivElement {
  const grid = document.createElement("div");
  grid.className = "choice-grid";
  for (const { value, label } of values) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice" + (value === current ? " selected" : "");
    b.textContent = label;
    b.onclick = () => {
      onPick(value);
      grid.querySelectorAll(".choice").forEach((el) => el.classList.remove("selected"));
      b.classList.add("selected");
    };
    grid.appendChild(b);
  }
  return grid;
}

function buildSwitch(checked: boolean, onChange: (v: boolean) => void): HTMLDivElement {
  const sw = document.createElement("div");
  sw.className = "switch" + (checked ? " on" : "");
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(checked));
  sw.tabIndex = 0;
  const toggle = () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  };
  sw.onclick = toggle;
  sw.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } };
  return sw;
}

/* ------------------------------------------------------------- *
 *  Onboarding modal — asked on first visit only.
 * ------------------------------------------------------------- */

function openOnboarding() {
  const content = document.createElement("div");
  content.innerHTML = `
    <h2>Welcome to BachDay</h2>
    <p>One Bach chorale phrase a day, transposed for your voice, sung by you. Let's set up.</p>
  `;

  let pickedVoice: VoiceType | null = prefs.voice;
  let pickedSolfege: SolfegeMode = prefs.solfege ?? "all";
  let pickedEasy = !!prefs.showTargetWhileSinging;

  const voiceField = document.createElement("div");
  voiceField.className = "field";
  voiceField.innerHTML = `<label class="field-label">Your voice type</label>`;
  voiceField.appendChild(buildChoiceGrid(
    VOICE_TYPES.map((v) => ({ value: v, label: v })),
    pickedVoice,
    (v) => { pickedVoice = v; (content.querySelector("#go-btn") as HTMLButtonElement).disabled = false; },
  ));

  const solfegeField = document.createElement("div");
  solfegeField.className = "field";
  solfegeField.innerHTML = `<label class="field-label">Solfege lyrics</label>`;
  solfegeField.appendChild(buildChoiceGrid<SolfegeMode>(
    [
      { value: "none", label: "None" },
      { value: "chromatic", label: "Chromatic only" },
      { value: "all", label: "All notes" },
    ],
    pickedSolfege,
    (v) => { pickedSolfege = v; },
  ));

  const easyField = document.createElement("div");
  easyField.className = "field";
  const easyRow = document.createElement("div");
  easyRow.className = "switch-row";
  const easyLabel = document.createElement("div");
  easyLabel.innerHTML = `<div class="switch-label">Easy mode</div><div class="switch-sub">Show target pitches while singing (not a true sight-read)</div>`;
  easyRow.append(easyLabel, buildSwitch(pickedEasy, (b) => { pickedEasy = b; }));
  easyField.appendChild(easyRow);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const goBtn = document.createElement("button");
  goBtn.id = "go-btn";
  goBtn.textContent = "Start";
  goBtn.disabled = !pickedVoice;
  goBtn.onclick = () => {
    if (!pickedVoice) return;
    prefs.voice = pickedVoice;
    prefs.solfege = pickedSolfege;
    prefs.showTargetWhileSinging = pickedEasy;
    prefs.onboarded = true;
    savePrefs(prefs);
    closeModal();
    loadDaily();
  };
  actions.appendChild(goBtn);

  content.append(voiceField, solfegeField, easyField, actions);
  openModal(content, { dismissible: false });
}

/* ------------------------------------------------------------- *
 *  Settings modal — same controls, reached via the gear icon.
 * ------------------------------------------------------------- */

function openSettings() {
  const content = document.createElement("div");
  content.innerHTML = `<h2>Settings</h2><p>Changes take effect immediately.</p>`;

  const voiceField = document.createElement("div");
  voiceField.className = "field";
  voiceField.innerHTML = `<label class="field-label">Voice type</label>`;
  voiceField.appendChild(buildChoiceGrid(
    VOICE_TYPES.map((v) => ({ value: v, label: v })),
    prefs.voice,
    (v) => { prefs.voice = v; savePrefs(prefs); renderPhraseView(); },
  ));

  const solfegeField = document.createElement("div");
  solfegeField.className = "field";
  solfegeField.innerHTML = `<label class="field-label">Solfege lyrics</label>`;
  solfegeField.appendChild(buildChoiceGrid<SolfegeMode>(
    [
      { value: "none", label: "None" },
      { value: "chromatic", label: "Chromatic only" },
      { value: "all", label: "All notes" },
    ],
    prefs.solfege,
    (v) => { prefs.solfege = v; savePrefs(prefs); renderPhraseView(); },
  ));

  const toggles = document.createElement("div");
  toggles.className = "field";
  const easyRow = document.createElement("div");
  easyRow.className = "switch-row";
  const easyLabel = document.createElement("div");
  easyLabel.innerHTML = `<div class="switch-label">Easy mode</div><div class="switch-sub">Show target pitches while you sing</div>`;
  easyRow.append(easyLabel, buildSwitch(!!prefs.showTargetWhileSinging, (b) => {
    prefs.showTargetWhileSinging = b; savePrefs(prefs); trace?.setShowTargetWhileSinging(b);
  }));
  toggles.append(easyRow);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const doneBtn = document.createElement("button");
  doneBtn.textContent = "Done";
  doneBtn.onclick = closeModal;
  actions.appendChild(doneBtn);

  content.append(voiceField, solfegeField, toggles, actions);
  openModal(content);
}

/* ------------------------------------------------------------- *
 *  Key reference incipit — a tiny do – so – do staff that shows
 *  the exact pitches the cue button plays, in the same clef the
 *  music uses. We write the source notes at `sounding - transpose`
 *  so that with the same `visualTranspose` applied as the main
 *  score, the displayed staff position matches the cue pitch.
 * ------------------------------------------------------------- */
function buildKeyReferenceAbc(
  sourceKey: string, clef: string, currentTranspose: number, cueTonicMidi: number,
): string {
  // The cue plays tonic – dominant – tonic at the same octave.
  const targets = [cueTonicMidi, cueTonicMidi + 7, cueTonicMidi];
  const tokens = targets.map((sounding) =>
    midiToAbcToken(sounding - currentTranspose, sourceKey),
  );
  return [
    "X:1",
    "M:none",
    "L:1/2",
    `K:${sourceKey} clef=${clef}`,
    `"do"${tokens[0]} "so"${tokens[1]} "do"${tokens[2]} |]`,
  ].join("\n");
}

/* ------------------------------------------------------------- *
 *  Chorale lyrics — full text per verse, with the slice of text
 *  belonging to the currently-displayed phrase shown in bold.
 * ------------------------------------------------------------- */

/** Join syllables into running text. Trailing `-` glues to the next
 * syllable (no space); `*` is a melisma continuation marker — skip it. */
function syllablesToText(syllables: string[]): string {
  let out = "";
  let buf = "";
  const flush = () => { if (buf) { out += (out ? " " : "") + buf; buf = ""; } };
  for (const s of syllables) {
    if (s === "*") continue;
    if (s.endsWith("-")) buf += s.slice(0, -1);
    else { buf += s; flush(); }
  }
  flush();
  return out;
}

function buildChoraleLyricsHtml(phrase: PhraseRow): string {
  const prefix = `${phrase.chorale}.`;
  const phraseKeys = Object.keys(dataset.lyrics)
    .filter((k) => k.startsWith(prefix))
    .sort();
  if (!phraseKeys.length) return "";

  const currentKey = `${phrase.chorale}.${phrase.phrase}`;
  // Max number of verses across all phrases — drives how many full passes
  // we render. Phrases that lack a given verse fall back to their first,
  // which avoids gaps for chorales where only some phrases have a second
  // stanza recorded.
  let maxV = 0;
  for (const k of phraseKeys) maxV = Math.max(maxV, dataset.lyrics[k].length);
  if (maxV === 0) return "";

  const verses: string[] = [];
  for (let v = 0; v < maxV; v++) {
    const segments: string[] = [];
    for (const k of phraseKeys) {
      const allVerses = dataset.lyrics[k];
      // Within a single phrase we may have multiple internal verses (a
      // written-out repeat with a fresh stanza). For the chorale-wide pass v,
      // take that index if available, otherwise fall back to verse 0.
      const text = syllablesToText(allVerses[v] ?? allVerses[0] ?? []);
      if (!text) continue;
      const escaped = escapeHtml(text);
      segments.push(k === currentKey ? `<strong>${escaped}</strong>` : escaped);
    }
    if (segments.length) verses.push(segments.join(" "));
  }
  if (!verses.length) return "";

  const inner = verses
    .map((v, i) => maxV > 1
      ? `<p class="verse"><span class="verse-num">${i + 1}.</span> ${v}</p>`
      : `<p class="verse">${v}</p>`)
    .join("");
  return `<section class="lyrics" id="lyrics-section"><h3>Chorale text</h3>${inner}</section>`;
}

/* ------------------------------------------------------------- *
 *  Phrase view
 * ------------------------------------------------------------- */

function renderPhraseView() {
  if (!prefs.voice) return openOnboarding();
  if (!currentPhrase) currentPhrase = phraseForDate(dataset.phrases);

  currentTranspose = chooseTransposition(
    currentPhrase.ambitus_lo, currentPhrase.ambitus_hi, prefs.voice, currentPhrase.part,
  );
  const soundingLo = currentPhrase.ambitus_lo + currentTranspose;
  const soundingHi = currentPhrase.ambitus_hi + currentTranspose;
  const clef = chooseClef(prefs.voice, soundingLo, soundingHi);
  const staffOffset = CLEF_STAFF_OFFSET[clef] ?? 0;
  // Strip T: title lines — the chorale title is rendered above the score in
  // the page chrome, so duplicating it inside the staff is just noise.
  const abcNoTitle = currentPhrase.abc
    .split("\n")
    .filter((line) => !/^T:/.test(line))
    .join("\n");
  const abcWithClef = setAbcClef(abcNoTitle, clef);

  const abcWithLyrics = addSolfegeLyrics(abcWithClef, prefs.solfege);
  const sourceKey = extractKey(currentPhrase.abc);
  const sourceTonicPc = tonicPc(sourceKey).pc;
  const transposedTonicPc = ((sourceTonicPc + currentTranspose) % 12 + 12) % 12;
  // Anchor the cue to where the phrase actually sits, not the voice's
  // midpoint. A bass phrase that lives down at MIDI 40 should hear its
  // tonic in that register, not a fifth above where the singer would
  // otherwise need to drop down to enter the line.
  const phraseMid = (soundingLo + soundingHi) / 2;
  const cueTonicMidi = pickTonicMidi(transposedTonicPc, phraseMid);
  const referenceAbc = buildKeyReferenceAbc(sourceKey, clef, currentTranspose, cueTonicMidi);
  const lyricsHtml = buildChoraleLyricsHtml(currentPhrase);

  const choraleInfo = dataset.chorales[String(currentPhrase.chorale)];
  const choraleTitle = choraleInfo?.title ?? `BWV ${currentPhrase.chorale}`;
  const modeBadge = currentMode === "shuffle" ? ` <span class="muted">(shuffle)</span>` : "";

  const app = document.getElementById("app")!;
  app.innerHTML = `
    <section class="fade-in" id="phrase-section">
      <div class="title-row">
        <h2>${escapeHtml(choraleTitle)}${modeBadge}</h2>
      </div>
      <div class="meta">
        BWV ${currentPhrase.chorale} · ${partLabel(currentPhrase.part)} · phrase ${currentPhrase.phrase}
        · ${currentTranspose >= 0 ? "+" : ""}${currentTranspose} semitones for ${prefs.voice} · ${clef} clef
      </div>
      <div class="key-ref-wrap">
        <div class="key-ref-label">
          <span class="key-ref-title">Key</span>
          <span class="key-ref-sub">do – so – do</span>
        </div>
        <div id="key-ref" class="key-ref" aria-label="Key reference: do, so, do"></div>
      </div>
      <div id="score"></div>
      <div class="controls-bar">
        <button id="cue-btn" class="secondary">♪ do – so – do</button>
        ${prefs.showTargetWhileSinging ? `<button id="practice-btn" class="secondary">◐ Practice</button>` : ""}
        <button id="rec-btn">● Record</button>
        <span class="spacer"></span>
        <button id="shuffle-btn" class="secondary" title="Pick a random phrase">⇄ Shuffle</button>
        <button id="daily-btn" class="secondary" ${currentMode === "daily" ? "hidden" : ""}>Today's phrase</button>
      </div>
      <div class="row" id="rec-status-row"><span id="rec-status" class="muted"></span></div>
      <canvas id="trace-canvas"></canvas>
      <div class="row" id="score-row" hidden>
        <span id="score-text" class="score-pill"></span>
      </div>
      ${lyricsHtml}
      <canvas id="share-canvas" hidden></canvas>
      <div class="row" id="share-row" hidden>
        <button id="dl-btn" class="secondary">Download share image</button>
      </div>
      <section class="history" id="history"></section>
    </section>
  `;
  abcjs.renderAbc("key-ref", referenceAbc, {
    visualTranspose: currentTranspose + staffOffset,
    staffwidth: 180,
    scale: 0.7,
    paddingleft: 0,
    paddingright: 0,
    paddingtop: 0,
    paddingbottom: 0,
  });
  const rendered = abcjs.renderAbc("score", abcWithLyrics, {
    visualTranspose: currentTranspose + staffOffset,
    responsive: "resize",
    staffwidth: 720,
    add_classes: true,
  });
  currentVisual = (rendered[0] as VisualObj) ?? null;

  wireCue();
  wireRecorder();
  wirePractice();
  (document.getElementById("shuffle-btn") as HTMLButtonElement).onclick = loadShuffle;
  const dailyBtn = document.getElementById("daily-btn") as HTMLButtonElement | null;
  if (dailyBtn) dailyBtn.onclick = loadDaily;
  renderHistory();
}

function wirePractice() {
  const btn = document.getElementById("practice-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const detector = new LivePitchDetector();
  let active = false;
  btn.onclick = async () => {
    if (!active) {
      try {
        await detector.start((p) => trace?.addPoint(p));
      } catch (e) {
        btn.textContent = `! ${(e as Error).message}`;
        return;
      }
      active = true;
      trace?.resetPoints();
      trace?.setPracticeMode(true);
      btn.textContent = "■ Stop practice";
      btn.classList.remove("secondary");
    } else {
      await detector.stop();
      active = false;
      trace?.setPracticeMode(false);
      trace?.resetPoints();
      btn.textContent = "◐ Practice";
      btn.classList.add("secondary");
    }
  };
}

function wireCue() {
  const btn = document.getElementById("cue-btn") as HTMLButtonElement;
  btn.onclick = () => {
    if (!currentPhrase || !prefs.voice) return;
    const mid = (currentPhrase.ambitus_lo + currentPhrase.ambitus_hi) / 2 + currentTranspose;
    playDoSolDo(currentPhrase.abc, currentTranspose, mid);
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
    scoreText.innerHTML =
      `${hits}/${perNote.length} within ±60¢` +
      (meanCentsError > 0 ? ` <span class="err">· mean ${meanCentsError.toFixed(0)}¢</span>` : "");

    lastReport = { score, meanCentsError, frames: [] };
    if (currentMode === "daily") {
      appendHistory({
        date: todayKey(),
        chorale: currentPhrase!.chorale,
        part: currentPhrase!.part,
        phrase: currentPhrase!.phrase,
        score,
        meanCentsError,
      });
      renderHistory();
    }
    await drawShare();
  };
}

async function drawShare() {
  if (!lastReport || !currentPhrase || !trace) return;
  const canvas = document.getElementById("share-canvas") as HTMLCanvasElement;
  const row = document.getElementById("share-row")!;
  const choraleInfo = dataset.chorales[String(currentPhrase.chorale)];
  const choraleTitle = choraleInfo?.title ?? `BWV ${currentPhrase.chorale}`;
  try {
    await renderShareCanvas(
      canvas, PORTRAIT_URL, trace,
      { score: lastReport.score, meanCentsError: lastReport.meanCentsError },
      {
        title: choraleTitle,
        subtitle: `BWV ${currentPhrase.chorale} · ${partLabel(currentPhrase.part)} · phrase ${currentPhrase.phrase}`,
        date: todayKey(),
      },
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
