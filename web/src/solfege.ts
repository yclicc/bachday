/** Moveable-do solfege helpers. */

export type SolfegeMode = "none" | "chromatic" | "all";

// pitch-class → diatonic/chromatic syllable, relative to the tonic
// chromatic-up vs chromatic-down isn't distinguished here; we pick the
// flat-side for lowered scale degrees, sharp-side for raised.
const SYLLABLES: Record<number, { diatonic: boolean; sharp: string; flat: string }> = {
  0: { diatonic: true, sharp: "do", flat: "do" },
  1: { diatonic: false, sharp: "di", flat: "ra" },
  2: { diatonic: true, sharp: "re", flat: "re" },
  3: { diatonic: false, sharp: "ri", flat: "me" },
  4: { diatonic: true, sharp: "mi", flat: "mi" },
  5: { diatonic: true, sharp: "fa", flat: "fa" },
  6: { diatonic: false, sharp: "fi", flat: "se" },
  7: { diatonic: true, sharp: "so", flat: "so" },
  8: { diatonic: false, sharp: "si", flat: "le" },
  9: { diatonic: true, sharp: "la", flat: "la" },
  10: { diatonic: false, sharp: "li", flat: "te" },
  11: { diatonic: true, sharp: "ti", flat: "ti" },
};

/** Pitch-class of the tonic for a given ABC key string like "G", "Bb", "F#m". */
export function tonicPc(keyStr: string): { pc: number; minor: boolean } {
  const m = keyStr.trim().match(/^([A-Ga-g])([#b]?)(m|maj|min)?/);
  if (!m) return { pc: 0, minor: false };
  const letter = m[1].toUpperCase();
  const accidental = m[2];
  const minor = m[3] === "m" || m[3] === "min";
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[letter];
  if (accidental === "#") pc += 1;
  if (accidental === "b") pc -= 1;
  return { pc: ((pc % 12) + 12) % 12, minor };
}

export function solfege(midi: number, tonicPc_: number, minor: boolean): string {
  // La-based minor: in a minor key the tonic sounds "la" and the relative
  // major's tonic (a minor 3rd up) sounds "do". This lets the same syllables
  // describe a key and its relative without re-anchoring.
  if (minor) {
    const pc = ((midi - tonicPc_) % 12 + 12) % 12;
    // Offsets are relative to the minor tonic (la). Diatonic degrees of the
    // natural minor: la, ti, do, re, mi, fa, sol; chromatic alterations use
    // the standard sharp / flat syllables of the relative major.
    const labels: Record<number, string> = {
      0: "la",            // ^1
      1: "li",            // ♯1  (raised tonic)
      2: "ti",            // ^2
      3: "do",            // ^3 → relative-major tonic
      4: "di",            // ♯3
      5: "re",            // ^4
      6: "ri",            // ♯4 (= ♭5 → "ri" picked for ascending feel)
      7: "mi",            // ^5
      8: "fa",            // ^6
      9: "fi",            // ♯6 (raised 6 in melodic minor)
      10: "sol",          // ^7
      11: "si",           // ♯7 (raised leading tone)
    };
    return labels[pc];
  }
  const pc = ((midi - tonicPc_) % 12 + 12) % 12;
  const s = SYLLABLES[pc];
  return s.diatonic ? s.sharp : s.sharp; // default for callers with no spelling info
}

/** Effective chromatic direction of a written note relative to its key
 *  signature. Used to pick the right solfege syllable for a chromatic note:
 *  a sharp (or a natural that cancels a key-sig flat) reads as raised →
 *  sharp-side syllable; a flat (or natural cancelling a key-sig sharp) reads
 *  as lowered → flat-side syllable. */
export type AccidentalDirection = "sharp" | "flat" | "none";
export function accidentalDirection(
  inlineAccidental: string, keySigForLetter: number,
): AccidentalDirection {
  if (inlineAccidental === "^" || inlineAccidental === "^^") return "sharp";
  if (inlineAccidental === "_" || inlineAccidental === "__") return "flat";
  if (inlineAccidental === "=") {
    if (keySigForLetter > 0) return "flat";  // natural cancels a key-sig sharp
    if (keySigForLetter < 0) return "sharp"; // natural cancels a key-sig flat
  }
  return "none";
}

/** Solfege syllable using a known spelling. Prefer this over {@link solfege}
 *  when the rendered accidental is known — it picks "ra" vs "di" (etc.) by
 *  the direction the spelling implies, instead of defaulting blindly to one
 *  side. */
export function solfegeForSpelling(
  midi: number, tonicPc_: number, minor: boolean, direction: AccidentalDirection,
): string {
  const pc = ((midi - tonicPc_) % 12 + 12) % 12;
  if (minor) {
    // La-based minor: relative-major syllable set, with explicit sharp/flat
    // pairs for the chromatic positions so the spelling rule can pick.
    const pairs: Record<number, [string, string]> = {
      0: ["la", "la"],
      1: ["li", "te"],
      2: ["ti", "ti"],
      3: ["do", "do"],
      4: ["di", "ra"],
      5: ["re", "re"],
      6: ["ri", "me"],
      7: ["mi", "mi"],
      8: ["fa", "fa"],
      9: ["fi", "se"],
      10: ["sol", "sol"],
      11: ["si", "le"],
    };
    const [sharp, flat] = pairs[pc];
    if (direction === "flat") return flat;
    if (direction === "sharp") return sharp;
    return sharp; // diatonic — both entries equal
  }
  const s = SYLLABLES[pc];
  if (s.diatonic) return s.sharp;
  return direction === "flat" ? s.flat : s.sharp;
}

export function isChromatic(midi: number, tonicPc_: number, minor: boolean): boolean {
  const pc = ((midi - tonicPc_) % 12 + 12) % 12;
  // Natural-minor diatonic pcs (relative to the minor tonic): 0 2 3 5 7 8 10.
  if (minor) return ![0, 2, 3, 5, 7, 8, 10].includes(pc);
  return !SYLLABLES[pc].diatonic;
}
