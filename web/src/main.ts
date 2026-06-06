import abcjs from "abcjs";
import {
  VOICE_TYPES, VOICE_LABEL, chooseTransposition, chooseClef, CLEF_STAFF_OFFSET,
  type VoiceType,
} from "./voice";
import {
  phraseForDate, randomPhrase, todayKey, parsePermalink, findPhrase, permalinkFor,
  type Dataset, type PhraseRow,
} from "./schedule";
import {
  addSolfegeLyrics, setAbcClef, extractKey, midiToAbcToken,
  abcSourceNoteSequence, keyAccidentalsForKeyString,
  type VisualObj,
} from "./abc";
import { tonicPc, solfegeForSpelling, accidentalDirection } from "./solfege";
import { LivePitchDetector, preloadCrepe, setPreferredBackend } from "./pitch";
import { LiveTraceRenderer } from "./live-trace";
import { playDoSolDo, pickTonicMidi } from "./cue";
import { renderShareCanvas, type AccuracyReport } from "./accuracy";
import { loadPrefs, savePrefs, loadHistory, appendHistory, type Prefs } from "./storage";
import type { SolfegeMode } from "./solfege";

const PORTRAIT_URL = new URL("bach.jpg", document.baseURI).toString();
let prefs: Prefs = loadPrefs();
let dataset: Dataset = { chorales: {}, lyrics: {}, phrases: [] };
let currentPhrase: PhraseRow | null = null;
let currentMode: "daily" | "shuffle" | "permalink" = "daily";
let currentTranspose = 0;
/** When non-null, overrides the voice-derived transposition (set via the
 *  `&t=` permalink parameter). Cleared whenever we move to a new phrase via
 *  the daily/shuffle buttons. */
let customTranspose: number | null = null;
let currentVisual: VisualObj | null = null;
let trace: LiveTraceRenderer | null = null;
let lastReport: AccuracyReport | null = null;
/** 1-indexed attempt counter for the current phrase, bumped on each recording.
 *  Resets to 0 every time we navigate to a new phrase. */
let attemptNum = 0;
/** Which screen is currently mounted in #app. Each new phrase decides whether
 *  to show the warm-up page first (if either warm-up toggle is on) before
 *  routing to the score view. Settings changes re-render the current screen
 *  in place rather than replaying the warm-up. */
let currentScreen: "warmup" | "phrase" = "phrase";
/** The mic-listening detector currently owned by the active screen. There is
 *  at most one at a time — warm-up practice, on-page practice and recording
 *  all share this slot, and switching modes (or navigating away, or
 *  re-rendering on a settings change) tears the previous one down before
 *  starting the next. Inflight pitch frames from a stopped detector are
 *  suppressed inside {@link LivePitchDetector.stop} so they can't leak into
 *  the new screen. */
let activeDetector: LivePitchDetector | null = null;
type TakeMode = "idle" | "warmup" | "practice" | "recording";
let activeMode: TakeMode = "idle";

/** Stop whichever detector currently owns the mic (if any) and clear the
 *  module-level slot. Fire-and-forget — callers don't await because
 *  {@link LivePitchDetector.stop} suppresses any further callbacks
 *  synchronously via its `stopped` flag. */
function stopActiveDetector(): Promise<void> {
  const d = activeDetector;
  activeDetector = null;
  activeMode = "idle";
  return d ? d.stop().then(() => undefined) : Promise.resolve();
}

async function main() {
  try {
    const raw = await (await fetch(new URL("phrases.json", document.baseURI))).json();
    dataset = Array.isArray(raw)
      ? { chorales: {}, lyrics: {}, phrases: raw as PhraseRow[] }
      : (raw as Dataset);
  } catch {
    document.getElementById("app")!.innerHTML =
      `<p>Could not load <code>phrases.json</code>. Run <code>uv run python process_dataset.py</code> and copy the result to <code>web/public/phrases.json</code>.</p>`;
    return;
  }
  wireSettingsButton();
  window.addEventListener("hashchange", () => {
    if (!tryLoadFromHash() && currentMode === "permalink") loadDaily();
  });
  if (!prefs.onboarded || !prefs.voice) {
    // First-boot flow: show the info / consent page before onboarding so the
    // user knows what we store before they hand over a voice preference.
    openInfo({ initial: true });
  } else if (!tryLoadFromHash()) {
    loadDaily();
  }
  preloadCrepe();
  // Console escape hatches: `crepe()` or `yin()` from devtools persist the
  // chosen backend for this device (used by LivePitchDetector on next start).
  (window as unknown as { crepe: () => void; yin: () => void }).crepe = () => setPreferredBackend("crepe");
  (window as unknown as { crepe: () => void; yin: () => void }).yin = () => setPreferredBackend("yin");
}

/** Try to navigate to the phrase encoded in the URL hash. Returns true if a
 *  valid permalink was found and loaded. */
function tryLoadFromHash(): boolean {
  const pl = parsePermalink();
  if (!pl) return false;
  const row = findPhrase(dataset.phrases, pl);
  if (!row) return false;
  currentMode = "permalink";
  currentPhrase = row;
  customTranspose = pl.transpose ?? null;
  attemptNum = 0;
  enterPhrase();
  return true;
}

/** Decide between the warm-up page and the score view for a freshly-loaded
 *  phrase. Settings that change the warm-up toggles take effect from the next
 *  phrase load — they don't yank the user back to the warm-up of the current
 *  one. */
function enterPhrase() {
  void stopActiveDetector();
  if (prefs.showReferencePitch || prefs.showWarmupScale) {
    currentScreen = "warmup";
    renderWarmupPage();
  } else {
    currentScreen = "phrase";
    renderPhraseView();
  }
}

function renderCurrentScreen() {
  if (currentScreen === "warmup") renderWarmupPage();
  else renderPhraseView();
}

function loadDaily() {
  currentMode = "daily";
  customTranspose = null;
  attemptNum = 0;
  currentPhrase = phraseForDate(dataset.phrases);
  if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  enterPhrase();
}

function loadShuffle() {
  currentMode = "shuffle";
  customTranspose = null;
  attemptNum = 0;
  currentPhrase = randomPhrase(dataset.phrases);
  if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  enterPhrase();
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

/* ------------------------------------------------------------- *
 *  Info / consent modal — shown on first visit before any preferences are
 *  saved, and reachable later from a button in the settings page.
 * ------------------------------------------------------------- */

function openInfo({ initial }: { initial: boolean }) {
  const content = document.createElement("div");
  content.innerHTML = `
    <h2>About BachDay</h2>
    <p class="info-block">
      A new Bach chorale phrase every day — transposed for your voice, lyrics
      with movable-do solfege, and live pitch feedback when you sing along.
    </p>
    <h3 class="info-h">A note on storage</h3>
    <p class="info-block">
      BachDay stores your voice type, preferences and recent attempt history
      in your browser's local storage (similar to a cookie). Nothing leaves
      your device. By using the site you consent to this local storage.
    </p>
    <h3 class="info-h">Acknowledgements</h3>
    <p class="info-block">
      Pitch detection runs the
      <a href="https://github.com/marl/crepe" target="_blank" rel="noopener">CREPE</a>
      model in your browser when device performance allows, with a YIN
      autocorrelation fallback on lower-power devices. Thank you to the
      authors of both:
    </p>
    <p class="citation">
      Jong Wook Kim, Justin Salamon, Peter Li, Juan Pablo Bello.
      <em>CREPE: A Convolutional Representation for Pitch Estimation.</em>
      Proceedings of the IEEE International Conference on Acoustics, Speech,
      and Signal Processing (ICASSP), 2018.
    </p>
    <details class="license">
      <summary>CREPE license (MIT)</summary>
      <pre class="license-text">The MIT License (MIT)

Copyright (c) 2018 Jong Wook Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.</pre>
    </details>
    <p class="citation">
      Alain de Cheveigné and Hideki Kawahara.
      <em>YIN, a fundamental frequency estimator for speech and music.</em>
      Journal of the Acoustical Society of America, 111(4):1917–1930, 2002.
    </p>
    <p class="info-block">
      The phrase dataset was extracted from the Bach chorales using
      <a href="https://www.music21.org/" target="_blank" rel="noopener">music21</a>.
      Thank you to its authors:
    </p>
    <p class="citation">
      Michael Scott Cuthbert and Christopher Ariza.
      <em>music21: A Toolkit for Computer-Aided Musicology and Symbolic Music
      Data.</em> Proceedings of the 11th International Society for Music
      Information Retrieval Conference (ISMIR 2010), Utrecht, Netherlands,
      pp. 637–642.
    </p>
    <p class="info-block">
      The Bach chorale source files in the music21 corpus derive from the
      MusicXML transcriptions made by the late Margaret Greentree.
      Without such diligent work, this project wouldn't have been possible.
    </p>
  `;

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const btn = document.createElement("button");
  btn.textContent = initial ? "I understand — continue" : "Close";
  btn.onclick = () => {
    closeModal();
    if (initial) openOnboarding();
  };
  actions.appendChild(btn);
  content.appendChild(actions);

  // Initial flow must not be dismissed by a backdrop click — the user has to
  // make an active choice. From settings the modal is freely dismissible.
  openModal(content, { dismissible: !initial });
}

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
    VOICE_TYPES.map((v) => ({ value: v, label: VOICE_LABEL[v] })),
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
    VOICE_TYPES.map((v) => ({ value: v, label: VOICE_LABEL[v] })),
    prefs.voice,
    (v) => { prefs.voice = v; savePrefs(prefs); renderCurrentScreen(); },
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
    (v) => { prefs.solfege = v; savePrefs(prefs); renderCurrentScreen(); },
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

  const warmupRow = document.createElement("div");
  warmupRow.className = "switch-row";
  const warmupLabel = document.createElement("div");
  warmupLabel.innerHTML = `<div class="switch-label">Warm-up scale</div><div class="switch-sub">Show an ascending scale in the upcoming key</div>`;
  warmupRow.append(warmupLabel, buildSwitch(!!prefs.showWarmupScale, (b) => {
    prefs.showWarmupScale = b; savePrefs(prefs); renderCurrentScreen();
  }));

  const refRow = document.createElement("div");
  refRow.className = "switch-row";
  const refLabel = document.createElement("div");
  refLabel.innerHTML = `<div class="switch-label">Reference pitch</div><div class="switch-sub">Show G4 (women) or G3 (men) labelled by scale degree — for ear training</div>`;
  refRow.append(refLabel, buildSwitch(!!prefs.showReferencePitch, (b) => {
    prefs.showReferencePitch = b; savePrefs(prefs); renderCurrentScreen();
  }));

  toggles.append(easyRow, refRow, warmupRow);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const infoBtn = document.createElement("button");
  infoBtn.className = "secondary";
  infoBtn.textContent = "About & credits";
  infoBtn.onclick = () => openInfo({ initial: false });
  const doneBtn = document.createElement("button");
  doneBtn.textContent = "Done";
  doneBtn.onclick = closeModal;
  actions.append(infoBtn, doneBtn);

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
  sourceKey: string, clef: string, currentTranspose: number, cueTonicMidi: number, minor: boolean,
): string {
  // The cue plays tonic – dominant – tonic at the same octave. In la-based
  // minor those degrees are la – mi – la.
  const targets = [cueTonicMidi, cueTonicMidi + 7, cueTonicMidi];
  const tokens = targets.map((sounding) =>
    midiToAbcToken(sounding - currentTranspose, sourceKey),
  );
  const [t1, dom, t2] = minor ? ["la", "mi", "la"] : ["do", "so", "do"];
  return [
    "X:1",
    "M:none",
    "L:1/2",
    `K:${sourceKey} clef=${clef}`,
    `"${t1}"${tokens[0]} "${dom}"${tokens[1]} "${t2}"${tokens[2]} |]`,
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

/* ------------------------------------------------------------- *
 *  Warm-up page — shown before the score view whenever the reference-pitch
 *  or warm-up-scale toggle is on. Practice mode is already running so the
 *  singer can hum along to the reference and the ascending scale before
 *  meeting the phrase itself. Click "Continue" to reach the score.
 * ------------------------------------------------------------- */

function renderWarmupPage() {
  if (!prefs.voice) return openOnboarding();
  if (!currentPhrase) currentPhrase = phraseForDate(dataset.phrases);

  const transpose = customTranspose ?? chooseTransposition(
    currentPhrase.ambitus_lo, currentPhrase.ambitus_hi, prefs.voice, currentPhrase.part,
  );
  const soundingLo = currentPhrase.ambitus_lo + transpose;
  const soundingHi = currentPhrase.ambitus_hi + transpose;
  const clef = chooseClef(prefs.voice, soundingLo, soundingHi);
  const staffOffset = CLEF_STAFF_OFFSET[clef] ?? 0;
  const sourceKey = extractKey(currentPhrase.abc);
  const { pc: sourceTonicPc, minor } = tonicPc(sourceKey);
  const transposedTonicPc = ((sourceTonicPc + transpose) % 12 + 12) % 12;
  const phraseMid = (soundingLo + soundingHi) / 2;
  // Anchor the scale's *midpoint* on the phrase midpoint — i.e. target a
  // tonic six semitones below it, so the resulting one-octave scale sits
  // roughly symmetrically around what the singer is about to sing. Earlier
  // we anchored on the phrase floor and basses got handed a scale a full
  // octave below their working range.
  const warmupTonicMidi = pickTonicMidi(transposedTonicPc, phraseMid - 6);
  const refMidi = referenceMidiForVoice(prefs.voice);

  const choraleInfo = dataset.chorales[String(currentPhrase.chorale)];
  const choraleTitle = choraleInfo?.title ?? `BWV ${currentPhrase.chorale}`;
  // Pick the reference-pitch syllable from the spelling abcjs will actually
  // render: a flat — or a natural that cancels a sharp key-sig accidental —
  // reads as a lowered chromatic step ("ra"), while a sharp (or a natural
  // cancelling a flat) reads as a raised one ("di").
  const refKey = pcToKeyString(transposedTonicPc, minor);
  const refTok = midiToAbcToken(refMidi, refKey);
  const refAccMatch = refTok.match(/^(\^\^|\^|__|_|=)/);
  const refLetterMatch = refTok.match(/[A-Ga-g]/);
  const refLetter = (refLetterMatch?.[0] ?? "C").toUpperCase();
  const refKeyAcc = keyAccidentalsForKeyString(refKey);
  const refDir = accidentalDirection(refAccMatch?.[0] ?? "", refKeyAcc.get(refLetter) ?? 0);
  const refSyll = solfegeForSpelling(refMidi, transposedTonicPc, minor, refDir);

  const refHtml = prefs.showReferencePitch
    ? `<section class="warmup-card">
        <div class="warmup-card-head">
          <span class="warmup-card-title">Reference pitch</span>
          <button id="warmup-ref-play" class="secondary tiny">▶ Play</button>
        </div>
        <div id="warmup-ref-staff" class="warmup-staff"></div>
        <p class="warmup-card-sub">${midiToNoteName(refMidi)} is "<strong>${refSyll}</strong>" in the upcoming key.</p>
      </section>`
    : "";

  const scaleHtml = prefs.showWarmupScale
    ? `<section class="warmup-card">
        <div class="warmup-card-head">
          <span class="warmup-card-title">Warm-up scale</span>
          <button id="warmup-scale-play" class="secondary tiny">▶ Play</button>
        </div>
        <div id="warmup-scale-staff" class="warmup-staff"></div>
        <p class="warmup-card-sub">Sing along — the tuner below colours your pitch.</p>
      </section>`
    : "";

  const app = document.getElementById("app")!;
  app.innerHTML = `
    <section class="fade-in warmup-page">
      <div class="title-row"><h2>Warm-up</h2></div>
      <div class="meta">Up next · ${escapeHtml(choraleTitle)} · BWV ${currentPhrase.chorale} · ${partLabel(currentPhrase.part)} · phrase ${currentPhrase.phrase}</div>
      ${refHtml}
      ${scaleHtml}
      <canvas id="warmup-trace-canvas"></canvas>
      <div class="controls-bar">
        <span class="spacer"></span>
        <button id="warmup-continue-btn">Continue to phrase →</button>
      </div>
    </section>
  `;

  if (prefs.showReferencePitch) {
    // Render the reference straight in the sounding key with no transpose —
    // what we write is what we see, so refMidi shows up at exactly that
    // staff position. The clef (treble vs bass) is chosen inside the builder
    // based on the pitch so the note never lands on ledger lines.
    abcjs.renderAbc("warmup-ref-staff", buildReferenceAbc(transposedTonicPc, minor, refMidi), {
      staffwidth: 140, scale: 0.8,
      paddingleft: 0, paddingright: 0, paddingtop: 0, paddingbottom: 0,
    });
    (document.getElementById("warmup-ref-play") as HTMLButtonElement).onclick = () =>
      playReferencePitch(refMidi);
  }
  if (prefs.showWarmupScale) {
    abcjs.renderAbc("warmup-scale-staff", buildWarmupAbc(sourceKey, clef, transpose, warmupTonicMidi, minor), {
      visualTranspose: transpose + staffOffset,
      staffwidth: 360, scale: 0.8,
      paddingleft: 0, paddingright: 0, paddingtop: 0, paddingbottom: 0,
    });
    (document.getElementById("warmup-scale-play") as HTMLButtonElement).onclick = () =>
      playScale(warmupTonicMidi, minor);
  }

  // Practice tuner uses the warm-up scale as its target so the singer sees
  // green when they hit any scale degree of the upcoming key.
  const offs = minor ? MINOR_SCALE_OFFSETS : MAJOR_SCALE_OFFSETS;
  const scaleTargets = offs.map((o) => ({ midi: warmupTonicMidi + o, duration: 1 }));
  const canvas = document.getElementById("warmup-trace-canvas") as HTMLCanvasElement;
  const warmupTrace = new LiveTraceRenderer(canvas, scaleTargets, 4, {
    showTargetWhileSinging: true,
    tonicPc: transposedTonicPc,
  });
  warmupTrace.setPracticeMode(true);
  if (prefs.showReferencePitch) warmupTrace.setReferencePitch(refMidi);

  void stopActiveDetector().then(() => {
    const d = new LivePitchDetector();
    activeDetector = d;
    activeMode = "warmup";
    d.start((p) => { if (activeDetector === d) warmupTrace.addPoint(p); })
      .catch((e) => {
        if (activeDetector === d) { activeDetector = null; activeMode = "idle"; }
        console.warn("warm-up practice mic failed:", e);
      });
  });

  (document.getElementById("warmup-continue-btn") as HTMLButtonElement).onclick = () => {
    void stopActiveDetector();
    currentScreen = "phrase";
    renderPhraseView();
  };
}

function renderPhraseView() {
  if (!prefs.voice) return openOnboarding();
  if (!currentPhrase) currentPhrase = phraseForDate(dataset.phrases);
  // Settings changes re-render this screen mid-flow. Tear down any in-progress
  // take so the leftover detector can't keep pushing pitch frames into the
  // fresh canvas + trace we're about to mount.
  void stopActiveDetector();

  currentTranspose = customTranspose ?? chooseTransposition(
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
  const isMinor = tonicPc(sourceKey).minor;
  const tonicLabel = isMinor ? "la" : "do";
  const dominantLabel = isMinor ? "mi" : "so";
  const referenceAbc = buildKeyReferenceAbc(sourceKey, clef, currentTranspose, cueTonicMidi, isMinor);
  const lyricsHtml = buildChoraleLyricsHtml(currentPhrase);

  const choraleInfo = dataset.chorales[String(currentPhrase.chorale)];
  const choraleTitle = choraleInfo?.title ?? `BWV ${currentPhrase.chorale}`;
  const modeBadge =
    currentMode === "shuffle" ? ` <span class="muted">(shuffle)</span>`
    : currentMode === "permalink" ? ` <span class="muted">(shared link)</span>`
    : "";

  const app = document.getElementById("app")!;
  app.innerHTML = `
    <section class="fade-in" id="phrase-section">
      <div class="title-row">
        <h2>${escapeHtml(choraleTitle)}${modeBadge}</h2>
      </div>
      <div class="meta">
        BWV ${currentPhrase.chorale} · ${partLabel(currentPhrase.part)} · phrase ${currentPhrase.phrase}
        · ${currentTranspose >= 0 ? "+" : ""}${currentTranspose} semitones for ${VOICE_LABEL[prefs.voice]} · ${clef} clef
        <button id="copy-link-btn" class="link-btn" title="Copy a permalink to this phrase">🔗 link</button>
      </div>
      <div class="key-ref-wrap">
        <div class="key-ref-label">
          <span class="key-ref-title">Key</span>
          <span class="key-ref-sub">${tonicLabel} – ${dominantLabel} – ${tonicLabel}</span>
        </div>
        <div id="key-ref" class="key-ref" aria-label="Key reference: do, so, do"></div>
      </div>
      <div id="score"></div>
      <div class="controls-bar">
        <button id="cue-btn" class="secondary">♪ ${tonicLabel} – ${dominantLabel} – ${tonicLabel}</button>
        <button id="practice-btn" class="secondary">◐ Practice</button>
        <button id="rec-btn">● Record</button>
        <span class="spacer"></span>
        <button id="daily-btn" class="secondary" ${currentMode === "daily" ? "hidden" : ""}>Today's phrase</button>
        <button id="shuffle-btn" class="secondary" title="Pick a random phrase">⇄ Shuffle</button>
      </div>
      <div class="row" id="rec-status-row"><span id="rec-status" class="muted"></span></div>
      <canvas id="trace-canvas"></canvas>
      <div class="row" id="score-row" hidden>
        <span id="score-text" class="score-pill"></span>
      </div>
      ${lyricsHtml}
      <canvas id="share-canvas" hidden></canvas>
      <div class="row" id="share-row" hidden>
        <button id="dl-share-btn" class="secondary">⤓ Download share image</button>
        <button id="copy-share-btn" class="secondary">📋 Copy share image</button>
        <span id="copy-share-status" class="muted"></span>
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
  wireTake();
  wireCopyLink();
  (document.getElementById("shuffle-btn") as HTMLButtonElement).onclick = loadShuffle;
  const dailyBtn = document.getElementById("daily-btn") as HTMLButtonElement | null;
  if (dailyBtn) dailyBtn.onclick = loadDaily;
  renderHistory();
}

/** Pitch-class offsets above the tonic for a one-octave ascending scale. */
const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12];
const MINOR_SCALE_OFFSETS = [0, 2, 3, 5, 7, 8, 10, 12];

function buildWarmupAbc(
  sourceKey: string, clef: string, currentTranspose: number, cueTonicMidi: number, minor: boolean,
): string {
  const offs = minor ? MINOR_SCALE_OFFSETS : MAJOR_SCALE_OFFSETS;
  const SYLLABLES = minor
    ? ["la", "ti", "do", "re", "mi", "fa", "sol", "la"]
    : ["do", "re", "mi", "fa", "sol", "la", "ti", "do"];
  const tokens = offs.map((o, i) => {
    const tok = midiToAbcToken(cueTonicMidi + o - currentTranspose, sourceKey);
    return `"${SYLLABLES[i]}"${tok}`;
  });
  return [
    "X:1",
    "M:none",
    "L:1/4",
    `K:${sourceKey} clef=${clef}`,
    tokens.join(" ") + " |]",
  ].join("\n");
}

/** Build the reference-pitch staff: a single note drawn in the actual key the
 *  phrase will sound in. Renders without visualTranspose — written pitch is
 *  the sounding pitch — so the staff position is exactly the MIDI you asked
 *  for, regardless of the phrase's chosen clef (treble-8 in particular was
 *  drawing G3 at the G4 staff position, which read visually as G above
 *  middle C). The clef is chosen from the pitch itself: treble for G4+,
 *  bass for anything lower, so the note never needs ledger lines. */
function buildReferenceAbc(
  transposedTonicPc: number, minor: boolean, refMidi: number,
): string {
  const clef = refMidi >= 60 ? "treble" : "bass";
  const key = pcToKeyString(transposedTonicPc, minor);
  const tok = midiToAbcToken(refMidi, key);
  return [
    "X:1",
    "M:none",
    "L:1/2",
    `K:${key} clef=${clef}`,
    `${tok} |]`,
  ].join("\n");
}

/** Map a pitch class (+major/minor) to a canonical ABC key string. Picks the
 *  spelling most musicians would expect when reading at sight — sharp keys
 *  for sharp pcs, flat keys for flat ones. Edge cases (Db vs C#, F# vs Gb)
 *  use the more common notation. */
function pcToKeyString(pc: number, minor: boolean): string {
  if (!minor) {
    return ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][pc];
  }
  return ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"][pc];
}

function referenceMidiForVoice(voice: VoiceType | null): number {
  // Soprano / Mezzo / Alto reference at G4 (67), lower voices at G3 (55).
  if (voice === "Soprano" || voice === "Mezzo-Soprano" || voice === "Alto") return 67;
  return 55;
}

function midiToNoteName(midi: number): string {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const oct = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]}${oct}`;
}

function playReferencePitch(midi: number) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  osc.type = "triangle";
  osc.frequency.value = hz;
  const t0 = ctx.currentTime + 0.05;
  const dur = 1.4;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
  g.gain.setValueAtTime(0.18, t0 + dur - 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  setTimeout(() => { void ctx.close(); }, (dur + 0.5) * 1000);
}

function playScale(tonicMidi: number, minor: boolean) {
  const offs = minor ? MINOR_SCALE_OFFSETS : MAJOR_SCALE_OFFSETS;
  const ctx = new AudioContext();
  const dur = 0.4;
  let t = ctx.currentTime + 0.05;
  for (const o of offs) {
    const hz = 440 * Math.pow(2, (tonicMidi + o - 69) / 12);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.setValueAtTime(0.16, t + dur - 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.04);
    t += dur;
  }
  setTimeout(() => { void ctx.close(); }, (offs.length * dur + 0.5) * 1000);
}

function wireCopyLink() {
  const btn = document.getElementById("copy-link-btn") as HTMLButtonElement | null;
  if (!btn || !currentPhrase) return;
  btn.onclick = async () => {
    const hash = permalinkFor(currentPhrase!, customTranspose ?? undefined);
    const url = `${window.location.origin}${window.location.pathname}#${hash}`;
    try { await navigator.clipboard.writeText(url); btn.textContent = "✓ copied"; }
    catch { btn.textContent = "(copy failed)"; }
    setTimeout(() => { btn.textContent = "🔗 link"; }, 1500);
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

/** Wires up both the Practice and Record buttons against a single shared
 *  {@link activeDetector} slot. The two buttons drive a small state machine
 *  (`idle` ↔ `practice`, `idle` ↔ `recording`) — starting one mode always
 *  stops whatever was running before, and the synchronous `activeMode`
 *  assignment claims the slot before any `await` so double-clicks resolve to
 *  a single transition. */
function wireTake() {
  const recBtn = document.getElementById("rec-btn") as HTMLButtonElement;
  const practiceBtn = document.getElementById("practice-btn") as HTMLButtonElement | null;
  const status = document.getElementById("rec-status")!;
  const canvas = document.getElementById("trace-canvas") as HTMLCanvasElement;
  const scoreRow = document.getElementById("score-row")!;
  const scoreText = document.getElementById("score-text")!;

  const targetNotes = currentPhrase
    ? abcSourceNoteSequence(currentPhrase.abc)
        .map((n) => ({ midi: n.midi + currentTranspose, duration: n.duration }))
    : [];
  const sourceTonic = currentPhrase ? tonicPc(extractKey(currentPhrase.abc)).pc : 0;
  const transposedTonicPc = ((sourceTonic + currentTranspose) % 12 + 12) % 12;
  const estimatedDuration = Math.max(2, targetNotes.length * 0.6);
  trace = new LiveTraceRenderer(
    canvas, targetNotes, estimatedDuration,
    {
      showTargetWhileSinging: !!prefs.showTargetWhileSinging,
      tonicPc: transposedTonicPc,
    },
  );
  if (prefs.showReferencePitch) trace.setReferencePitch(referenceMidiForVoice(prefs.voice));

  const setPracticeButton = (running: boolean) => {
    if (!practiceBtn) return;
    practiceBtn.textContent = running ? "■ Stop practice" : "◐ Practice";
    practiceBtn.classList.toggle("secondary", !running);
  };

  /** Start a fresh detector and pipe its frames into `trace` — but only while
   *  the slot still belongs to us, so a fast mode switch can't see crossed
   *  frames. Returns `"aborted"` if a subsequent click stopped us during the
   *  model-load / getUserMedia await; callers should leave the UI alone in
   *  that case (the click that aborted us has already settled it). */
  const startDetector = async (mode: "practice" | "recording"): Promise<Error | "aborted" | null> => {
    const d = new LivePitchDetector();
    activeDetector = d;
    activeMode = mode;
    try {
      await d.start((p) => { if (activeDetector === d) trace?.addPoint(p); });
    } catch (e) {
      if (activeDetector === d) { activeDetector = null; activeMode = "idle"; }
      return e as Error;
    }
    if (activeDetector !== d) return "aborted";
    return null;
  };

  if (practiceBtn) practiceBtn.onclick = async () => {
    if (activeMode === "practice") {
      await stopActiveDetector();
      trace?.setPracticeMode(false);
      trace?.resetPoints();
      setPracticeButton(false);
      return;
    }
    if (activeMode === "recording") return; // ignore while recording
    // claim the slot synchronously before any await, so a second click
    // sees the new mode and falls into the stop branch instead of starting
    // a second mic stream.
    activeMode = "practice";
    setPracticeButton(true);
    trace?.resetPoints();
    trace?.setPracticeMode(true);
    const err = await startDetector("practice");
    if (err === "aborted") return;
    if (err) {
      trace?.setPracticeMode(false);
      setPracticeButton(false);
      if (practiceBtn) practiceBtn.textContent = `! ${err.message}`;
    }
  };

  recBtn.onclick = async () => {
    if (activeMode === "recording") {
      recBtn.disabled = true;
      // Hold onto the detector across stop() so we can re-run the offline
      // pass over its buffered 16 kHz audio. stopActiveDetector() would
      // discard it before we get the chance.
      const d = activeDetector;
      activeDetector = null;
      activeMode = "idle";
      if (d) await d.stop();
      recBtn.textContent = "● Record";

      // Offline rescoring: drop the dropped-frame live trace, replace with a
      // full-coverage 2×-temporal-resolution pass over the buffered audio,
      // then freeze + score as before. A failure here falls back silently to
      // the live trace so the user still gets a result.
      if (d && d.hasRecordedAudio()) {
        status.textContent = "scoring…";
        try {
          const refined = await d.analyzeOffline((frac) => {
            status.textContent = `scoring… ${Math.round(frac * 100)}%`;
          });
          trace?.replacePoints(refined);
        } catch (e) {
          console.warn("offline analysis failed; using live trace:", e);
        }
      }

      recBtn.disabled = false;
      trace?.freeze();

      const { score, hits, meanCentsError, perNote } = trace!.computeScore();
      status.textContent = "";
      scoreRow.hidden = false;
      // Same hit rule as the share image (per-target tolerance + ≥50% of slot
      // frames inside it), so the dialog number and the shared % never drift.
      scoreText.innerHTML =
        `${Math.round(score * 100)}% (${hits}/${perNote.length})` +
        (meanCentsError > 0 ? ` <span class="err">· mean ${meanCentsError.toFixed(0)}¢</span>` : "");

      attemptNum++;
      lastReport = { score, meanCentsError, frames: [] };
      // Only persist the first take for the day, so the daily history reflects
      // a true sight-reading. Subsequent attempts still get a score and share
      // image but don't overwrite the recorded one.
      if (currentMode === "daily" && attemptNum === 1) {
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
      return;
    }

    // Starting a take. If practice was running, tear it down first.
    if (activeMode === "practice") {
      await stopActiveDetector();
      trace?.setPracticeMode(false);
      setPracticeButton(false);
    }

    // Retry support: clear any frozen previous attempt. The share canvas and
    // score row stay visible from the previous attempt until the new
    // recording finishes so the user can still grab the old image.
    trace?.resetPoints();
    if (prefs.showReferencePitch) trace?.setReferencePitch(referenceMidiForVoice(prefs.voice));
    status.textContent = "loading pitch model…";
    // Claim the slot synchronously so a double-click can't start twice.
    activeMode = "recording";
    recBtn.textContent = "■ Stop";
    const err = await startDetector("recording");
    if (err === "aborted") return;
    if (err) {
      recBtn.textContent = "● Record";
      status.textContent = `start failed: ${err.message}`;
      return;
    }
    status.textContent = attemptNum > 0
      ? `recording attempt ${attemptNum + 1} — sing the phrase…`
      : "recording — sing the phrase…";
    scoreRow.hidden = true;
  };
}

async function drawShare() {
  if (!lastReport || !currentPhrase || !trace) return;
  const canvas = document.getElementById("share-canvas") as HTMLCanvasElement;
  const row = document.getElementById("share-row")!;
  const choraleInfo = dataset.chorales[String(currentPhrase.chorale)];
  const choraleTitle = choraleInfo?.title ?? `BWV ${currentPhrase.chorale}`;
  const phrasePermalink = `${window.location.origin}${window.location.pathname}#${permalinkFor(currentPhrase)}`;
  // The URL printed beneath the QR is intentionally the root page, not the
  // permalink — the permalink is already encoded in the QR. The plain-text
  // line just tells a paper-reader where to go to find BachDay at all.
  const rootUrl = `${window.location.origin}${window.location.pathname}`;
  try {
    await renderShareCanvas(
      canvas, PORTRAIT_URL, trace,
      { score: lastReport.score, meanCentsError: lastReport.meanCentsError },
      {
        title: choraleTitle,
        subtitle: `BWV ${currentPhrase.chorale} · ${partLabel(currentPhrase.part)} · phrase ${currentPhrase.phrase}`
          + (attemptNum > 1 ? ` · attempt ${attemptNum}` : ""),
        date: todayKey(),
      },
      phrasePermalink,
      rootUrl,
    );
    canvas.hidden = false;
    row.hidden = false;
    const copyBtn = document.getElementById("copy-share-btn") as HTMLButtonElement;
    const dlBtn = document.getElementById("dl-share-btn") as HTMLButtonElement;
    const status = document.getElementById("copy-share-status")!;
    copyBtn.onclick = () => copyShareImage(canvas, status);
    dlBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `bachday-${todayKey()}.png`;
      a.click();
    };
  } catch (e) {
    console.warn("share canvas failed", e);
  }
}

/** Copy the rendered share image to the clipboard. The image itself carries
 *  the QR-coded permalink, so no additional clipboard formats are needed. */
async function copyShareImage(canvas: HTMLCanvasElement, status: HTMLElement) {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) { status.textContent = "(failed to render)"; return; }
  const setStatus = (s: string) => {
    status.textContent = s;
    setTimeout(() => { status.textContent = ""; }, 2500);
  };
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus("✓ image copied");
  } catch (e) {
    console.warn("clipboard write failed", e);
    setStatus("(clipboard unavailable — use Download)");
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
