/** Deterministic daily phrase selection. */

export interface PhraseRow {
  chorale: number;
  part: "S" | "A" | "T" | "B";
  phrase: string;
  ambitus_lo: number;
  ambitus_hi: number;
  abc: string;
}

export interface ChoraleInfo {
  title: string;
  translation: string | null;
}

export interface Dataset {
  chorales: Record<string, ChoraleInfo>;
  /** Keyed by `${chorale}.${phrase}`. Each value is one syllable-list per verse. */
  lyrics: Record<string, string[][]>;
  phrases: PhraseRow[];
}

/** xmur3 string-seeded PRNG → 32-bit state function. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with a seeded RNG. Pure: returns a new array. */
export function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const rand = mulberry32(xmur3(seed)());
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Day index since the BachDay epoch (2024-01-01 UTC). */
export function dayIndex(date: Date = new Date()): number {
  const epoch = Date.UTC(2024, 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((today - epoch) / 86400000);
}

export function todayKey(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Select the phrase row for the given date. */
export function phraseForDate(rows: PhraseRow[], date: Date = new Date()): PhraseRow {
  const shuffled = deterministicShuffle(rows, "bachday-v1");
  return shuffled[dayIndex(date) % shuffled.length];
}

/** Pick a uniformly random phrase. */
export function randomPhrase(rows: PhraseRow[]): PhraseRow {
  return rows[Math.floor(Math.random() * rows.length)];
}

/** Permalink parsed from the URL hash, e.g. `#p=1.S01&t=-3`. */
export interface Permalink {
  chorale: number;
  part: "S" | "A" | "T" | "B";
  phrase: string;
  /** Custom transposition in semitones — overrides the voice-derived one. */
  transpose?: number;
}

export function parsePermalink(hash: string = window.location.hash): Permalink | null {
  const trimmed = hash.replace(/^#/, "");
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);
  const p = params.get("p");
  if (!p) return null;
  const m = p.match(/^(\d+)\.([SATB])(\d+)$/);
  if (!m) return null;
  const out: Permalink = {
    chorale: parseInt(m[1], 10),
    part: m[2] as "S" | "A" | "T" | "B",
    phrase: m[3],
  };
  const t = params.get("t");
  if (t != null && /^-?\d+$/.test(t)) out.transpose = parseInt(t, 10);
  return out;
}

export function findPhrase(rows: PhraseRow[], pl: Permalink): PhraseRow | null {
  return rows.find(
    (r) => r.chorale === pl.chorale && r.part === pl.part && r.phrase === pl.phrase,
  ) ?? null;
}

export function permalinkFor(row: PhraseRow, transpose?: number): string {
  const base = `p=${row.chorale}.${row.part}${row.phrase}`;
  return transpose != null ? `${base}&t=${transpose}` : base;
}
