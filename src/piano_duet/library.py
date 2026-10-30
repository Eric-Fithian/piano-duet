import hashlib
import json
from math import ceil
from statistics import mean

from piano_duet.key_tracking import MusicalKey
from piano_duet.score_import import METERS, TICKS

STORE = "https://gibranalcocer.com/products/"
# Gibran Alcocer's piano solo scores, as listed on his official store.
CATALOG = [
    {"title": f"Idea {number}", "artist": "Gibran Alcocer", "url": STORE + path}
    for number, path in (
        (1, "idea-1-music-score"),
        (2, "idea-2-gibran-alcocer-sheet-music-piano-solo"),
        (5, "idea-5-sheet-music"),
        (7, "idea-7-sheet-music"),
        (9, "idea-9-music-score"),
        (10, "idea-10-sheet-music"),
        (12, "idea-12-gibran-alcocer-sheet-music-piano"),
        (15, "idea-15-sheet-music"),
        (20, "idea-20-sheet-music"),
        (22, "idea-22-music-score"),
        (25, "idea-25-piano-solo-version-sheet-music"),
    )
]
RECENT_PLAYS = 5
SECTION_PLAYS = 3
BEST_MINIMUM = 16


def main():
    print(f"{len(CATALOG)} catalog songs; import a MIDI or MusicXML file to play one.")


def song_attacks(notes):
    attacks = []
    for index, note in enumerate(notes):
        if attacks and abs(notes[attacks[-1][0]]["start"] - note["start"]) < 1e-9:
            attacks[-1].append(index)
        else:
            attacks.append([index])
    return attacks


def song_sections(song):
    numerator, denominator = map(int, song["meter"].split("/"))
    bar_seconds = numerator * 4 / denominator * 60 / song["bpm"]
    size = 4 if song["bars"] <= 16 else 8
    attacks = song_attacks(song["notes"])
    sections = []
    for first in range(0, song["bars"], size):
        last = min(song["bars"], first + size)
        inside = [i for i, attack in enumerate(attacks)
                  if first * bar_seconds - 1e-9 <= song["notes"][attack[0]]["start"] < last * bar_seconds - 1e-9]
        if inside:
            sections.append({"number": len(sections) + 1, "label": f"Bars {first + 1}–{last}",
                             "first_bar": first + 1, "start": inside[0], "end": inside[-1] + 1})
    return sections


def song_version(notes):
    """A fingerprint of the pitches at each attack: plays record attack positions, so they describe exactly the
    versions of a song that share it. Retiming, rebarring or rekeying keeps it; adding, removing or repitching
    notes changes it, and reverting brings the original back with its plays."""
    shape = [sorted(notes[index]["pitch"] for index in attack) for attack in song_attacks(notes)]
    return hashlib.sha256(json.dumps(shape).encode()).hexdigest()[:16]


def edit_song(song, bpm, meter, key, notes):
    """The song with its tempo, meter, key and notes replaced. The first edit keeps the transcription so it can be
    restored."""
    if meter not in METERS:
        raise ValueError(f"{meter} time is not supported")
    if not notes:
        raise ValueError("A song needs at least one note")
    notes = sorted(notes, key=lambda note: (note["start"], note["pitch"]))
    for note in notes:
        # Every onset and ending must sit on the score's grid (twelve ticks a beat) at the new tempo.
        for edge in (note["start"], note["start"] + note["duration"]):
            if abs(edge * bpm / 60 * TICKS - round(edge * bpm / 60 * TICKS)) > 1e-3:
                raise ValueError("Every note must start and end on the score's sixteenth or triplet grid")
    numerator, denominator = map(int, meter.split("/"))
    beats = max(note["start"] + note["duration"] for note in notes) * bpm / 60
    edited = {**song, "bpm": bpm, "meter": meter, "key": MusicalKey(*key).to_dict(), "notes": notes,
              "bars": max(1, ceil(round(beats, 6) / (numerator * 4 / denominator))),
              "original": song.get("original") or {field: song[field] for field in ("bpm", "meter", "key", "bars", "notes")}}
    return edited


def revert_song(song):
    if "original" not in song:
        raise ValueError("This song has not been edited")
    original = song["original"]
    return {key: value for key, value in song.items() if key != "original"} | original


def accuracy(rows):
    return round(100 * mean(first for _, first in rows)) if rows else None


def song_stats(song, plays):
    plays = [play for play in plays if play["version"] == song_version(song["notes"])]
    total = len(song_attacks(song["notes"]))
    sections = song_sections(song)
    per_play = [play["attacks"] for play in plays if play["attacks"]]
    recent = [row for attacks in per_play[-RECENT_PLAYS:] for row in attacks]
    best = [accuracy(attacks) for attacks in per_play if len(attacks) >= min(BEST_MINIMUM, total)]
    for section in sections:
        touching = [[row for row in attacks if section["start"] <= row[0] < section["end"]] for attacks in per_play]
        touching = [rows for rows in touching if rows][-SECTION_PLAYS:]
        section["accuracy"] = accuracy([row for rows in touching for row in rows])
        section["plays"] = len(touching)
    return {
        "plays": len(per_play),
        "accuracy": accuracy(recent),
        "best": max(best) if best else None,
        "coverage": round(100 * len({row[0] for attacks in per_play for row in attacks}) / total),
        "last_played": plays[-1]["created_at"] if plays else None,
        "sections": sections,
        "attacks": total,
    }


def summary(song, plays):
    stats = song_stats(song, plays)
    seconds = max(note["start"] + note["duration"] for note in song["notes"])
    return {"id": song["id"], "title": song["title"], "artist": song["artist"], "bars": song["bars"],
            "seconds": round(seconds), "bpm": song["bpm"], "key": song["key"]["name"], "meter": song["meter"],
            "created_at": song["created_at"], **{key: stats[key] for key in ("plays", "accuracy", "best", "coverage", "last_played")}}


if __name__ == "__main__":
    main()
