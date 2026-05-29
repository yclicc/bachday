/** Tiny typed wrapper around localStorage for BachDay state. */

import type { VoiceType } from "./voice";
import type { SolfegeMode } from "./solfege";

const PREFS_KEY = "bachday:prefs";
const HISTORY_KEY = "bachday:history";

export interface Prefs {
  voice: VoiceType | null;
  solfege: SolfegeMode;
  showTargetWhileSinging?: boolean;
  showLyrics?: boolean;
}

export interface HistoryEntry {
  date: string;             // YYYY-MM-DD UTC
  chorale: number;
  part: "S" | "A" | "T" | "B";
  phrase: string;
  score: number;            // 0..1
  meanCentsError: number;
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { voice: null, solfege: "all", showTargetWhileSinging: false, showLyrics: true };
}

export function savePrefs(p: Prefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const all = loadHistory().filter((e) => e.date !== entry.date);
  all.push(entry);
  all.sort((a, b) => (a.date < b.date ? 1 : -1));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  return all;
}
