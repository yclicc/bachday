"""Extract monophonic phrases from the Bach chorales in the music21 corpus.

For every chorale we walk the soprano line and split on fermatas to get
phrases. For each phrase we extract the four SATB parts as ABC strings (via
converter21), compute the ambitus, and capture the syllables — separately
from the ABC so the website can toggle lyrics on/off, render them under
every part, or swap in a translation.

Output structure (dataset/phrases.json):

    {
      "chorales": {
        "1": {"title": "Aus meiner Sünden Tiefe", "translation": null}
      },
      "lyrics": {
        "1.01": [["Aus","mei-","nes",...], ["in","die-","ser",...]]
      },
      "phrases": [
        {chorale, part, phrase, ambitus_lo, ambitus_hi, abc}, ...
      ]
    }

Run with:  uv run python process_dataset.py
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, cast

from music21 import clef, converter, corpus, expressions, metadata, note, stream
from converter21 import ConverterName, register

register(ConverterName.ABC)

OUT_PATH = Path(__file__).parent / "dataset" / "phrases.json"

PART_NAMES = ("Soprano", "Alto", "Tenor", "Bass")
PART_CODES = ("S", "A", "T", "B")


def soprano_fermata_offsets(part: stream.Part) -> list[float]:
    offsets: list[float] = []
    for n in part.flatten().notes:
        for exp in n.expressions:
            if isinstance(exp, expressions.Fermata):
                offsets.append(float(n.offset + n.duration.quarterLength))
                break
    return sorted(set(offsets))


def slice_part(part: stream.Part, start: float, end: float) -> stream.Part:
    sliced = stream.Part()
    for n in part.flatten().notesAndRests:
        off = float(n.offset)
        if start <= off < end:
            new_n = copy.deepcopy(n)
            new_n.offset = off - start
            sliced.insert(off - start, new_n)
    flat = part.flatten()
    ts = flat.getElementsByClass("TimeSignature")
    if ts:
        sliced.insert(0, copy.deepcopy(ts[0]))
    ks = flat.getElementsByClass("KeySignature")
    if ks:
        sliced.insert(0, copy.deepcopy(ks[0]))
    cls = flat.getElementsByClass(clef.Clef)
    if cls:
        sliced.insert(0, copy.deepcopy(cls[0]))
    measured = sliced.makeMeasures(inPlace=False)
    return cast(stream.Part, measured)


def ambitus(part: stream.Part) -> tuple[int, int] | None:
    pitches: list[int] = []
    for n in part.flatten().notes:
        if isinstance(n, note.Note):
            pitches.append(n.pitch.midi)
    if not pitches:
        return None
    return (min(pitches), max(pitches))


def part_to_abc(part: stream.Part, title: str) -> str:
    score = stream.Score()
    score.metadata = metadata.Metadata(title=title)
    score.insert(0, part)
    data = converter.toData(score, fmt="abc")
    if isinstance(data, bytes):
        data = data.decode("utf-8", errors="replace")
    return data


def strip_lyric_lines(abc: str) -> str:
    """Remove every `w:` line from an ABC document — we render lyrics separately."""
    return "\n".join(line for line in abc.split("\n") if not line.startswith("w:"))


def extract_lyrics(part: stream.Part) -> list[list[str]]:
    """Return one syllable list per verse. Music21 stores lyrics as `Lyric`
    objects on each Note; the `number` field disambiguates verses. Notes with
    no lyric in a given verse get a melisma marker (`*`) so syllable counts
    match note counts. """
    verses: dict[int, list[str]] = {}
    notes = [n for n in part.flatten().notes if isinstance(n, note.Note)]
    if not notes:
        return []
    # discover which verse numbers exist
    verse_nums: set[int] = set()
    for n in notes:
        for ly in n.lyrics:
            if ly.text:
                verse_nums.add(ly.number or 1)
    if not verse_nums:
        return []
    for v in sorted(verse_nums):
        syllables: list[str] = []
        for n in notes:
            picked = next((ly for ly in n.lyrics if (ly.number or 1) == v and ly.text), None)
            if picked is None:
                syllables.append("*")
                continue
            text = picked.text
            # music21's syllabic markers: begin/middle add trailing dash, end adds nothing,
            # single is a complete word. We render as plain text + dashes for ABC.
            syl = picked.syllabic
            if syl in ("begin", "middle"):
                text = text + "-"
            syllables.append(text)
        verses[v] = syllables
    return [verses[v] for v in sorted(verses)]


def chorale_title(score: stream.Score, chorale_num: int) -> str:
    md: Any = score.metadata
    if md is None:
        return f"BWV {chorale_num}"
    # Look at several metadata fields in order of preference.
    for attr in ("title", "movementName", "alternativeTitle"):
        val = getattr(md, attr, None)
        if val and isinstance(val, str):
            v = val.strip()
            # Filenames like "bwv1.6.mxl" aren't useful titles.
            if v and not v.lower().endswith((".mxl", ".xml", ".krn")) and not v.startswith("bwv"):
                return v
    return f"BWV {chorale_num}"


def process_chorale(score: stream.Score, chorale_num: int):
    parts = find_parts(score)
    if not parts:
        return None, [], {}
    fermata_offsets = soprano_fermata_offsets(parts["S"])
    if not fermata_offsets:
        return None, [], {}
    boundaries = [0.0, *fermata_offsets]
    n_phrases = len(boundaries) - 1
    width = max(2, len(str(n_phrases)))

    title = chorale_title(score, chorale_num)
    rows: list[dict] = []
    lyrics_by_phrase: dict[str, list[list[str]]] = {}

    for i in range(n_phrases):
        start, end = boundaries[i], boundaries[i + 1]
        phrase_id = str(i + 1).zfill(width)
        # Lyrics come from the Soprano slice — Bach chorales are homophonic
        # and the words align identically across SATB.
        sop_slice = slice_part(parts["S"], start, end)
        lyrics = extract_lyrics(sop_slice)
        if lyrics:
            lyrics_by_phrase[phrase_id] = lyrics

        for code in PART_CODES:
            sliced = slice_part(parts[code], start, end)
            amb = ambitus(sliced)
            if amb is None:
                continue
            try:
                abc = part_to_abc(sliced, f"BWV{chorale_num} {code}{phrase_id}")
            except Exception as e:
                print(f"  ! ABC export failed (chorale {chorale_num} {code}{phrase_id}): {e}", file=sys.stderr)
                continue
            rows.append({
                "chorale": chorale_num,
                "part": code,
                "phrase": phrase_id,
                "ambitus_lo": amb[0],
                "ambitus_hi": amb[1],
                "abc": strip_lyric_lines(abc),
            })
    return title, rows, lyrics_by_phrase


def find_parts(score: stream.Score) -> dict[str, stream.Part] | None:
    parts = list(score.parts)
    if len(parts) < 4:
        return None
    found: dict[str, stream.Part] = {}
    for p in parts:
        name = (p.partName or "").strip().lower()
        for full, code in zip(PART_NAMES, PART_CODES):
            if name.startswith(full.lower()) and code not in found:
                found[code] = p
    if len(found) == 4:
        return found
    return {code: parts[i] for i, code in enumerate(PART_CODES)}


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    phrases: list[dict] = []
    chorales: dict[str, dict] = {}
    lyrics: dict[str, list[list[str]]] = {}

    it = corpus.chorales.Iterator()
    for idx, item in enumerate(it, start=1):
        if not isinstance(item, stream.Score):
            continue
        try:
            title, rows, phrase_lyrics = process_chorale(item, idx)
        except Exception as e:
            print(f"  ! [{idx}] failed: {e}", file=sys.stderr)
            continue
        if not rows:
            continue
        chorales[str(idx)] = {"title": title or f"BWV {idx}", "translation": None}
        phrases.extend(rows)
        for phrase_id, verses in phrase_lyrics.items():
            lyrics[f"{idx}.{phrase_id}"] = verses
        print(f"[{idx}] {title} — {len(rows)} part-phrases")

    out = {"chorales": chorales, "lyrics": lyrics, "phrases": phrases}
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote {len(phrases)} phrase-parts, {len(chorales)} chorales, {len(lyrics)} lyric-sets to {OUT_PATH}")


if __name__ == "__main__":
    main()
