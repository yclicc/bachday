/** ABC helpers built on abcjs's parsed visualObj.
 *
 * We let abcjs own transposition (via the `visualTranspose` render option)
 * and MIDI playback (via `abcjs.synth.CreateSynth`). This file only deals
 * with the things abcjs doesn't give us directly: pulling out the played
 * MIDI sequence, and injecting moveable-do solfege as `w:` lyric lines.
 */

import { solfege, tonicPc, isChromatic, type SolfegeMode } from "./solfege";

// Diatonic step → semitones above C
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

interface VisualPitch {
  pitch: number;            // abcjs diatonic position; 0 = middle C, +1 per scale degree
  accidental?: string;      // "sharp"|"flat"|"natural"|"dblsharp"|"dblflat" or undefined
}
interface VisualNote {
  el_type: string;          // "note" for noteheads
  pitches?: VisualPitch[];
  rest?: unknown;
}
interface VisualStaff {
  key?: { accidentals?: Array<{ acc: string; note: string }>; root?: string; mode?: string };
  voices: VisualNote[][];
}
interface VisualLine {
  staff?: VisualStaff[];
}
export interface VisualObj {
  lines?: VisualLine[];
  getKeySignature?: () => { root: string; mode: string; acc?: string };
}

function accSemitones(name: string | undefined): number | null {
  switch (name) {
    case "sharp": return 1;
    case "flat": return -1;
    case "dblsharp": return 2;
    case "dblflat": return -2;
    case "natural": return 0;
    default: return null;
  }
}

function keyAccidentalsMap(staff: VisualStaff | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const a of staff?.key?.accidentals ?? []) {
    const s = accSemitones(a.acc);
    if (s != null) map.set(a.note.toUpperCase(), s);
  }
  return map;
}

function diatonicToMidi(pitch: number, accidental: string | undefined, keyAcc: Map<string, number>): number {
  const octave = Math.floor(pitch / 7);
  const step = ((pitch % 7) + 7) % 7;
  const stepLetter = ["C", "D", "E", "F", "G", "A", "B"][step];
  const inline = accSemitones(accidental);
  const adj = inline != null ? inline : (keyAcc.get(stepLetter) ?? 0);
  return 60 + octave * 12 + STEP_SEMITONES[step] + adj;
}

/** Walk the raw ABC source and emit the sounding MIDI sequence (no transpose,
 * no clef displacement — just what the notes literally say). */
export function abcSourceMidiSequence(abc: string): number[] {
  return abcSourceNoteSequence(abc).map((n) => n.midi);
}

/** As {@link abcSourceMidiSequence} but also returns each note's duration
 *  (in L: units). */
export function abcSourceNoteSequence(abc: string): Array<{ midi: number; duration: number }> {
  const keyStr = extractKey(abc);
  const keyAcc = keyAccidentalsForKeyString(keyStr);
  const lines = abc.split("\n");
  const out: Array<{ midi: number; duration: number }> = [];
  let inBody = false;
  for (const line of lines) {
    if (line.startsWith("K:")) { inBody = true; continue; }
    if (!inBody || isHeaderLine(line) || line.trim() === "") continue;
    const clean = stripNonNotes(line);
    let m: RegExpExecArray | null;
    NOTE_RE.lastIndex = 0;
    while ((m = NOTE_RE.exec(clean))) {
      out.push({
        midi: abcNoteLetterToMidi(m[1] ?? "", m[2], m[3] ?? "", keyAcc),
        duration: parseDurationToken(m[4] ?? ""),
      });
    }
  }
  return out;
}

/** Inject a lyrics line under each music line in the ABC, taken from a
 *  per-verse list of syllables. If the lyric list is shorter than the music
 *  it gets melisma-padded; if longer, the tail is dropped silently. */
export function addChoraleLyrics(abc: string, verses: string[][]): string {
  if (!verses.length) return abc;
  const noteCountsPerLine: number[] = [];
  const lines = abc.split("\n");
  let inBody = false;
  for (const line of lines) {
    if (line.startsWith("K:")) { inBody = true; continue; }
    if (!inBody || isHeaderLine(line) || line.trim() === "") continue;
    const clean = stripNonNotes(line);
    let count = 0;
    let m: RegExpExecArray | null;
    NOTE_RE.lastIndex = 0;
    while ((m = NOTE_RE.exec(clean))) count++;
    noteCountsPerLine.push(count);
  }

  const out: string[] = [];
  inBody = false;
  let lineIdx = 0;
  // Pre-flatten each verse to syllables-per-music-line.
  const verseLines: string[][][] = verses.map((syllables) => {
    const result: string[][] = [];
    let cursor = 0;
    for (const count of noteCountsPerLine) {
      const slice = syllables.slice(cursor, cursor + count);
      while (slice.length < count) slice.push("*");
      cursor += count;
      result.push(slice);
    }
    return result;
  });

  for (const line of lines) {
    out.push(line);
    if (line.startsWith("K:")) { inBody = true; continue; }
    if (!inBody || isHeaderLine(line) || line.trim() === "") continue;
    for (const verseLine of verseLines) {
      out.push("w: " + verseLine[lineIdx].join(" "));
    }
    lineIdx++;
  }
  return out.join("\n");
}

/** Flatten the visualObj into the played MIDI sequence (rests skipped). */
export function midiSequenceFromVisual(v: VisualObj): number[] {
  const out: number[] = [];
  for (const line of v.lines ?? []) {
    for (const staff of line.staff ?? []) {
      const keyAcc = keyAccidentalsMap(staff);
      for (const voice of staff.voices ?? []) {
        for (const el of voice) {
          if (el.el_type !== "note" || !el.pitches) continue;
          for (const p of el.pitches) {
            out.push(diatonicToMidi(p.pitch, p.accidental, keyAcc));
          }
        }
      }
    }
  }
  return out;
}

/** Parse the source ABC K: line for solfege tonic computation. */
export function extractKey(abc: string): string {
  const m = abc.match(/^K:\s*([^\n%]+)/m);
  return m ? m[1].trim() : "C";
}

const CLEF_TOKENS = new Set([
  "treble", "bass", "alto", "tenor", "soprano", "mezzosoprano",
  "baritone", "treble-8", "bass-8", "treble+8", "bass+8", "perc", "none",
]);

/** Override the clef on every `V:` line in an ABC document. converter21
 * emits e.g. `V:1 bass nm="Bass" snm="B."` and that token is what abcjs
 * uses to pick the clef at render time. */
export function setAbcClef(abc: string, clef: string): string {
  return abc.split("\n").map((line) => {
    if (!line.startsWith("V:")) return line;
    const m = line.match(/^(V:\S+)(\s*)(.*)$/);
    if (!m) return line;
    const [, vName, sp, rest] = m;
    const tokens = rest.length ? rest.split(/\s+/) : [];
    if (tokens.length && CLEF_TOKENS.has(tokens[0])) tokens[0] = clef;
    else tokens.unshift(clef);
    return `${vName}${sp || " "}${tokens.join(" ")}`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// Solfege lyrics injection
// ---------------------------------------------------------------------------
//
// Scale-degree (and therefore moveable-do syllable) is invariant under
// transposition, so we can compute syllables from the source ABC against the
// source key — no need to involve abcjs at all. We just need to count notes
// per music line and append a matching `w:` line.

const NOTE_RE = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)([0-9/]*)/g;

/** Parse the duration suffix of an ABC note (the bit after the octave marks).
 *  Accepts `2`, `/`, `/2`, `//`, `3/2`, etc. Returns multiples of the
 *  prevailing L: unit. Unhandled tuplet/broken-rhythm modifiers fall through
 *  as 1. */
function parseDurationToken(tok: string): number {
  if (!tok) return 1;
  const slash = tok.indexOf("/");
  if (slash === -1) return Math.max(1, parseInt(tok)) || 1;
  const numerator = slash > 0 ? Math.max(1, parseInt(tok.slice(0, slash))) || 1 : 1;
  let dur: number = numerator;
  let i = slash;
  while (i < tok.length && tok[i] === "/") {
    let j = i + 1;
    while (j < tok.length && /\d/.test(tok[j])) j++;
    const divisor = j > i + 1 ? parseInt(tok.slice(i + 1, j)) : 2;
    dur /= divisor;
    i = j;
  }
  return dur;
}

const SHARPS_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLATS_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
const KEY_FIFTHS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};

export function keyAccidentalsForKeyString(keyStr: string): Map<string, number> {
  const m = keyStr.trim().match(/^([A-G][#b]?)(m|maj|min)?/);
  const map = new Map<string, number>();
  if (!m) return map;
  let root = m[1];
  const minor = m[2] === "m" || m[2] === "min";
  if (minor) {
    const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    let pc = semis[root[0]];
    if (root[1] === "#") pc += 1;
    if (root[1] === "b") pc -= 1;
    pc = (pc + 3) % 12;
    const names = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
    root = names[pc];
  }
  const fifths = KEY_FIFTHS[root] ?? 0;
  if (fifths > 0) for (let i = 0; i < fifths; i++) map.set(SHARPS_ORDER[i], 1);
  if (fifths < 0) for (let i = 0; i < -fifths; i++) map.set(FLATS_ORDER[i], -1);
  return map;
}

function abcNoteLetterToMidi(
  acc: string,
  letter: string,
  octMarks: string,
  keyAcc: Map<string, number>,
): number {
  const upper = letter.toUpperCase();
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let oct = letter === upper ? 4 : 5;
  for (const ch of octMarks) {
    if (ch === ",") oct -= 1;
    else if (ch === "'") oct += 1;
  }
  let adj: number;
  if (acc === "^") adj = 1;
  else if (acc === "^^") adj = 2;
  else if (acc === "_") adj = -1;
  else if (acc === "__") adj = -2;
  else if (acc === "=") adj = 0;
  else adj = keyAcc.get(upper) ?? 0;
  return 12 * (oct + 1) + base[upper] + adj;
}

/** Render a MIDI value as an ABC note token, choosing the diatonic spelling
 *  for the given key signature when possible (no explicit accidental) and
 *  falling back to a sharp/flat otherwise. Octave is encoded with case +
 *  `,` / `'` so e.g. C4 → `C`, C5 → `c`, C3 → `C,`, F#5 in C major → `^f`. */
export function midiToAbcToken(midi: number, keyStr: string): string {
  const keyAcc = keyAccidentalsForKeyString(keyStr);
  const pc = ((midi % 12) + 12) % 12;
  const letters: Array<[string, number]> = [
    ["C", 0], ["D", 2], ["E", 4], ["F", 5], ["G", 7], ["A", 9], ["B", 11],
  ];
  // Prefer the diatonic letter (no accidental needed). Fall back to the
  // nearest natural spelling with an explicit accidental.
  let letter = "C";
  let basePc = 0;
  let explicit: "" | "^" | "_" = "";
  let found = false;
  for (const [L, b] of letters) {
    const adj = keyAcc.get(L) ?? 0;
    if ((((b + adj) % 12) + 12) % 12 === pc) {
      letter = L; basePc = b + adj; found = true; break;
    }
  }
  if (!found) {
    for (const [L, b] of letters) {
      if (((b + 1) % 12) === pc) { letter = L; basePc = b; explicit = "^"; found = true; break; }
      if ((((b - 1) % 12) + 12) % 12 === pc) { letter = L; basePc = b; explicit = "_"; found = true; break; }
    }
  }
  const oct = (midi - basePc) / 12 - 1;
  let token: string;
  if (oct >= 5) {
    token = letter.toLowerCase();
    for (let i = 0; i < oct - 5; i++) token += "'";
  } else {
    token = letter;
    for (let i = 0; i < 4 - oct; i++) token += ",";
  }
  return explicit + token;
}

function isHeaderLine(line: string): boolean {
  // Information / voice / key / etc. lines. The trailing-whitespace requirement
  // would skip `V:1 bass` correctly but treat `V:1` (no space after the digit)
  // as music — including the "bass" identifier on the previous line if we got
  // confused. Just match any single-letter-colon prefix at the start.
  return /^[A-Za-z]:/.test(line);
}

/** Remove ABC syntax that contains letters the noteheads regex would falsely
 * match: `!decoration!`, `"chord annotations"`, `%comments`. */
function stripNonNotes(line: string): string {
  return line
    .replace(/!.*?!/g, "")
    .replace(/".*?"/g, "")
    .replace(/%.*/g, "");
}

export function addSolfegeLyrics(abc: string, mode: SolfegeMode): string {
  if (mode === "none") return abc;
  const keyStr = extractKey(abc);
  const { pc, minor } = tonicPc(keyStr);
  const keyAcc = keyAccidentalsForKeyString(keyStr);

  const lines = abc.split("\n");
  const out: string[] = [];
  let inBody = false;
  for (const line of lines) {
    if (line.startsWith("K:")) { inBody = true; out.push(line); continue; }
    if (!inBody || isHeaderLine(line) || line.trim() === "") {
      out.push(line); continue;
    }
    out.push(line);
    const syllables: string[] = [];
    const clean = stripNonNotes(line);
    let m: RegExpExecArray | null;
    NOTE_RE.lastIndex = 0;
    while ((m = NOTE_RE.exec(clean))) {
      const midi = abcNoteLetterToMidi(m[1] ?? "", m[2], m[3] ?? "", keyAcc);
      const chrom = isChromatic(midi, pc, minor);
      if (mode === "chromatic" && !chrom) syllables.push("*");
      else syllables.push(solfege(midi, pc, minor));
    }
    if (syllables.length) out.push("w: " + syllables.join(" "));
  }
  return out.join("\n");
}
