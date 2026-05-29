# BachDay

A daily-Wordle-style sight-singing trainer. Each day BachDay shows you one
monophonic phrase from a Bach chorale, transposed for your voice, and asks
you to sing it. It listens with CREPE, scores your pitch, and renders a
share image over the famous portrait of Bach.

## Two halves

### 1. Dataset pipeline (Python)

[process_dataset.py](process_dataset.py) walks the Bach chorales in the
music21 corpus, splits the soprano line on fermatas to find phrases, and
emits an ABC + metadata record per (chorale, phrase, SATB part) into
`dataset/phrases.json`.

```
uv sync
uv run python process_dataset.py
cp dataset/phrases.json web/public/phrases.json
```

Each row is `{ chorale, part, phrase, ambitus_lo, ambitus_hi, abc }`. The
ambitus (MIDI lo/hi) is what the website uses to pick a transposition.

### 2. Web app (Vite + vanilla TS)

```
cd web
npm install
npm run dev
```

Drop a portrait at `web/public/bach.jpg` before generating share images.

Modules:

- [src/voice.ts](web/src/voice.ts) — voice ranges and a transposition picker.
- [src/schedule.ts](web/src/schedule.ts) — deterministic daily shuffle (mulberry32 + xmur3).
- [src/abc.ts](web/src/abc.ts) — ABC transposition, MIDI extraction, solfege `w:` lyric injection.
- [src/solfege.ts](web/src/solfege.ts) — moveable-do syllables (do/re/mi… + chromatic di/ri/me…).
- [src/recorder.ts](web/src/recorder.ts) — mic capture into a `Float32Array`.
- [src/pitch.ts](web/src/pitch.ts) — CREPE-tiny via tfjs, with a YIN fallback if the model can't load.
- [src/accuracy.ts](web/src/accuracy.ts) — optimistic best-fit-rhythm scoring + Bach-portrait share canvas.
- [src/storage.ts](web/src/storage.ts) — localStorage prefs and attempt history.
- [src/main.ts](web/src/main.ts) — glue.

## Known limitations / TODO

- The CREPE model URL in [pitch.ts](web/src/pitch.ts) points at
  `marl.github.io/crepe/model-tiny/model.json`. If MARL move the model,
  the loader falls back to a YIN autocorrelation estimator.
- ABC transposition is a text rewrite over noteheads — it handles the
  conservative ABC that converter21 emits but not arbitrary ABC.
- No user accounts yet — history lives in `localStorage`.
- The share canvas needs `web/public/bach.jpg` (not committed).
