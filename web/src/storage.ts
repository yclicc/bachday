/** Tiny typed wrapper around localStorage for BachDay state. */

import type { VoiceType } from "./voice";
import type { SolfegeMode } from "./solfege";

const PREFS_KEY = "bachday:prefs";
const HISTORY_KEY = "bachday:history";

export interface Prefs {
  voice: VoiceType | null;
  solfege: SolfegeMode;
  showTargetWhileSinging?: boolean;
  /** Show an ascending warm-up scale in the upcoming key above the phrase. */
  showWarmupScale?: boolean;
  /** Show a fixed-pitch reference (G4 / G3) labelled with its solfege in the
   * upcoming key — for ear training / building absolute-pitch reference. */
  showReferencePitch?: boolean;
  onboarded?: boolean;
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
  const defaults: Prefs = {
    voice: null,
    solfege: "all",
    showTargetWhileSinging: false,
    showWarmupScale: true,
    showReferencePitch: true,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      // Merge so existing users pick up newly-added defaults (e.g. the warm-up
      // toggles) on first load after the feature ships.
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return { ...defaults, ...parsed };
    }
  } catch {}
  return defaults;
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
