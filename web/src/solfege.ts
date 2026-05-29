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
  const pc = ((midi - tonicPc_) % 12 + 12) % 12;
  // In minor keys, shift so "do" sits on the minor tonic (la-based minor would
  // be the alternative; we use do-based minor here for simplicity).
  // For do-based minor, b3 b6 b7 are diatonic, so override:
  if (minor) {
    const minorMap: Record<number, string> = {
      0: "do", 1: "ra", 2: "re", 3: "me", 4: "mi", 5: "fa",
      6: "se", 7: "sol", 8: "le", 9: "la", 10: "te", 11: "ti",
    };
    return minorMap[pc];
  }
  const s = SYLLABLES[pc];
  return s.diatonic ? s.sharp : s.sharp; // prefer sharp-side for ascending feel
}

export function isChromatic(midi: number, tonicPc_: number, minor: boolean): boolean {
  const pc = ((midi - tonicPc_) % 12 + 12) % 12;
  if (minor) return [1, 6, 8, 11].includes(pc); // raised/lowered relative to natural minor
  return !SYLLABLES[pc].diatonic;
}
