# BachDay

## Original spec

Use Music21 to get all the Bach Chorales, and using the pauses marked in the soprano line extract each phrase. For each phrase, extract the 4 parts. Then use this, as well as the ABC export features of converter21, to export a dataset of every monophonic phrase in the Bach chorales. Each phrase should be tagged by the number of the chorale in the corpus, as well as the part (SATB) and the phrase (e.g. 1,2,3,4,5...with 0 padding if there are any bach chorales with more than 10 phrases). Information about the ambitus of the phrase should also be included, since we will later transpose them.

Then make a website called BachDay which shuffles (in a deterministic fashion) all these monophonic phrases and arranges them on a daily curriculum of one per day, Wordle style. The website should, if it isn't present, prompt the user for their voice type (e.g. Soprano, Mezzo-Soprano, Alto, Tenor, Baritone or Bass) and then each day present (using abcjs) the phrase transposed into a key and register (e.g. octave higher or lower) suitable for that voice type. Also include the moveable do solfege as lyrics, but give the option to show (a) no solfege (b) only the chromatic solfege e.g. di ri fi si li ra me se le te, that is notes outside the key) (c) all solfege. Then using the same CREPE model as https://marl.github.io/crepe/ it should allow the user to record themself performing the part, with pitch detection. This should then be compared against a midi representation of the correct pitches (I think abcjs can also help generate the midi) where we rescale to give the optimistic best fit rhythm wise. The accuracy should be displayed in some sort of graph for the user, overlaid on the famous portrait of Bach, for sharing on social media. Also make a way to save the user's accuracy for future reference. (Maybe later on we'll use some sort of OAuth to do this, but for now just make it a static site.)

## Current state

### Dataset pipeline (`process_dataset.py`)
- Iterates the music21 Bach chorale corpus, splits by soprano fermatas, exports each monophonic part via converter21's ABC writer (`register(ConverterName.ABC)`).
- Output: `web/public/phrases.json` shaped as `{ chorales: {N: {title, translation}}, lyrics: {"N.PP": [verse_syllables[]]}, phrases: [{chorale, part, phrase, ambitus_lo, ambitus_hi, abc}] }`.
- German titles pulled from `metadata.title` / `movementName` / `alternativeTitle`, filtering out filename-style entries.
- Per-part ABC strips `w:` lines; lyrics stored separately per verse with `*` melisma padding so they can be reattached to any voice (and translated).

### Web app (`web/`, Vite + vanilla TS)
- **`src/main.ts`** — glue. Loads `/phrases.json`, renders title (German), wires controls (voice / solfege / show-lyrics / beginner-show-target). Calls `preloadCrepe()` on load. `renderPhraseView` flow: chooseTransposition → soundingLo/Hi → chooseClef → CLEF_STAFF_OFFSET → setAbcClef → optionally addChoraleLyrics → addSolfegeLyrics → abcjs render with `visualTranspose: currentTranspose + staffOffset`. Synth uses `midiTranspose: currentTranspose`. Computes `transposedTonicPc` and passes to LiveTraceRenderer.
- **`src/voice.ts`** — voice ranges, clef choice, transposition logic. Key invariant: `VOICE_OWNS_PART` maps only Soprano→S, Alto→A, Tenor→T, Bass→B. Own-voice singers keep the original key (octave-only shifts); Mezzo and Baritone always cross-voice with chromatic centring so voice ordering stays monotonic (Soprano ≥ Mezzo ≥ Alto ≥ Tenor ≥ Baritone ≥ Bass). Default clefs are treble/treble-8/bass only — no C clefs. `CLEF_STAFF_OFFSET` compensates treble-8's octave displacement (+12) so abcjs draws notes at the right staff position.
- **`src/abc.ts`** — ABC parser/manipulator. `NOTE_RE` captures accidental+letter+octave+duration. `isHeaderLine = /^[A-Za-z]:/`. `stripNonNotes` removes `!…!`, `"…"`, `%…` so decorations and voice declarations don't leak into the note stream. Helpers: `setAbcClef`, `addSolfegeLyrics`, `addChoraleLyrics`, `abcSourceMidiSequence`, `abcSourceNoteSequence`, `midiSequenceFromVisual`, `parseDurationToken`.
- **`src/pitch.ts`** — real-time CREPE pitch detection via `@tensorflow/tfjs`. Model URL: `https://marl.github.io/crepe/model/model.json`. SR=16000, FRAME=1024, ±4-bin weighted peak picking, voicing threshold 0.3. `LivePitchDetector` does mic capture → linear resample to 16k → ring buffer → one-in-flight inference. `preloadCrepe()` warms the model on page load.
- **`src/live-trace.ts`** — canvas pitch-trace renderer. During recording only the user's pitch is drawn (sight-singing); on `freeze()` the X axis rescales to the voiced span and target bars appear underneath. `TargetNote = {midi, duration}`; `slotEdges` are cumulative normalised durations so target bars reflect rhythm. Beginner toggle (`showTargetWhileSinging`) re-enables target bars during recording. Per-note tolerance = 50¢ + a JI-deviation table per scale degree relative to the tonic (so 3rds/6ths get ±70¢, 5ths stay at ±56¢). `computeScore` takes the median voiced frame per slot, snaps to the nearest octave of target, counts within-tolerance hits.
- **`src/cue.ts`** — `playDoSolDo(abc, transposeSemitones, voiceMidMidi)`. Plays do-sol-do in the transposed key (WebAudio triangle waves) instead of revealing the whole phrase.
- **`src/accuracy.ts`** — `renderShareCanvas` composites Bach portrait backdrop + target bars + user trace + score header for social sharing.
- **`src/schedule.ts`** — `phraseForDate` with mulberry32 + xmur3 seeded deterministic shuffle for the daily curriculum.
- **`src/solfege.ts`** — `tonicPc(keyStr)`, moveable-do labels (`do/re/mi/fa/sol/la/ti` + chromatic `di/ri/fi/si/li/ra/me/se/le/te`), `isChromatic` predicate.
- **`src/storage.ts`** — typed localStorage wrapper. `Prefs = { voice, solfege, showTargetWhileSinging?, showLyrics? }`. `HistoryEntry` keyed by date.

### Open TODOs (next session)
- **Rest handling** — rescale recorded audio in time so silence added to the start/end doesn't penalise the grade. Pick the alignment that maximises score against the target.
- **Permalinks** to individual passages. When both "today's passage" and "shuffle" buttons are visible, keep shuffle on the right (don't reorder). Allow custom transpositions via the permalink, which should temporarily override the saved voice preference.
- **Carried accidentals across phrase boundaries** — when an accidental from a previous phrase still applies in the original chorale, the extracted phrase's ABC needs the accidental re-stated (otherwise the note is wrong without the prior bar's context).
- **Practice mode without easy mode** — let users use practice mode any time; temporarily reveal target pitches during practice even if easy mode is off.
- **Retries** — currently buggy after a single recording. Allow multiple attempts cleanly. The shareable image should either note the attempt number or only be available for the first attempt.
- **Warm-up scale** in the upcoming key, displayed like easy-mode (with steps shown). Toggle in settings.
- **Reference G pitch on load** — show G4 for women / G3 for men, with key signature + natural sign if needed and a solfege label indicating that pitch's scale degree in the upcoming key. Goal: ear-training / perfect-pitch development. Display via the practice-mode horizontal bar. Toggle in settings.

### Notable past decisions / things to preserve
- Use abcjs's own `visualTranspose` for display and `midiTranspose` for synth — never hand-roll ABC transposition. abc_midi_sequencer applies `-= visualTranspose`, so both options must be set.
- No C clefs — user dislikes them. Tenor uses `treble-8`.
- CREPE, not YIN. The correct model URL is `marl.github.io/crepe/model/...` (no `model-tiny/`).
- Marking must allow for non-ET tuning (JI deviation table).
- Target bars must reflect rhythm via `slotEdges`, not equal-spaced.
- Lyrics are stored once per chorale-phrase and reattached at render time so all parts can show them and translations remain possible.
