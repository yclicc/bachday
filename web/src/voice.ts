export type VoiceType =
  | "Soprano"
  | "Mezzo-Soprano"
  | "Alto"
  | "Tenor"
  | "Baritone"
  | "Bass";

export const VOICE_TYPES: VoiceType[] = [
  "Soprano",
  "Mezzo-Soprano",
  "Alto",
  "Tenor",
  "Baritone",
  "Bass",
];

/** Practical singing range per voice type. Wide enough that an original
 * Bach part written for that voice will normally fit without any transposition. */
export const VOICE_RANGE: Record<VoiceType, { lo: number; hi: number }> = {
  Soprano: { lo: 58, hi: 84 },         // Bb3–C6
  "Mezzo-Soprano": { lo: 55, hi: 79 }, // G3–G5
  Alto: { lo: 52, hi: 77 },            // E3–F5
  Tenor: { lo: 46, hi: 72 },           // Bb2–C5
  Baritone: { lo: 43, hi: 67 },        // G2–G4
  Bass: { lo: 38, hi: 62 },            // D2–D4
};

/**
 * Pick a transposition (in semitones) that maps a phrase's [lo,hi] ambitus
 * into the voice's comfortable range, by aligning midpoints and rounding to
 * the nearest semitone. Then shift by octaves if needed so both extremes fit.
 */
export type Part = "S" | "A" | "T" | "B";

/** Which SATB part each voice "owns" — the canonical voice for each line.
 * Only an exact match earns key-preserving (octave-only) transposition.
 * Mezzo and Baritone don't have a native part in four-part writing, so they
 * always cross-voice (chromatic centring), which keeps the natural voice
 * ordering — a Mezzo always sounds at or above an Alto, a Baritone at or
 * above a Bass, etc. */
const VOICE_OWNS_PART: Partial<Record<VoiceType, Part>> = {
  Soprano: "S",
  Alto: "A",
  Tenor: "T",
  Bass: "B",
};

export function chooseTransposition(
  phraseLo: number,
  phraseHi: number,
  voice: VoiceType,
  part: Part,
): number {
  const { lo, hi } = VOICE_RANGE[voice];
  const voiceMid = (lo + hi) / 2;
  const phraseMid = (phraseLo + phraseHi) / 2;
  // Target a touch below the voice midpoint — singing in the upper third of
  // the range is more strenuous than the lower third.
  const preferredMid = voiceMid - 2;

  if (VOICE_OWNS_PART[voice] === part) {
    // Singing your own part: keep the original key when at all possible. If
    // shift 0 already fits in your range we stop right there. Only when the
    // part genuinely doesn't sit on your voice do we look at octave shifts.
    if (phraseLo >= lo && phraseHi <= hi) return 0;
    for (const shift of [-12, 12, -24, 24]) {
      if (phraseLo + shift >= lo && phraseHi + shift <= hi) return shift;
    }
    // Nothing fits cleanly — pick the octave with the smallest overflow.
    const candidates = [-24, -12, 0, 12, 24];
    let best = 0;
    let bestOverflow = Infinity;
    for (const shift of candidates) {
      const overflow =
        Math.max(0, lo - (phraseLo + shift)) + Math.max(0, (phraseHi + shift) - hi);
      if (overflow < bestOverflow) { bestOverflow = overflow; best = shift; }
    }
    return best;
  }

  // Cross-voice: chromatic centring at the preferred mid. Avoids the
  // pile-up of "Mezzo octave-shifted below Alto because the octave overshot"
  // that octave-only quantisation introduces.
  return Math.round(preferredMid - phraseMid);
}

/** Default ABC clef per voice type. Only G and F clef variants — no C clefs. */
export const VOICE_DEFAULT_CLEF: Record<VoiceType, string> = {
  Soprano: "treble",
  "Mezzo-Soprano": "treble",
  Alto: "treble",
  Tenor: "treble-8",   // G clef with the small "8" below: sounds an octave down
  Baritone: "bass",
  Bass: "bass",
};

/** Comfortable *sounding* pitch range for each clef. (For treble-8 the staff
 * itself sits in the treble range, but pitches sound an octave lower.) */
const CLEF_RANGE: Record<string, { lo: number; hi: number }> = {
  treble:     { lo: 60, hi: 81 }, // C4–A5
  "treble-8": { lo: 48, hi: 69 }, // C3–A4  — written on treble staff, sounds octave down
  bass:       { lo: 40, hi: 60 }, // E2–C4
};

/** Semitone offset abcjs applies between *written staff position* and
 * *sounding pitch* for displacement clefs. For treble-8 the staff is drawn
 * an octave above what it sounds (= +12 from sounding to written). */
export const CLEF_STAFF_OFFSET: Record<string, number> = {
  treble: 0,
  "treble-8": 12,
  bass: 0,
};

function clefMisfit(clef: string, soundingLo: number, soundingHi: number): number {
  const r = CLEF_RANGE[clef];
  if (!r) return Infinity;
  const lowSlop = Math.max(0, r.lo - soundingLo);
  const highSlop = Math.max(0, soundingHi - r.hi);
  return lowSlop + highSlop;
}

/** Pick the best clef for the transposed phrase, preferring the voice's
 * default and falling back to neighbouring clefs only if the default would
 * produce excessive ledger lines. */
export function chooseClef(
  voice: VoiceType,
  soundingLo: number,
  soundingHi: number,
): string {
  const preferred = VOICE_DEFAULT_CLEF[voice];
  const defaultMisfit = clefMisfit(preferred, soundingLo, soundingHi);
  if (defaultMisfit <= 2) return preferred;

  const candidates = Object.keys(CLEF_RANGE);
  let best = preferred;
  let bestScore = defaultMisfit;
  for (const c of candidates) {
    const score = clefMisfit(c, soundingLo, soundingHi);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}
