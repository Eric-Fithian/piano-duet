from itertools import accumulate, groupby, pairwise, product

from piano_duet.key_tracking import MusicalKey
from piano_duet.reading_stages import STAGES, stage_by_id

# The ways one beat group may be filled; a stage's figure, if any, leads each bar in simple meters.
GROUP_FILLINGS = {1: [(1,), (0.5, 0.5)], 1.5: [(1.5,), (0.5, 0.5, 0.5), (1, 0.5)]}
FIGURES = {
    "eighths": (0.5, 0.5),
    "dotted": (1.5, 0.5),
    "syncopation": (0.5, 1, 0.5),
    "sixteenths": (0.25,) * 4,
    "triplets": (1 / 3,) * 3,
}
# Chord shapes as scale steps above their lowest note, by the texture that uses them.
CHORDS = {
    "dyads": [(0, 2), (0, 4)],
    "triads": [(0, 2, 4), (0, 2, 5), (0, 3, 5)],
    "independent": [(0, 2, 4), (0, 2, 5), (0, 3, 5)],
    "voicings": [(0, 7), (0, 2, 4), (0, 2, 5), (0, 3, 5), (0, 2, 4, 6)],
}
# How much more likely than Aria alone would make it, a main beat becomes a chord. Aria has mostly heard single
# lines here, so on its own it adds a chord note only about 4% of the time; the weight keeps its preference for
# where chords go while making them common, and two-note shapes are the whole point of their stage.
CHORD_BIAS = {"dyads": 14, "triads": 9, "independent": 9, "voicings": 9}
# A stage's rhythmic figure appears this many times in each score, in bars the curriculum picks.
FIGURES_PER_SCORE = 2
# A bar after the first shifts hand position at this rate, beyond the one shift every score has.
SHIFT_RATE = 1 / 3
ATTEMPTS = 100
EPSILON = 1e-9


def main():
    print("Aria writes fresh reading scores inside the current stage's musical constraints.")


def beat_groups(meter):
    numerator, denominator = map(int, meter.split("/"))
    if denominator == 4:
        return [1] * numerator
    if numerator % 3 == 0:
        return [1.5] * (numerator // 3)
    if meter == "7/8":
        return [1, 1, 1.5]
    raise ValueError(f"Reading scores have no beat grouping for {meter}")


def figures(style, meter):
    if any(group != 1 for group in beat_groups(meter)):
        return [()]
    if style == "mixed":
        return list(FIGURES.values())
    return [FIGURES[style]] if style in FIGURES else [()]


def long_rhythms(beats):
    if beats == 0:
        return [[]]
    return [
        [duration, *tail]
        for duration in (1, 2, 4)
        if duration <= beats
        for tail in long_rhythms(beats - duration)
    ]


def bar_rhythms(style, meter, rest_at=None, ending=0, figure=False):
    """Every rhythm one bar may take. Negative values are rests; the last `ending` groups are single notes. A
    figure bar holds the stage's figure once, starting on any beat; other bars use plain quarters and eighths."""
    groups = beat_groups(meter)
    if style == "held":
        return [(sum(groups),)]
    if style == "long":
        if rest_at is not None or ending:
            raise ValueError("Long-note bars have neither rests nor fixed endings")
        return [tuple(rhythm) for rhythm in long_rhythms(sum(groups))]
    starts = list(accumulate(groups, initial=0))

    def slot(index):
        if index >= len(groups) - ending:
            return [(groups[index],)]
        if rest_at is not None and abs(starts[index] - rest_at) < EPSILON:
            return [(-groups[index],)]
        return [(groups[index],)] if style == "quarters" else GROUP_FILLINGS[groups[index]]

    shapes = [shape for shape in figures(style, meter) if shape] if figure else []
    if not shapes:
        return [sum(tail, ()) for tail in product(*(slot(index) for index in range(len(groups))))]
    rhythms = set()
    for shape in shapes:
        for first in range(len(groups)):
            end = starts[first] + sum(shape)
            last = next((i for i, start in enumerate(starts) if abs(start - end) < EPSILON), None)
            if last is None or last > len(groups) - ending:
                continue
            if rest_at is not None and starts[first] - EPSILON < rest_at < end - EPSILON:
                continue
            for head in product(*(slot(index) for index in range(first))):
                for tail in product(*(slot(index) for index in range(last, len(groups)))):
                    rhythms.add(sum(head, ()) + shape + sum(tail, ()))
    return sorted(rhythms)


def rest_positions(style, meter, ending):
    if style in ("held", "long"):
        return []
    groups = beat_groups(meter)
    starts = list(accumulate(groups, initial=0))[:-1]
    return [start for index, start in enumerate(starts) if index and index < len(groups) - 1 - ending]


def next_values(rhythms, prefix):
    depth = len(prefix)
    return sorted({rhythm[depth] for rhythm in rhythms if len(rhythm) > depth and rhythm[:depth] == prefix})


def varied_options(options, history, avoid=()):
    """Avoid repetition whenever the hand position allows: first three in a row, then swinging between two notes."""

    def triple(pitch):
        return history[-2:] == [pitch, pitch] or pitch in avoid

    def swing(pitch):
        return len(history) >= 4 and pitch == history[-2] == history[-4] != history[-1] == history[-3]

    return (
        {p: value for p, value in options.items() if not triple(p) and not swing(p)}
        or {p: value for p, value in options.items() if not triple(p)}
        or options
    )


def degree(scale, pitch):
    """A pitch's step in the scale; a chromatic note counts as the scale note it raises, or else lowers."""
    if pitch in scale:
        return scale.index(pitch)
    return scale.index(pitch - 1) if pitch - 1 in scale else scale.index(pitch + 1)


def pitch_need(hand, pitch, landing=False):
    stats = hand["starting_pitches" if landing else "pitches"].get(str(pitch))
    accuracy = stats["accuracy"] if stats and stats["accuracy"] is not None else 0
    samples = stats["samples"] if stats else 0
    if landing:
        samples = next(
            (row["samples"] for row in hand["fluency"]["landings"] if row["pitch"] == pitch), 0
        )
    return 1 + (100 - accuracy) / 20 + 4 / (1 + samples)


def movement_need(hand, first, second):
    stats = hand["movements"].get(str(second - first))
    accuracy = stats["accuracy"] if stats and stats["accuracy"] is not None else 0
    return 1 + (100 - accuracy) / 25


def choose_context(stage, progress, rng):
    contexts = progress["curriculum"]["contexts"]
    single = stage["texture"] in ("single", "dyads")
    clefs = ["treble", "bass"] if single else ["grand"]
    requirements = next(row for row in progress["curriculum"]["path"] if row["id"] == stage["id"])
    unfinished = [group["hand"] for group in requirements["groups"] if not group["ready"]]
    if unfinished:
        clefs = [clef for clef in clefs if clef in unfinished]
    counts = {
        clef: sum(row["samples"] for row in contexts if row["clef"] == clef) for clef in clefs
    }
    clef = rng.choice([name for name in clefs if counts[name] == min(counts.values())])
    keys = [MusicalKey(*key).to_dict() for key in stage["keys"]]
    if stage["id"] in ("first_keys", "minor", "more_keys", "all_keys"):
        unfamiliar = [
            key
            for key in keys
            if key["signature"] not in progress["curriculum"]["demonstrated_keys"]
        ]
        accidentals = {
            key["signature"]: sum(len(name) - 1 for name in key["scale_names"]) for key in keys
        }
        if unfamiliar:
            limit = min(accidentals[key["signature"]] for key in unfamiliar)
            keys = [key for key in keys if accidentals[key["signature"]] <= limit]
    key_counts = {
        key["signature"]: sum(row["samples"] for row in contexts if row["key"] == key["signature"])
        for key in keys
    }
    key = rng.choice(
        [key for key in keys if key_counts[key["signature"]] == min(key_counts.values())]
    )
    meter_counts = {
        meter: sum(row["samples"] for row in contexts if row["meter"] == meter)
        for meter in stage["meters"]
    }
    meter = rng.choice(
        [meter for meter in stage["meters"] if meter_counts[meter] == min(meter_counts.values())]
    )
    return clef, key, meter


def compose_reading(progress, rng, phrase, context=None):
    """The curriculum fixes the key, hand positions, landing notes and rhythm grammar; Aria writes the rest,
    continuing `context`, the score shown just before, when there is one."""
    stage = stage_by_id(progress["curriculum"]["target"])
    clef, key, meter = choose_context(stage, progress, rng)
    for _ in range(ATTEMPTS):
        candidate, lines = write_score(stage, progress, clef, key, meter, rng, phrase(rng, context))
        if varied(stage, candidate, lines, progress["curriculum"]["recent_rhythms"]):
            return candidate
    raise RuntimeError(f"Aria could not write a varied {stage['label']} score")


class Line:
    """One staff's notes in one bar: its hand position, rhythm grammar and what the bar must contain."""

    def __init__(self, staff, melody, scale, pool, anchor, rhythms, endings, cue, finger, history, starts, accidental):
        self.staff = staff
        self.melody = melody
        self.scale = scale
        self.pool = pool
        # The landing note after a shift; None when the hand stays and Aria chooses the bar's first note too.
        self.anchor = anchor
        self.rhythms = rhythms
        self.endings = endings
        self.cue = cue
        self.finger = finger
        self.history = history
        self.starts = starts
        self.accidental = accidental
        self.introduced = self.altered = self.chorded = False
        self.prefix = ()
        self.cursor = 0
        self.pitches = []


def plan_score(stage, active, meter, rng):
    """Which bars shift hand position, carry the stage's figure, or carry an accidental."""
    plays = {staff: [bar for bar in range(stage["bars"])
                     if stage["texture"] != "alternating" or staff == ("treble" if bar % 2 == 0 else "bass")]
             for staff in active}
    shifts = {}
    for staff, bars in plays.items():
        later = bars[1:]
        required = {rng.choice(later)} if later else set()
        shifts[staff] = required | {bar for bar in later if rng.random() < SHIFT_RATE}
    melody = sorted({bar for staff, bars in plays.items() for bar in bars if staff == "treble" or len(active) == 1})
    styled = stage["rhythm"] not in ("quarters", "long") and any(figures(stage["rhythm"], meter))
    figured = set(rng.sample(melody, min(FIGURES_PER_SCORE, len(melody)))) if styled else set()
    altered = set(rng.sample(melody, min(rng.choice([1, 2]), len(melody)))) if stage["chromatic"] >= 2 else set()
    return shifts, figured, altered


def write_score(stage, progress, clef, key, meter, rng, phrase):
    numerator, denominator = map(int, meter.split("/"))
    beats = numerator * 4 / denominator
    bpm = max(60, stage["tempo"] + 12)
    unit = 60 / bpm
    # The bass comes first, as Aria orders the notes of a shared onset from low to high.
    active = [clef] if clef != "grand" else ["bass", "treble"]
    scales, windows = {}, {staff: None for staff in active}
    histories = {staff: [] for staff in active}
    for staff in active:
        low, high = (
            (60, 76 + stage["register"] * 12)
            if staff == "treble"
            else (stage["bass_low"] - stage["register"] * 12, 59)
        )
        scales[staff] = [pitch for pitch in range(low, high + 1) if pitch % 12 in key["pitch_classes"]]
    shifts, figured, altered = plan_score(stage, active, meter, rng)
    notes, cues, lines = [], [], []
    for bar in range(stage["bars"]):
        bar_lines = []
        for staff in active:
            if stage["texture"] == "alternating" and staff != ("treble" if bar % 2 == 0 else "bass"):
                continue
            line = plan_line(
                stage, progress, key, meter, clef, staff, bar, scales[staff], windows[staff], histories[staff], rng,
                shift=windows[staff] is None or bar in shifts[staff], figure=bar in figured, accidental=bar in altered,
            )
            windows[staff] = line.scale.index(line.pool[0])
            bar_lines.append(line)
        write_bar(stage, progress, key, bar, beats, unit, bar_lines, phrase, notes, rng)
        cues += [line.cue for line in bar_lines if line.cue]
        lines += bar_lines
    notes.sort(key=lambda note: (note["start"], note["pitch"]))
    indices = {id(note): index for index, note in enumerate(notes)}
    positions = [
        {
            "index": indices[id(cue["note"])],
            "low": staff_step(cue["low"], key),
            "finger": cue["note"].get("finger"),
            "clef": cue["staff"],
            "hand": "left" if cue["staff"] == "bass" else "right",
        }
        for cue in cues
    ]
    candidate = {
        "target": notes,
        "title": stage["label"],
        "summary": stage["description"],
        "instruction": stage["description"]
        + (
            " Play at your own pace."
            if not stage["rhythm_required"]
            else " Keep the written rhythm; start at a comfortable steady pace."
        ),
        "bpm": bpm,
        "meter": meter,
        "key": key,
        "challenge": min(5, 1 + (stage["number"] - 1) // 5),
        "reason": f"Stage {stage['number']} of {len(STAGES)} · {stage['phase']}. New music, with extra attention to your less practiced notes.",
        "lesson": f"{key['name']} · {meter}. {stage['lesson']}",
        "reading": {
            "stage_id": stage["id"],
            "stage_number": stage["number"],
            "focus": "shifts",
            "label": stage["label"],
            "clef": clef,
            "hand": "both" if clef == "grand" else "left" if clef == "bass" else "right",
            "segments": [position["index"] for position in positions],
            "positions": positions,
            "bars_per_row": 2,
            "vocabulary": sorted({pitch for scale in scales.values() for pitch in scale}),
            "max_step": stage["step"],
            "introduce": None,
            "bars": stage["bars"],
            "rhythm_required": stage["rhythm_required"],
            "minimum_bpm": stage["tempo"],
            "composition": {"method": "aria"},
        },
    }
    return candidate, lines


def plan_line(stage, progress, key, meter, clef, staff, bar, scale, previous, history, rng, shift, figure, accidental):
    melody = staff == "treble" or clef != "grand"
    style = (
        stage["rhythm"]
        if melody or stage["texture"] == "alternating"
        else "eighths"
        if stage["texture"] in ("independent", "voicings")
        else "held"
    )
    span = min(stage["span"], len(scale) - 2)
    cadences = (
        [
            (leading, tonic)
            for leading, tonic in pairwise(scale)
            if leading % 12 == (key["tonic"] + 10) % 12 and tonic % 12 == key["tonic"]
        ]
        if stage["id"] == "minor" and key["mode"] == "minor"
        else []
    )
    endings = [
        i
        for i in range(len(scale) - span)
        if any(scale[i] <= leading < tonic <= scale[i + span] for leading, tonic in cadences)
    ]
    # The hand stays where it was unless this bar shifts, or a cadence needs a position the hand is not in.
    if not shift and cadences and bar % 2 and previous not in endings:
        shift = True
    anchor = None
    if shift:
        windows = {}
        for pitch_index, pitch in enumerate(scale):
            choices = [i for i in range(len(scale) - span) if i <= pitch_index <= i + span]
            if stage["id"] in ("fourths", "fifths"):
                choices = [i for i in choices if max(pitch_index - i, i + span - pitch_index) >= stage["step"]]
            if cadences:
                choices = (
                    [i for i in choices if i in endings]
                    if bar % 2
                    else [i for i in choices if any(0 < abs(i - ending) <= stage["shift"] for ending in endings)]
                )
            if previous is not None:
                choices = [i for i in choices if i != previous and abs(i - previous) <= stage["shift"]]
            if choices:
                windows[pitch] = choices
        if not windows:
            raise ValueError("The reading stage has no playable hand position")
        windows = varied_options(windows, history)
        hand = progress["hands"][staff]
        # Choose the landing pitch before its fingering, so more fingerings give no extra votes.
        anchor = rng.choices(list(windows), weights=[pitch_need(hand, pitch, landing=True) for pitch in windows])[0]
        low = rng.choice(windows[anchor])
    else:
        low = previous
    pool = scale[low : low + span + 1]
    groups = beat_groups(meter)
    starts = list(accumulate(groups, initial=0))
    ending = {}
    if cadences and bar % 2:
        leading, tonic = rng.choice([pair for pair in cadences if pool[0] <= pair[0] < pair[1] <= pool[-1]])
        ending = {starts[-3]: leading + 1, starts[-2]: tonic}
    options = rest_positions(style, meter, len(ending))
    rest_at = rng.choice(options) if options and rng.random() < stage["rest_probability"] else None
    # Figures and accidentals belong to the melody; an accompaniment keeps its own pattern.
    figure, accidental = figure and melody, accidental and melody
    rhythms = bar_rhythms(style, meter, rest_at, len(ending), figure)
    if not rhythms and rest_at is not None:
        rhythms = bar_rhythms(style, meter, None, len(ending), figure)
    if not rhythms:
        raise ValueError(f"No {style} rhythm with its figure fits a bar of {meter}")
    finger = None
    if stage["fingering"] and anchor is not None:
        finger = pool.index(anchor) + 1 if staff == "treble" else len(pool) - pool.index(anchor)
    cue = {"staff": staff, "low": pool[0], "note": None} if anchor is not None else None
    return Line(staff, melody, scale, pool, anchor, rhythms, ending, cue, finger, history, starts, accidental)


def write_bar(stage, progress, key, bar, beats, unit, lines, phrase, notes, rng):
    while True:
        waiting = [line for line in lines if line.cursor < beats - EPSILON]
        if not waiting:
            return
        # Triplet arithmetic leaves tiny differences, so positions compare rounded.
        line = min(waiting, key=lambda item: (round(item.cursor, 6), item.staff != "bass"))
        values = next_values(line.rhythms, line.prefix)
        if values[0] < 0:
            if len(values) > 1:
                raise ValueError("A rest cannot share its position with a note")
            line.prefix += (values[0],)
            line.cursor -= values[0]
            continue
        write_attack(stage, progress, key, bar, beats, unit, line, values, phrase, notes, rng)


def write_attack(stage, progress, key, bar, beats, unit, line, values, phrase, notes, rng):
    scale, pool, hand = line.scale, line.pool, progress["hands"][line.staff]
    index = len(line.pitches)
    onset = (bar * beats + line.cursor) * unit
    on_beat = any(abs(line.cursor - start) < EPSILON for start in line.starts[:-1])
    shapes = CHORDS.get(stage["texture"], []) if line.melody and on_beat else []
    # A bar with no chord yet gets one on its last main beat.
    forced = bool(shapes) and not line.chorded and not remaining_beats(line)
    fixed = next((pitch for start, pitch in line.endings.items() if abs(start - line.cursor) < EPSILON), None)
    room = min(max(shape) for shape in shapes) if forced else 0
    if index == 0 and line.anchor is not None:
        lowest = {line.anchor: 1.0}
    elif fixed is not None:
        lowest = {fixed: 1.0}
    else:
        previous = line.history[-1]
        choices = [p for p in pool if abs(degree(scale, p) - degree(scale, previous)) <= stage["step"]]
        if stage["id"] in ("fourths", "fifths") and not line.introduced:
            choices = introducing(stage["step"], pool, scale, previous if index else None, choices, remaining_attacks(line))
        lowest = {}
        for p in choices:
            # A chord too high for the staff is built from the highest note that leaves it room.
            p = scale[min(scale.index(p), len(scale) - 1 - room)]
            lowest[p] = max(note_weight(hand, previous, p), lowest.get(p, 0))
        if not forced:
            lowest.update(chromatic_options(stage, key, line, lowest, hand, previous))
        lowest = varied_options(lowest, line.history)
        # A bar that must carry an accidental gets it by its last note, or the one before when the last may have to
        # be a chord.
        due = remaining_attacks(line) <= (1 if CHORDS.get(stage["texture"]) and line.melody else 0)
        if line.accidental and not line.altered and due and not forced:
            lowest = {p: weight for p, weight in lowest.items() if p % 12 not in key["pitch_classes"]} or lowest
    durations = {value * unit: value for value in values}
    pitch, seconds = phrase.note(onset, lowest, dict.fromkeys(durations, 1.0))
    value = durations[seconds]
    chord = build_chord(stage, line, pitch, onset, seconds, shapes, forced, phrase, rng)
    for p in chord:
        note = {
            "pitch": p,
            "start": round(onset, 6),
            "duration": round(value * unit, 6),
            "velocity": 76,
            "staff": line.staff,
        }
        if index == 0 and line.finger is not None:
            note["finger"] = line.finger
        if line.cue and line.cue["note"] is None:
            line.cue["note"] = note
        notes.append(note)
    if index:
        line.introduced |= abs(degree(scale, pitch) - degree(scale, line.pitches[-1])) == stage["step"]
    line.altered |= pitch % 12 not in key["pitch_classes"]
    line.chorded |= len(chord) > 1
    line.pitches.append(pitch)
    line.history.append(pitch)
    line.prefix += (value,)
    line.cursor += value


def note_weight(hand, previous, pitch):
    return pitch_need(hand, pitch) * movement_need(hand, previous, pitch) * (0.3 if pitch == previous else 1)


def chromatic_options(stage, key, line, lowest, hand, previous):
    """Accidentals Aria may choose: in minor keys the raised leading note, and in a bar the curriculum gave an
    accidental, any chromatic neighbour until the bar has one."""
    if not stage["chromatic"]:
        return {}
    subtonic = (key["tonic"] + 10) % 12
    options = set()
    if key["mode"] == "minor" and (stage["chromatic"] == 1 or (line.accidental and not line.altered)):
        options |= {p + 1 for p in lowest if p % 12 == subtonic}
    if stage["chromatic"] >= 2 and line.accidental and not line.altered:
        options |= {p + step for p in lowest for step in (-1, 1)
                    if (p + step) % 12 not in key["pitch_classes"] and line.pool[0] <= p + step <= line.pool[-1]}
    return {p: note_weight(hand, previous, p) for p in sorted(options)}


def build_chord(stage, line, pitch, onset, seconds, shapes, forced, phrase, rng):
    """Adds notes above `pitch` while Aria, weighted toward the stage's chords, wants to; a forced chord gets at
    least two notes."""
    chord = [pitch]
    if not shapes or pitch not in line.scale:
        return chord
    scale = line.scale
    base = scale.index(pitch)
    shapes = [shape for shape in shapes if base + max(shape) <= len(scale) - 1 and scale[base + max(shape)] - pitch <= 12]
    bias = CHORD_BIAS[stage["texture"]]
    while True:
        offsets = tuple(scale.index(p) - base for p in chord)
        longer = [shape for shape in shapes if len(shape) > len(offsets) and shape[:len(offsets)] == offsets]
        if not longer:
            return chord
        following = sorted({scale[base + shape[len(offsets)]] for shape in longer})
        complete = offsets in shapes or (len(offsets) == 1 and not forced)
        if complete:
            chance = phrase.chord_chance(following) * bias
            if rng.random() >= chance / (chance + 1 - chance / bias):
                return chord
        chosen, _ = phrase.note(onset, dict.fromkeys(following, 1.0), {seconds: 1.0})
        chord.append(chosen)


def consistent(line):
    depth = len(line.prefix) + 1
    return [rhythm for rhythm in line.rhythms if len(rhythm) >= depth and rhythm[:depth - 1] == line.prefix]


def remaining_attacks(line):
    """The fewest notes that may still follow the one being chosen, over every rhythm the bar can still take."""
    depth = len(line.prefix) + 1
    return min(sum(value > 0 for value in rhythm[depth:]) for rhythm in consistent(line))


def remaining_beats(line):
    """The fewest later notes in the bar that may start on a main beat."""
    depth = len(line.prefix) + 1
    counts = []
    for rhythm in consistent(line):
        position, count = line.cursor + abs(rhythm[depth - 1]), 0
        for value in rhythm[depth:]:
            count += value > 0 and any(abs(position - start) < EPSILON for start in line.starts[:-1])
            position += abs(value)
        counts.append(count)
    return min(counts)


def introducing(step, pool, scale, previous, choices, remaining):
    """Keeps the stage's interval possible somewhere in the bar: a note that may be the bar's last must make the
    interval itself, and any other note must leave the interval within reach of the hand position. The move into
    a bar's first note (`previous` None) belongs to the bar before."""
    exact = [p for p in choices if previous is not None and abs(degree(scale, p) - degree(scale, previous)) == step]
    if not remaining:
        return exact
    reachable = [p for p in choices if any(abs(degree(scale, q) - degree(scale, p)) == step for q in pool)]
    return sorted(set(exact) | set(reachable))


def varied(stage, candidate, lines, recent):
    """Reject scores that drone on a few notes or repeat a recent long-note rhythm."""
    for staff in {line.staff for line in lines}:
        melody = [p for line in lines if line.staff == staff for p in line.pitches]
        if len(melody) >= 6 and len(set(melody)) < 3:
            return False
    if stage["rhythm"] != "long":
        return True
    bpm = candidate["bpm"]
    pattern = [
        [round(note["start"] * bpm / 60, 4), round(note["duration"] * bpm / 60, 4)]
        for note in candidate["target"]
    ]
    intervals = sum(len(line.pitches) - 1 for line in lines)
    return pattern not in recent and intervals >= 2 and len({duration for _, duration in pattern}) >= 2


def staff_step(pitch, key):
    name = key["scale_names"][key["pitch_classes"].index(pitch % 12)]
    natural = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[name[0]]
    alteration = name.count("#") - name.count("b")
    octave = (pitch - natural - alteration) // 12
    return octave * 7 + "CDEFGAB".index(name[0]) - 12


def reading_attacks(target):
    return [
        {"start": start, "indices": [index for index, _ in group]}
        for start, items in groupby(enumerate(target), key=lambda item: item[1]["start"])
        for group in [list(items)]
    ]


if __name__ == "__main__":
    main()
