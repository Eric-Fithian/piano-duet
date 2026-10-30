import struct
from collections import Counter
from fractions import Fraction
from io import BytesIO
from statistics import mean
from zipfile import ZipFile

from defusedxml import ElementTree

from piano_duet.key_tracking import KeyTracker, MusicalKey, signature_mode
from piano_duet.notes import Note

TICKS = 12
METERS = ("2/4", "3/4", "4/4", "5/4", "3/8", "6/8", "7/8", "9/8", "12/8")
STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
TEMPO_RANGE = (30, 240)
# Largest change of playback speed that clamping a transcription's tempo into TEMPO_RANGE may make.
TEMPO_SLACK = 0.05
# Factors a transcription's note values may be multiplied by, nearest first: a model can write a passage at half its
# tempo in 32nds, or at double its tempo beyond the range the player reads at.
NOTE_VALUE_SCALES = (1, 2, 0.5, 4, 0.25)
# Share of written onsets that rounding onto the grid may merge before the note values are rescaled instead.
MERGE_TOLERANCE = 0.02
# The model's names for bars of three and six quarters, and the meters they are drawn in: (simple, compound).
COMPOUND_CHOICES = {"3/4": ("3/4", "6/8"), "12/8": ("3/4", "12/8")}


class ScoreError(ValueError):
    """A score file the player can fix or re-export."""


def main():
    print("Imports MIDI and MusicXML piano scores into exact reading targets.")


def parse_score(filename, data):
    name = filename.lower()
    if name.endswith((".mid", ".midi")):
        return parse_midi(data)
    if name.endswith((".musicxml", ".xml")):
        return parse_musicxml(data)
    if name.endswith(".mxl"):
        return parse_musicxml(unzip_musicxml(data))
    raise ScoreError("Import a MIDI (.mid) or MusicXML (.musicxml, .xml, .mxl) file")


def variable_length(data, at):
    value = 0
    while True:
        byte = data[at]
        at += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, at


def parse_midi(data):
    if data[:4] != b"MThd":
        raise ScoreError("This is not a standard MIDI file")
    length, _, tracks, division = struct.unpack(">IHHH", data[4:14])
    if division & 0x8000:
        raise ScoreError("SMPTE-timed MIDI files are not supported; export with beat timing")
    at = 8 + length
    notes, tempos, meters, keys = [], [], [], []
    for track in range(tracks):
        if data[at : at + 4] != b"MTrk":
            raise ScoreError("The MIDI file has a malformed track")
        (size,) = struct.unpack(">I", data[at + 4 : at + 8])
        at, end, tick, status, open_notes = at + 8, at + 8 + size, 0, None, {}
        while at < end:
            delta, at = variable_length(data, at)
            tick += delta
            if data[at] == 0xFF:
                kind, at = data[at + 1], at + 2
                size_meta, at = variable_length(data, at)
                body, at = data[at : at + size_meta], at + size_meta
                if kind == 0x51:
                    tempos.append((tick, 60_000_000 / int.from_bytes(body, "big")))
                elif kind == 0x58:
                    meters.append((tick / division, f"{body[0]}/{2 ** body[1]}"))
                elif kind == 0x59:
                    keys.append((tick, struct.unpack(">b", body[:1])[0], "minor" if body[1] else "major"))
                elif kind == 0x2F:
                    break
                continue
            if data[at] in (0xF0, 0xF7):
                size_sysex, at = variable_length(data, at + 1)
                at += size_sysex
                continue
            # Channel messages may omit a repeated status byte; meta and sysex events never set it.
            if data[at] & 0x80:
                status, at = data[at], at + 1
            if status is None:
                raise ScoreError("The MIDI file uses running status before any event")
            kind, channel = status & 0xF0, status & 0x0F
            width = 1 if kind in (0xC0, 0xD0) else 2
            values, at = data[at : at + width], at + width
            if channel == 9:
                continue
            pitch = values[0]
            if kind == 0x90 and values[1] > 0:
                open_notes.setdefault(pitch, []).append((tick, values[1]))
            elif (kind == 0x80 or (kind == 0x90 and values[1] == 0)) and open_notes.get(pitch):
                start, velocity = open_notes[pitch].pop(0)
                notes.append({"pitch": pitch, "beat": start / division, "length": (tick - start) / division,
                              "velocity": velocity, "track": track})
        at = end
    by_track = {}
    for note in notes:
        by_track.setdefault(note["track"], []).append(note["pitch"])
    hands = sorted(by_track, key=lambda track: mean(by_track[track]))
    # Two note-bearing tracks are the left and right hands; otherwise split at middle C.
    for note in notes:
        track = note.pop("track")
        note["staff"] = ("bass" if track == hands[0] else "treble") if len(hands) == 2 else (
            "bass" if note["pitch"] < 60 else "treble")
    return {
        "notes": notes,
        "bpm": round(min(tempos)[1]) if tempos else 120,
        "meters": sorted(meters),
        "key": min(keys)[1:3] if keys else None,
        "title": None,
        "composer": None,
        "pickup": 0,
    }


def unzip_musicxml(data):
    with ZipFile(BytesIO(data)) as archive:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
        root = next(item.get("full-path") for item in container.iter() if item.tag.endswith("rootfile"))
        return archive.read(root)


def parse_musicxml(data):
    root = ElementTree.fromstring(data)
    if root.tag != "score-partwise":
        raise ScoreError("Only partwise MusicXML is supported; export the score again from MuseScore")
    title = root.findtext("work/work-title") or root.findtext("movement-title")
    composer = root.findtext("identification/creator[@type='composer']")
    notes, meters, keys, tempos, pickup, measures = [], [], [], [], 0, []
    parts = root.findall("part")
    for part_index, part in enumerate(parts):
        divisions, measure_start, staves = 1, 0.0, 1
        for measure_index, measure in enumerate(part.findall("measure")):
            if part_index == 0:
                measures.append(measure_start)
            cursor, longest, last_start = measure_start, measure_start, measure_start
            for item in measure:
                if item.tag == "attributes":
                    divisions = int(item.findtext("divisions", divisions))
                    staves = int(item.findtext("staves", staves))
                    if item.find("time") is not None and part_index == 0:
                        meters.append((measure_start, f"{item.findtext('time/beats')}/{item.findtext('time/beat-type')}"))
                    if item.find("key") is not None and part_index == 0:
                        # The score model writes a signature without a mode; build_song decides major or minor.
                        keys.append((measure_start, int(item.findtext("key/fifths")), item.findtext("key/mode")))
                elif item.tag == "sound" and item.get("tempo") and part_index == 0:
                    tempos.append((cursor, float(item.get("tempo"))))
                elif item.tag == "direction" and item.find("sound") is not None and item.find("sound").get("tempo") and part_index == 0:
                    tempos.append((cursor, float(item.find("sound").get("tempo"))))
                elif item.tag in ("backup", "forward"):
                    step = int(item.findtext("duration")) / divisions
                    cursor += -step if item.tag == "backup" else step
                elif item.tag == "note":
                    # A grace note takes no written time; it is kept and played just before the note it ornaments.
                    grace = item.find("grace") is not None
                    length = 0.0 if grace else int(item.findtext("duration", "0")) / divisions
                    start = last_start if item.find("chord") is not None else cursor
                    if item.find("rest") is None:
                        step = item.findtext("pitch/step")
                        pitch = 12 * (int(item.findtext("pitch/octave")) + 1) + STEPS[step] + round(float(item.findtext("pitch/alter", "0")))
                        staff = int(item.findtext("staff", "1"))
                        ties = {tie.get("type") for tie in item.findall("tie")}
                        notes.append({"pitch": pitch, "beat": start, "length": length, "velocity": 80,
                                      "staff": hand(part_index, len(parts), staves, staff, pitch),
                                      "voice": (part_index, staff, item.findtext("voice", "1")), "grace": grace,
                                      "tie_start": "start" in ties, "tie_stop": "stop" in ties})
                    last_start = start
                    if item.find("chord") is None:
                        cursor = start + length
                longest = max(longest, cursor)
            if measure_index == 0 and part_index == 0 and measure.get("implicit") == "yes":
                pickup = longest - measure_start
            measure_start = longest
    return {
        "notes": voice_ranks(merge_ties(notes)),
        "bpm": round(min(tempos)[1]) if tempos else 72,
        "meters": sorted(meters),
        "key": min(keys)[1:3] if keys else None,
        "title": title,
        "composer": composer,
        "pickup": pickup,
        "measures": measures,
    }


def hand(part_index, parts, staves, staff, pitch):
    """Two-staff parts give the hand; two one-staff parts are right then left; otherwise split at middle C."""
    if staves == 2:
        return "treble" if staff == 1 else "bass"
    if parts == 2:
        return "treble" if part_index == 0 else "bass"
    return "treble" if pitch >= 60 else "bass"


def merge_ties(notes):
    merged = []
    for note in sorted(notes, key=lambda item: item["beat"]):
        if note.get("tie_stop"):
            held = next((item for item in reversed(merged) if item["pitch"] == note["pitch"] and not item["grace"]
                         and abs(item["beat"] + item["length"] - note["beat"]) < 1e-6), None)
            if held is not None:
                held["length"] += note["length"]
                continue
        merged.append(note)
    return [{key: value for key, value in note.items() if not key.startswith("tie_")} for note in merged]


def voice_ranks(notes):
    """Each hand's busiest written voice is drawn as its main voice (0); any others share a second voice (1)."""
    main = {staff: Counter(note["voice"] for note in notes if note["staff"] == staff).most_common(1)[0][0]
            for staff in {note["staff"] for note in notes}}
    return [{**note, "voice": int(note["voice"] != main[note["staff"]])} for note in notes]


def dominant_meter(meters, end):
    spans = Counter()
    for (start, meter), following in zip(meters, [start for start, _ in meters[1:]] + [end]):
        spans[meter] += following - start
    return spans.most_common(1)[0][0]


# The score renders sixteenths and, in simple meters, triplet eighths; finer values are rounded onto them.
SIXTEENTHS, TRIPLETS = (0, 3, 6, 9, 12), (0, 4, 8, 12)


def beat_grids(ticks, compound):
    """Chooses one grid per beat, so every onset and ending inside that beat can be written."""
    onsets = {}
    for tick in ticks:
        onsets.setdefault(int(tick // TICKS), []).append(tick % TICKS)
    grids = {}
    for beat, positions in onsets.items():
        error = {grid: sum(min(abs(position - mark) for mark in grid) for position in positions) for grid in (SIXTEENTHS, TRIPLETS)}
        grids[beat] = TRIPLETS if not compound and error[TRIPLETS] < error[SIXTEENTHS] else SIXTEENTHS
    return grids


def note_value_scale(parsed, compound):
    """The first of NOTE_VALUE_SCALES whose tempo is within TEMPO_SLACK of TEMPO_RANGE and at which rounding onto the
    grid merges few written onsets into one; otherwise the one of those that merges fewest."""
    onsets = {(note["staff"], round(note["beat"], 6)) for note in parsed["notes"]}

    def merged(scale):
        starts = [(staff, beat * scale * TICKS) for staff, beat in onsets]
        grids = beat_grids([tick for _, tick in starts], compound)
        return (len(starts) - len({(staff, snap(tick, grids)) for staff, tick in starts})) / len(starts)

    scales = [scale for scale in NOTE_VALUE_SCALES if abs(clamp_tempo(parsed["bpm"] * scale) / (parsed["bpm"] * scale) - 1) <= TEMPO_SLACK]
    if not scales:
        raise ScoreError(f"A tempo of {parsed['bpm']} bpm cannot be written in any note values")
    return next((scale for scale in scales if merged(scale) <= MERGE_TOLERANCE), min(scales, key=merged))


def clamp_tempo(bpm):
    return min(TEMPO_RANGE[1], max(TEMPO_RANGE[0], bpm))


def same_length_meter(meter):
    """A supported meter whose bar spans as many quarter notes, preferring quarter-note beats (4/8 is written as 2/4)."""
    length = Fraction(meter) * 4
    matches = sorted((supported for supported in METERS if Fraction(supported) * 4 == length), key=lambda supported: not supported.endswith("/4"))
    if not matches:
        raise ScoreError(f"{meter} time is not supported yet")
    return matches[0]


def snap(tick, grids):
    beat, position = divmod(tick, TICKS)
    grid = grids.get(int(beat), SIXTEENTHS)
    return int(beat) * TICKS + min(grid, key=lambda mark: abs(position - mark))


def step(tick, grids):
    grid = grids.get(tick // TICKS, SIXTEENTHS)
    return next(mark for mark in grid if mark > tick % TICKS) - tick % TICKS


def bar_layout(parsed, transcribed):
    """The meter a score is drawn in, the parse with any rescaling of its note values applied, and the shift in
    quarters that puts the drawn bar lines on the written ones."""
    meters = {meter for _, meter in parsed["meters"]} or {"4/4"}
    if len(meters) > 1 and not transcribed:
        raise ScoreError(f"This score changes time signature ({', '.join(sorted(meters))}); only one meter is supported")
    # A transcription's bar lengths are estimates, so its score uses the meter that covers most of it.
    written = dominant_meter(parsed["meters"], max(n["beat"] + n["length"] for n in parsed["notes"])) if len(meters) > 1 else meters.pop()
    if not transcribed:
        if written not in METERS:
            raise ScoreError(f"{written} time is not supported yet")
        bar = Fraction(written) * 4
        # A short first measure is a pickup; shifting it keeps later barlines on the written beats.
        return parsed, written, (bar - parsed["pickup"]) % bar if parsed["pickup"] else 0
    # A transcription's meter is the model's choice, so an unsupported one is drawn as a supported meter of equal bars.
    meter = written if written in METERS else same_length_meter(written)
    # Scaling every note value and the tempo together writes the same performance in values the score can draw.
    scale = note_value_scale(parsed, meter.endswith("/8"))
    parsed = {**parsed, "bpm": round(clamp_tempo(parsed["bpm"] * scale)), "measures": [start * scale for start in parsed["measures"]],
              "meters": [(start * scale, other) for start, other in parsed["meters"]],
              "notes": [{**note, "beat": note["beat"] * scale, "length": note["length"] * scale} for note in parsed["notes"]]}
    meter = pulse_meter(parsed, meter)
    return parsed, meter, bar_shift(parsed["measures"], float(Fraction(meter) * 4))


def pulse_meter(parsed, meter):
    """3/4 or 6/8 (and 12/8 or 3/4) for bars of three (six) quarters. The model writes only bar lengths, and its
    detokenizer names them 3/4 and 12/8, so the onsets decide: on the dotted-quarter pulse, or on the quarter pulse."""
    if meter not in COMPOUND_CHOICES:
        return meter
    bar = float(Fraction(meter) * 4)
    shift = bar_shift(parsed["measures"], bar)
    positions = Counter(Fraction((note["beat"] + shift) % bar).limit_denominator(48) for note in parsed["notes"] if not note.get("grace"))
    # Beat 1.5 of a three-quarter group is on the compound pulse only; beats 1 and 2 are on the simple pulse only.
    compound = sum(count for position, count in positions.items() if position % Fraction(3, 2) == 0 and position % 1)
    simple = sum(count for position, count in positions.items() if position % 1 == 0 and position % Fraction(3, 2))
    return COMPOUND_CHOICES[meter][compound > simple]


def bar_shift(measures, bar):
    """The shift that puts the most written bar lines on a regular grid of `bar` quarters, so an irregular bar (or a
    pickup) moves the grid for none of the bars around it; ties go to the phase of the earliest bar."""
    phases = [round(start % bar, 6) for start in measures]
    counts = Counter(phases)
    phase = max(counts, key=lambda value: (counts[value], -phases.index(value)))
    return (bar - phase) % bar


def build_song(parsed, title, artist, filename, transcribed=False):
    if not parsed["notes"]:
        raise ScoreError("The file contains no playable notes")
    parsed, meter, shift = bar_layout(parsed, transcribed)
    numerator, denominator = map(int, meter.split("/"))
    bar = numerator * 4 / denominator
    bpm = parsed["bpm"]
    notes = []
    playable = sorted((note for note in parsed["notes"] if 21 <= note["pitch"] <= 108), key=lambda item: (item["beat"], item["pitch"]))
    starts = [(note["beat"] + shift) * TICKS for note in playable]
    grids = beat_grids([tick for note, tick in zip(playable, starts) if not note.get("grace")], denominator == 8)
    for note, raw in zip(playable, starts):
        tick = snap(raw, grids)
        end = max(tick + step(tick, grids), snap(raw + note["length"] * TICKS, grids))
        notes.append({"pitch": note["pitch"], "start": tick / TICKS * 60 / bpm, "duration": (end - tick) / TICKS * 60 / bpm,
                      "velocity": note["velocity"], "staff": note["staff"], "voice": note.get("voice", 0),
                      # Stored on its main note's grid position, so the score stays editable; playback sounds it just before.
                      **({"grace": True} if note.get("grace") else {})})
    if parsed["key"] is not None:
        fifths, mode = parsed["key"]
        if mode is None:
            mode = signature_mode(fifths, notes)
        key = MusicalKey((fifths * 7 + (9 if mode == "minor" else 0)) % 12, "minor" if mode == "minor" else "major").to_dict()
    else:
        key = KeyTracker().observe([Note(pitch=n["pitch"], start=n["start"], duration=n["duration"], velocity=n["velocity"]) for n in notes])
    beats = max(note["start"] + note["duration"] for note in notes) * bpm / 60
    bars = max(1, -int(-round(beats, 6) // bar))
    return {
        "title": title or parsed["title"] or filename.rsplit(".", 1)[0],
        "artist": artist or parsed["composer"],
        "source": filename,
        "bpm": bpm,
        "meter": meter,
        "key": key,
        "bars": bars,
        "notes": notes,
    }


if __name__ == "__main__":
    main()
