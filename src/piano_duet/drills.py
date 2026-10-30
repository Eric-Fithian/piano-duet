import json
import time
from collections import defaultdict
from itertools import pairwise
from math import exp
from statistics import median
from uuid import uuid4

from piano_duet.assessment import pitch_name
from piano_duet.key_tracking import TONICS, MusicalKey
from piano_duet.learning import compare_performance
from piano_duet.notes import Note
from piano_duet.practice import KEY_ORDER
from piano_duet.profile import ASSESSMENT_VERSION, SKILLS

SCALES = {
    "major": ((0, 2, 4, 5, 7, 9, 11), (0, 2, 4, 5, 7, 9, 11)),
    "natural minor": ((0, 2, 3, 5, 7, 8, 10), (0, 2, 3, 5, 7, 8, 10)),
    "harmonic minor": ((0, 2, 3, 5, 7, 8, 11), (0, 2, 3, 5, 7, 8, 11)),
    # Melodic minor raises the sixth and seventh going up and descends as natural minor.
    "melodic minor": ((0, 2, 3, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10)),
}
# Fingers per scale degree mid-scale, then the bottom and top tonic: the standard major tables.
RIGHT_MAJOR = {
    **{tonic: ((1, 2, 3, 1, 2, 3, 4), 1, 5) for tonic in (0, 2, 4, 7, 9, 11)},
    5: ((1, 2, 3, 4, 1, 2, 3), 1, 4),
    10: ((4, 1, 2, 3, 1, 2, 3), 2, 4),
    3: ((3, 1, 2, 3, 4, 1, 2), 3, 3),
    8: ((3, 4, 1, 2, 3, 1, 2), 3, 3),
    1: ((2, 3, 1, 2, 3, 4, 1), 2, 2),
    6: ((2, 3, 4, 1, 2, 3, 1), 2, 2),
}
LEFT_MAJOR = {
    **{tonic: ((1, 4, 3, 2, 1, 3, 2), 5, 1) for tonic in (0, 2, 4, 5, 7, 9)},
    11: ((1, 3, 2, 1, 4, 3, 2), 4, 1),
    **{tonic: ((3, 2, 1, 4, 3, 2, 1), 3, 3) for tonic in (1, 3, 8, 10)},
    6: ((4, 3, 2, 1, 3, 2, 1), 4, 4),
}
# Minor scales on white-key tonics keep the major fingering of the same tonic. Black-key
# minor fingerings vary between editions, so those scales are shown without numbers.
WHITE_TONICS = (0, 2, 4, 5, 7, 9, 11)
FINGERING = {
    ("right", "major"): RIGHT_MAJOR,
    ("left", "major"): LEFT_MAJOR,
    **{
        (hand, variant): {tonic: table[tonic] for tonic in WHITE_TONICS}
        for hand, table in (("right", RIGHT_MAJOR), ("left", LEFT_MAJOR))
        for variant in ("natural minor", "harmonic minor", "melodic minor")
    },
}
TRIADS = {"major": (0, 4, 7), "minor": (0, 3, 7)}
INVERSIONS = ("Root position", "First inversion", "Second inversion")
CHORD_FINGERS = {
    "right": ((1, 3, 5), (1, 2, 5), (1, 3, 5)),
    "left": ((5, 3, 1), (5, 3, 1), (5, 2, 1)),
}
HANDS = {
    "right": "Right hand",
    "left": "Left hand",
    "together": "Hands together",
    "contrary": "Contrary motion",
    "third": "A third apart",
    "sixth": "A sixth apart",
}
PRACTICES = {
    "even": "Even notes",
    "long-short": "Dotted long–short",
    "short-long": "Dotted short–long",
    "accent-3": "Accent every 3rd note",
    "accent-4": "Accent every 4th note",
}
SUBDIVISIONS = {1: "quarter notes", 2: "eighth notes", 3: "triplets", 4: "sixteenth notes"}
METRONOME = (40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 63, 66, 69, 72, 76, 80, 84, 88, 92, 96, 100,
             104, 108, 112, 116, 120, 126, 132, 138, 144)
# Pitch and evenness allow a misheard note or two. Tempo is the player's own: a clean take keeps it
# steady, drifting at most `drift` percent between its first and last thirds. Changes below about 5%
# are hard to hear.
CLEAN = {"pitch": 90, "evenness": 80, "drift": 8}
# Each gap is judged against the median tempo of this many gaps either side of it.
LOCAL = 4
ACCENT_MARGIN = 8
# Consistency before speed: three clean takes in a row earn a steady tempo.
STREAK = 3
# Keys (variant and tonic) needed at each of the ten levels, at an evenly rising share of the tempo ladder.
LEVEL_KEYS = (1, 2, 3, 4, 6, 8, 10, 12, 16, 20)
TOGETHER = ("together", "contrary", "third", "sixth")
CONFIG = ("drill", "variant", "tonic", "hands", "octaves", "inversion")
# Tempo milestones are RCM Certificate Program 2022 minimums (piano syllabus, technical requirements).
DRILLS = {
    "five_finger": {
        "group": "Scales",
        "name": "Five-finger pattern",
        "level": 1,
        "variants": ("major", "natural minor"),
        "hands": ("right", "left", "together", "contrary"),
        "octaves": (1,),
        "practices": ("even", "long-short", "short-long", "accent-4"),
        "ladder": ((1, 60, 116), (2, 60, 116)),
        "start": (1, 60),
        "milestones": ((1, 100, "RCM Preparatory A"),),
        "summary": "Tonic to dominant and back under one hand position: even fingers before any thumb crossing.",
        "tip": "Keep the hand still and let each finger drop from the knuckle. Listen for five equal sounds; the fourth and fifth fingers usually come out weaker.",
    },
    "scale": {
        "group": "Scales",
        "name": "Scale",
        "level": 1,
        "variants": ("major", "natural minor", "harmonic minor", "melodic minor"),
        "hands": ("right", "left", "together", "contrary", "third", "sixth"),
        "octaves": (1, 2, 3, 4),
        "practices": tuple(PRACTICES),
        "ladder": ((1, 60, 116), (2, 60, 116), (4, 60, 120)),
        "start": (2, 60),
        "milestones": (
            (2, 60, "RCM Preparatory B"), (2, 69, "RCM Level 1"), (2, 80, "RCM Level 2"),
            (2, 92, "RCM Level 4"), (2, 104, "RCM Level 5"), (4, 60, "RCM Level 6"),
            (4, 76, "RCM Level 7"), (4, 88, "RCM Level 8"), (4, 104, "RCM Level 9"),
            (4, 120, "RCM Level 10"),
        ),
        "summary": "Required by every exam board: smooth thumb crossings, an even sound, and the geography of each key.",
        "tip": "Move the thumb under early, while the previous note is still sounding, so the crossing makes no bump. Keep the wrist level and let the arm glide sideways.",
    },
    "chromatic": {
        "group": "Scales",
        "name": "Chromatic scale",
        "level": 2,
        "variants": ("chromatic",),
        "hands": ("right", "left", "together", "contrary"),
        "octaves": (1, 2, 3, 4),
        "practices": tuple(PRACTICES),
        "ladder": ((1, 60, 116), (2, 60, 116), (4, 60, 120)),
        "start": (2, 60),
        "milestones": ((2, 104, "RCM Level 4"),),
        "summary": "Every semitone: 3 on the black keys and the thumb on the white, with 2 where two white keys meet.",
        "tip": "Keep the hand compact and close to the black keys so the thumb barely moves. Aim for a seamless line with no accent when the thumb plays.",
    },
    "arpeggio": {
        "group": "Arpeggios",
        "name": "Arpeggio",
        "level": 2,
        "variants": ("major", "minor"),
        "hands": ("right", "left", "together"),
        "octaves": (1, 2, 3, 4),
        "inversions": INVERSIONS,
        "practices": tuple(PRACTICES),
        "ladder": ((2, 50, 116), (4, 60, 100)),
        "start": (2, 60),
        "milestones": (
            (2, 72, "RCM Level 4"), (2, 80, "RCM Level 5"), (2, 92, "RCM Level 6"),
            (4, 60, "RCM Level 7"), (4, 69, "RCM Level 8"), (4, 84, "RCM Level 9"),
            (4, 92, "RCM Level 10"),
        ),
        "summary": "The triad spread across octaves: thumb passage over wide stretches and a supple, travelling wrist.",
        "tip": "Lead with the arm and let the elbow move the hand to each new position; the thumb tucks under in one smooth motion rather than a reach.",
    },
    "seventh_arpeggio": {
        "group": "Arpeggios",
        "name": "Seventh arpeggio",
        "level": 3,
        "variants": ("dominant 7th", "diminished 7th"),
        "hands": ("right", "left", "together"),
        "octaves": (1, 2, 3, 4),
        "practices": tuple(PRACTICES),
        "ladder": ((2, 50, 116), (4, 60, 100)),
        "start": (2, 60),
        "milestones": ((2, 88, "RCM Level 6"),),
        "summary": "Four-note arpeggios, as ABRSM, Trinity and RCM require from their middle grades: the dominant seventh of a key, or the diminished seventh on a note.",
        "tip": "Four notes per octave fit four fingers, so the hand shifts once per octave. Group the notes in fours and move to each new position as a single gesture.",
    },
    "broken_chord": {
        "group": "Chords",
        "name": "Broken chord",
        "level": 1,
        "variants": ("major", "minor"),
        "hands": ("right", "left", "together"),
        "octaves": (1,),
        "practices": ("even", "accent-3"),
        "ladder": ((3, 40, 116),),
        "start": (3, 50),
        "milestones": ((3, 50, "RCM Level 1"), (3, 60, "RCM Level 2"), (3, 69, "RCM Level 3")),
        "summary": "The tonic triad broken in triplets through root position, first and second inversion to the octave, then back down through the same positions.",
        "tip": "Shape the hand to each inversion before it starts, then just drop the fingers. The finger that plays the middle note changes between 2 and 3.",
    },
    "block_chord": {
        "group": "Chords",
        "name": "Chord inversions",
        "level": 1,
        "variants": ("major", "minor"),
        "hands": ("right", "left", "together"),
        "octaves": (1,),
        "practices": ("even",),
        "ladder": ((1, 50, 132),),
        "start": (1, 60),
        "milestones": ((1, 100, "RCM Level 1"), (1, 112, "RCM Level 2"), (1, 120, "RCM Level 3")),
        "summary": "Solid triads in root position, first and second inversion, up an octave and back: every note of a chord lands together.",
        "tip": "Look at the shape, not the notes: each inversion moves the bottom note to the top. Drop with the arm so all three notes sound as one.",
    },
    "cadence": {
        "group": "Chords",
        "name": "Cadence I–IV–V⁷–I",
        "level": 2,
        "variants": ("major", "minor"),
        "hands": ("together",),
        "octaves": (1,),
        "inversions": INVERSIONS,
        "practices": ("even",),
        "ladder": ((1, 50, 120),),
        "start": (1, 60),
        "milestones": (),
        "summary": "The progression underneath most tonal music. The bass plays the roots; the right hand moves each voice to its nearest note.",
        "tip": "Keep common tones held in the same finger and move the other voices by step. In minor, the dominant uses the raised leading note of the harmonic minor.",
    },
    "hanon": {
        "group": "Patterns",
        "name": "Hanon No. 1",
        "level": 2,
        "variants": ("major",),
        "hands": ("right", "left", "together"),
        "octaves": (1, 2),
        "practices": ("even", "long-short", "short-long", "accent-4"),
        "ladder": ((2, 60, 116), (4, 60, 108)),
        "start": (2, 60),
        "milestones": ((4, 60, "Hanon's starting mark"), (4, 108, "Hanon's goal")),
        "summary": "Exercise 1 of The Virtuoso Pianist: an eight-note figure climbing the keyboard and back, to strengthen fingers 3, 4 and 5.",
        "tip": "Hanon asks for fingers lifted high and precise, with the hand quiet. Stop if anything tightens; evenness matters more than speed.",
    },
}
GROUPS = ("Scales", "Arpeggios", "Chords", "Patterns")
GROUP_SKILLS = {
    "Scales": "technique.scales",
    "Arpeggios": "technique.arpeggios",
    "Chords": "technique.chords",
    "Patterns": "technique.patterns",
}


def main():
    print(json.dumps(catalog(), indent=2, ensure_ascii=False))


def ladder(drill):
    return [
        (per_beat, bpm)
        for per_beat, low, high in DRILLS[drill]["ladder"]
        for bpm in METRONOME
        if low <= bpm <= high
    ]


def rung_of(drill, per_beat, bpm):
    rungs = ladder(drill)
    if (per_beat, bpm) not in rungs:
        raise ValueError(f"{per_beat} notes per beat at {bpm} BPM is not on the {drill} ladder")
    return rungs.index((per_beat, bpm))


def milestone(drill, rung):
    per_beat, bpm = ladder(drill)[rung]
    reached = [label for p, b, label in DRILLS[drill]["milestones"] if per_beat * bpm >= p * b]
    upcoming = [
        {"label": label, "per_beat": p, "bpm": b}
        for p, b, label in DRILLS[drill]["milestones"]
        if per_beat * bpm < p * b
    ]
    return {"reached": reached[-1] if reached else None, "next": upcoming[0] if upcoming else None}


def catalog():
    return {
        "groups": list(GROUPS),
        "hands": HANDS,
        "practices": PRACTICES,
        "inversions": list(INVERSIONS),
        "subdivisions": SUBDIVISIONS,
        "tonics": {mode: list(names) for mode, names in TONICS.items()},
        "drills": {
            drill: {
                "group": spec["group"],
                "name": spec["name"],
                "level": spec["level"],
                "variants": list(spec["variants"]),
                "hands": list(spec["hands"]),
                "octaves": list(spec["octaves"]),
                "inversions": len(spec.get("inversions", ())),
                "practices": list(spec["practices"]),
                "summary": spec["summary"],
                "ladder": [{"per_beat": p, "bpm": b} for p, b in ladder(drill)],
                "start": rung_of(drill, *spec["start"]),
            }
            for drill, spec in DRILLS.items()
        },
    }


def validate(config):
    spec = DRILLS.get(config["drill"])
    if spec is None:
        raise ValueError("Unknown drill")
    if config["variant"] not in spec["variants"]:
        raise ValueError(f"{spec['name']} has no {config['variant']} form")
    if not 0 <= config["tonic"] < 12:
        raise ValueError("The tonic must be a pitch class from 0 to 11")
    if config["hands"] not in spec["hands"]:
        raise ValueError(f"{spec['name']} is not drilled {HANDS[config['hands']].lower()}")
    if config["octaves"] not in spec["octaves"]:
        raise ValueError(f"{spec['name']} does not span {config['octaves']} octaves")
    if not 0 <= config["inversion"] < max(1, len(spec.get("inversions", ()))):
        raise ValueError(f"{spec['name']} has no such starting position")
    if config["hands"] == "contrary" and config["variant"] == "melodic minor":
        raise ValueError("Melodic minor differs going up and down, so it is not played in contrary motion")
    if config["hands"] == "contrary" and config["octaves"] > 2:
        raise ValueError("Contrary motion spans at most two octaves, as in the ABRSM syllabus")
    if config["practice"] not in spec["practices"]:
        raise ValueError(f"{spec['name']} is not practised with {PRACTICES[config['practice']].lower()}")


def config_key(config):
    return "|".join(str(config[field]) for field in CONFIG)


def degree(intervals, index):
    return 12 * (index // 7) + intervals[index % 7]


def register(tonic, octaves, hands="right"):
    # The right hand starts near middle C. Wide drills, and two-octave drills with the left hand
    # an octave below, start an octave lower so each hand stays readable on its own staff.
    lower = octaves >= 3 or (octaves == 2 and hands in ("together", "third", "sixth"))
    return 60 + tonic - 12 * lower


def scale_fingers(hand, variant, tonic, pitches):
    table = FINGERING.get((hand, variant), {}).get(tonic)
    if table is None:
        return [None] * len(pitches)
    cycle, bottom, top = table
    up, down = SCALES[variant]
    fingers = []
    for pitch in pitches:
        interval = (pitch - tonic) % 12
        step = up.index(interval) if interval in up else down.index(interval)
        if step == 0 and pitch == min(pitches):
            fingers.append(bottom)
        elif step == 0 and pitch == max(pitches):
            fingers.append(top)
        else:
            fingers.append(cycle[step])
    return fingers


def chromatic_fingers(hand, pitches):
    # Black keys take 3; the thumb takes white keys, except 2 where two white keys meet.
    paired = (5, 0) if hand == "right" else (4, 11)
    fingers = [
        3 if pitch % 12 in (1, 3, 6, 8, 10) else 2 if pitch % 12 in paired else 1
        for pitch in pitches
    ]
    if pitches[0] % 12 in paired:
        fingers[0] = 1
    return fingers


def line(pitches, hand, fingers=None):
    fingers = fingers or [None] * len(pitches)
    return [[(pitch, hand, finger)] for pitch, finger in zip(pitches, fingers, strict=True)]


def merge(*voices):
    if len({len(voice) for voice in voices}) != 1:
        raise ValueError("Both hands must play the same number of attacks")
    return [[note for voice in group for note in voice] for group in zip(*voices, strict=True)]


def there_and_back(ascending):
    return ascending + ascending[-2::-1]


def scale_line(start, variant, octaves, offset=0):
    up, down = SCALES[variant]
    ascending = [start + degree(up, i) - degree(up, offset) for i in range(offset, offset + 7 * octaves + 1)]
    descending = [
        start + degree(down, i) - degree(up, offset) for i in reversed(range(offset, offset + 7 * octaves))
    ]
    return ascending + descending


def scale_events(variant, tonic, hands, octaves):
    base = register(tonic, octaves, hands)
    third = SCALES[variant][0][2]

    def voice(hand, pitches):
        return line(pitches, hand, scale_fingers(hand, variant, tonic, pitches))

    if hands == "right":
        return voice("right", scale_line(base, variant, octaves))
    if hands == "left":
        return voice("left", scale_line(base - (24 if octaves == 2 else 12), variant, octaves))
    if hands == "contrary":
        up = SCALES[variant][0]
        left = there_and_back([base + degree(up, -step) for step in range(7 * octaves + 1)])
        return merge(voice("right", scale_line(base, variant, octaves)), voice("left", left))
    if hands == "together":
        right = scale_line(base, variant, octaves)
        left = [pitch - 12 for pitch in right]
    elif hands == "third":
        # The tonic is the lower note; the right hand plays an octave higher so the hands never collide.
        left = scale_line(base - 12, variant, octaves)
        right = scale_line(base + third, variant, octaves, 2)
    else:
        # The tonic is the upper note; the left hand starts on the third, a sixth below.
        right = scale_line(base, variant, octaves)
        left = scale_line(base - 12 + third, variant, octaves, 2)
    return merge(voice("right", right), voice("left", left))


def five_finger_events(variant, tonic, hands):
    up = SCALES[variant][0]
    base = register(tonic, 1)
    steps = [0, 1, 2, 3, 4, 3, 2, 1, 0]
    right = line([base + up[step] for step in steps], "right", [step + 1 for step in steps])
    lower = line([base - 12 + up[step] for step in steps], "left", [5 - step for step in steps])
    if hands == "right":
        return right
    if hands == "left":
        return lower
    if hands == "together":
        return merge(right, lower)
    # Both thumbs share the tonic, as in the middle C position of beginner methods.
    mirror = line([base + degree(up, -step) for step in steps], "left", [step + 1 for step in steps])
    return merge(right, mirror)


def chromatic_events(tonic, hands, octaves):
    base = register(tonic, octaves, hands)
    right = there_and_back([base + step for step in range(12 * octaves + 1)])
    left = [pitch - 12 for pitch in right]
    if hands == "contrary":
        left = [2 * base - pitch for pitch in right]
    if hands == "right":
        return line(right, "right", chromatic_fingers("right", right))
    if hands == "left":
        return line(left, "left", chromatic_fingers("left", left))
    return merge(
        line(right, "right", chromatic_fingers("right", right)),
        line(left, "left", chromatic_fingers("left", left)),
    )


def arpeggio_events(chord, base, hands, octaves, inversion):
    size = len(chord)
    right = there_and_back(
        [base + 12 * (i // size) + chord[i % size] for i in range(inversion, inversion + size * octaves + 1)]
    )
    voices = []
    if hands in ("right", "together"):
        voices.append(line(right, "right"))
    if hands in ("left", "together"):
        voices.append(line([pitch - 12 for pitch in right], "left"))
    return merge(*voices)


def triad_positions(base, triad):
    root = [base + interval for interval in triad]
    return [
        root,
        [root[1], root[2], root[0] + 12],
        [root[2], root[0] + 12, root[1] + 12],
        [pitch + 12 for pitch in root],
    ]


def chord_event(pitches, shape, hands, order=None):
    order = order or range(3)
    event = []
    for hand, shift in (("right", 0), ("left", -12)):
        if hands in (hand, "together"):
            event += [(pitches[i] + shift, hand, CHORD_FINGERS[hand][shape][i]) for i in order]
    return event


def broken_chord_events(triad, tonic, hands):
    positions = triad_positions(register(tonic, 1), triad)
    shapes = (0, 1, 2, 0)
    events = []
    for index in (0, 1, 2, 3):
        events += [chord_event(positions[index], shapes[index], hands, [i]) for i in range(3)]
    # Back down through the same positions, turning within the top one so the hand stays still at the
    # peak. The solid chord is the separate inversions drill.
    for index in (3, 2, 1, 0):
        events += [chord_event(positions[index], shapes[index], hands, [i]) for i in (2, 1, 0)]
    return events


def block_chord_events(triad, tonic, hands):
    positions = triad_positions(register(tonic, 1), triad)
    shapes = (0, 1, 2, 0)
    return [chord_event(positions[index], shapes[index], hands) for index in (0, 1, 2, 3, 2, 1, 0)]


def voice_lead(previous, pitch_classes):
    best = None
    for low in range(previous[0] - 7, previous[0] + 8):
        for middle in range(low + 1, low + 12):
            for high in range(middle + 1, low + 13):
                chord = (low, middle, high)
                if sorted(pitch % 12 for pitch in chord) != sorted(pitch_classes):
                    continue
                cost = sum(abs(a - b) for a, b in zip(chord, previous, strict=True))
                if best is None or cost < best[0]:
                    best = (cost, list(chord))
    if best is None:
        raise ValueError("No close voicing exists for this cadence chord")
    return best[1]


def cadence_events(variant, tonic, inversion):
    base = register(tonic, 1)
    third = TRIADS[variant][1]
    home = triad_positions(base, TRIADS[variant])[inversion]
    progression = (
        (0, None),
        (5, (0, third, 7)),
        # The dominant seventh omits its fifth so the right hand keeps three notes.
        (7, (0, 4, 10)),
        (0, None),
    )
    events = []
    voicing = home
    bass = base - 12
    for root, chord in progression:
        voicing = home if chord is None else voice_lead(voicing, [(tonic + root + i) % 12 for i in chord])
        bass = min(
            (pitch for pitch in range(base - 19, base - 3) if pitch % 12 == (tonic + root) % 12),
            key=lambda pitch: abs(pitch - bass),
        )
        events.append([(bass, "left", None), *((pitch, "right", None) for pitch in voicing)])
    return events


def hanon_events(tonic, hands, octaves):
    up = SCALES["major"][0]
    base = register(tonic, 1) - 12 * (octaves - 1)
    groups = 7 * octaves
    rising = (0, 2, 3, 4, 5, 4, 3, 2)
    top = groups - 1 + 5
    steps = [start + step for start in range(groups) for step in rising]
    steps += [top - start - step for start in range(groups) for step in rising] + [0]
    # Descending mirrors the figure, so each hand reverses its fingering.
    fingers = {
        "right": [1, 2, 3, 4, 5, 4, 3, 2] * groups + [5, 4, 3, 2, 1, 2, 3, 4] * groups + [1],
        "left": [5, 4, 3, 2, 1, 2, 3, 4] * groups + [1, 2, 3, 4, 5, 4, 3, 2] * groups + [5],
    }
    voices = []
    for hand, shift in (("right", 0), ("left", -12)):
        if hands in (hand, "together"):
            voices.append(line([base + shift + degree(up, step) for step in steps], hand, fingers[hand]))
    return merge(*voices)


def drill_events(config):
    drill, variant, tonic = config["drill"], config["variant"], config["tonic"]
    hands, octaves, inversion = config["hands"], config["octaves"], config["inversion"]
    if drill == "five_finger":
        return five_finger_events(variant, tonic, hands)
    if drill == "scale":
        return scale_events(variant, tonic, hands, octaves)
    if drill == "chromatic":
        return chromatic_events(tonic, hands, octaves)
    if drill == "arpeggio":
        return arpeggio_events(TRIADS[variant], register(tonic, octaves, hands), hands, octaves, inversion)
    if drill == "seventh_arpeggio":
        if variant == "dominant 7th":
            root = (tonic + 7) % 12
            return arpeggio_events((0, 4, 7, 10), register(root, octaves, hands), hands, octaves, 0)
        return arpeggio_events((0, 3, 6, 9), register(tonic, octaves, hands), hands, octaves, 0)
    if drill == "broken_chord":
        return broken_chord_events(TRIADS[variant], tonic, hands)
    if drill == "block_chord":
        return block_chord_events(TRIADS[variant], tonic, hands)
    if drill == "cadence":
        return cadence_events(variant, tonic, inversion)
    return hanon_events(tonic, hands, octaves)


def staff(pitch, hand):
    # Each hand keeps its own staff up to about four ledger lines, so a line reads as one hand.
    if hand == "right":
        return "treble" if pitch >= 50 else "bass"
    return "bass" if pitch <= 71 else "treble"


def render(events, bpm, per_beat, practice):
    """Each event's `step` is its place in the drill; dotted rhythm and accents follow it."""
    accent = {"accent-3": 3, "accent-4": 4}.get(practice)
    dotted = {"long-short": (1.5, 0.5), "short-long": (0.5, 1.5)}.get(practice)
    starts = [0.0]
    for step in range(len(events) - 1):
        starts.append(starts[-1] + (dotted[step % 2] if dotted else 1.0))
    # The final note holds to the end of its 4/4 bar.
    bar = 4 * per_beat
    ends = starts[1:] + [-(-(starts[-1] + 1) // bar) * bar]
    notes = []
    for step, (event, start, end) in enumerate(zip(events, starts, ends, strict=True)):
        accented = accent is not None and step % accent == 0
        for pitch, hand, finger in event:
            notes.append(
                {
                    "pitch": pitch,
                    "start": round(start / per_beat * 60 / bpm, 6),
                    "duration": round((end - start) / per_beat * 60 / bpm, 6),
                    "velocity": 76 if accent is None else 100 if accented else 60,
                    "hand": hand,
                    "staff": staff(pitch, hand),
                    "step": step,
                    **({"finger": finger} if finger else {}),
                    **({"accent": True} if accented else {}),
                }
            )
    return notes


def key_for(config):
    variant = config["variant"]
    if config["drill"] == "seventh_arpeggio":
        return MusicalKey(config["tonic"], "major" if variant == "dominant 7th" else "minor")
    return MusicalKey(config["tonic"], "minor" if "minor" in variant else "major")


def title(config, key):
    spec = DRILLS[config["drill"]]
    tonic = key.name.split()[0]
    variant = config["variant"]
    names = {
        "five_finger": f"{tonic} {variant.replace('natural ', '')} five-finger pattern",
        "scale": f"{tonic} {variant} scale",
        "chromatic": f"Chromatic scale from {TONICS['major'][config['tonic']].replace('b', '♭')}",
        "arpeggio": f"{key.name} arpeggio",
        "seventh_arpeggio": (
            f"Dominant 7th of {key.name}" if variant == "dominant 7th" else f"Diminished 7th on {tonic}"
        ),
        "broken_chord": f"{key.name} broken chord",
        "block_chord": f"{key.name} chord inversions",
        "cadence": f"{key.name} cadence",
        "hanon": f"Hanon No. 1 in {key.name}",
    }
    parts = [names[config["drill"]]]
    if spec.get("inversions") and config["inversion"]:
        parts.append(INVERSIONS[config["inversion"]].lower())
    return " · ".join(parts)


def instruction(config, key, per_beat, bpm):
    hands = config["hands"]
    octaves = config["octaves"]
    span = f"{octaves} octave{'s' if octaves > 1 else ''} up and back down"
    tonic = pitch_name(register(config["tonic"], octaves, hands), key.to_dict())
    how = {
        "right": "with the right hand",
        "left": "with the left hand",
        "together": "hands together, an octave apart",
        "contrary": f"in contrary motion, both thumbs starting on {tonic}",
        "third": "hands together a third apart, the right hand starting on the third (a tenth above)",
        "sixth": "hands together a sixth apart, the left hand starting on the third below",
    }[hands]
    shape = {
        "five_finger": "Play five notes up and back",
        "scale": f"Play {span}",
        "chromatic": f"Play every semitone, {span}",
        "arpeggio": f"Play {span}",
        "seventh_arpeggio": f"Play {span}",
        "broken_chord": "Break the triad up through each inversion to the octave, then back down through the same positions",
        "block_chord": "Play the chord solid in each inversion, up an octave and back",
        "cadence": "Play I, IV, V⁷ and I: bass roots in the left hand, chords in the right",
        "hanon": f"Climb the eight-note figure {span}",
    }[config["drill"]]
    text = f"{shape}, in {SUBDIVISIONS[per_beat]} at ♩ = {bpm}." if config["drill"] == "cadence" else (
        f"{shape}, {how}, in {SUBDIVISIONS[per_beat]} at ♩ = {bpm}."
    )
    practice = config["practice"]
    if practice == "even":
        return text + " Every note the same length and loudness."
    if practice in ("long-short", "short-long"):
        pattern = "long–short" if practice == "long-short" else "short–long"
        return text + f" Play each pair {pattern}, a dotted rhythm. Only even playing moves your tempo."
    every = practice[-1]
    return text + f" Accent the first of every {every} notes and keep the others light. Only even playing moves your tempo."


def build_task(config, rung, progress_entry=None):
    validate(config)
    rungs = ladder(config["drill"])
    if not 0 <= rung < len(rungs):
        raise ValueError("That tempo is outside this drill's ladder")
    per_beat, bpm = rungs[rung]
    if config["practice"] in ("long-short", "short-long") and per_beat > 2:
        # Dotted sixteenths fall off the notation grid, so rhythm practice uses eighth notes.
        per_beat = 2
    key = key_for(config)
    target = render(drill_events(config), bpm, per_beat, config["practice"])
    # Of the placements that fit the keyboard, prefer the one where most notes sit on their hand's staff.
    fits = [shift for shift in (0, -12, 12) if all(21 <= n["pitch"] + shift <= 108 for n in target)]
    if not fits:
        raise ValueError("This drill does not fit on the piano keyboard")
    shift = min(fits, key=lambda shift: sum(
        staff(n["pitch"] + shift, n["hand"]) != ("treble" if n["hand"] == "right" else "bass") for n in target
    ))
    for note in target:
        note["pitch"] += shift
        note["staff"] = staff(note["pitch"], note["hand"])
    spec = DRILLS[config["drill"]]
    working = progress_entry["working"] if progress_entry else rung_of(config["drill"], *spec["start"])
    name = title(config, key)
    hands = HANDS[config["hands"]]
    octaves = f"{config['octaves']} octave{'s' if config['octaves'] > 1 else ''}"
    text = instruction(config, key, per_beat, bpm)
    return {
        "id": str(uuid4()),
        "family": "technique",
        "shape": {"Scales": "scale", "Arpeggios": "arpeggio", "Chords": "chord", "Patterns": "pattern"}[spec["group"]],
        "challenge": 1 + round(4 * rung / max(1, len(rungs) - 1)),
        "bpm": bpm,
        "meter": "4/4",
        "key": key.to_dict(),
        "title": name,
        "instruction": text,
        "lesson": spec["tip"],
        "reason": f"{spec['summary']} Play at any tempo you can hold steadily; the suggestion is ♩ = {rungs[working][1]} "
        f"in {SUBDIVISIONS[rungs[working][0]]}. {STREAK} clean, steady takes in a row earn the slowest tempo among them "
        "and raise the suggestion one metronome mark past it; two takes without a clean rep lower it.",
        "purpose": "Drill",
        "cue": f"{hands} · {octaves}" if len(spec["octaves"]) > 1 else hands,
        "even": config["practice"] == "even",
        "dynamics": "even" if config["practice"] == "even" else None,
        "target": target,
        "context": {"notation_visible": True, "hearings": 0, "reveals": 0, "hints": 0, "familiar": False},
        "drill": {
            **{field: config[field] for field in CONFIG},
            "practice": config["practice"],
            "config_key": config_key(config),
            "group": spec["group"],
            "title": f"{name} · {hands}" + (f" · {octaves}" if len(spec["octaves"]) > 1 else ""),
            "per_beat": per_beat,
            "bpm": bpm,
            "rung": rung,
            "rungs": len(rungs),
            "working": working,
            "best": progress_entry["best"] if progress_entry else None,
            "streak": progress_entry["streak"] if progress_entry else 0,
            "streak_needed": STREAK,
            "milestone": milestone(config["drill"], rung),
        },
    }


def drill_progress(attempts):
    """Replay every saved take, rep by rep, so rule changes re-credit practice without rewriting it."""
    progress = {}
    days = set()
    for attempt in attempts:
        if (
            attempt["mode"] != "drills"
            or attempt["excluded"]
            or attempt["context"]["source"] != "microphone"
            or not attempt["notes"]
        ):
            continue
        prompt = attempt["prompt"]
        drill = prompt["drill"]
        notes = [Note.model_validate(note) for note in attempt["notes"]]
        result = assess_drill(prompt, notes, attempt["context"], attempt["recognition"])["drill"]
        spec = DRILLS[drill["drill"]]
        entry = progress.setdefault(
            drill["config_key"],
            {
                "config": {field: drill[field] for field in CONFIG},
                "title": drill["title"],
                "group": spec["group"],
                "working": rung_of(drill["drill"], *spec["start"]),
                "best": None,
                "attempts": 0,
                "clean": 0,
                "run": [],
                "misses": 0,
                "last": None,
            },
        )
        entry["attempts"] += 1
        entry["last"] = attempt["created_at"]
        days.add(time.strftime("%Y-%m-%d", time.localtime(attempt["created_at"])))
        if drill["practice"] != "even" or not result["usable"]:
            continue
        top = len(ladder(drill["drill"])) - 1
        if result["clean"]:
            entry["clean"] += 1
            entry["misses"] = 0
            entry["run"].append(result["credit"])
            if len(entry["run"]) == STREAK:
                # A streak earns the slowest tempo within it, whatever was suggested.
                earned = min(entry["run"])
                entry["best"] = earned if entry["best"] is None else max(entry["best"], earned)
                entry["working"] = max(entry["working"], min(top, earned + 1))
                entry["run"] = []
        else:
            entry["run"] = []
            entry["misses"] += 1
            if entry["misses"] == 2:
                entry["working"] = max(0, entry["working"] - 1)
                entry["misses"] = 0
    for entry in progress.values():
        drill = entry["config"]["drill"]
        rungs = ladder(drill)
        entry["streak"] = len(entry.pop("run"))
        entry["working_tempo"] = dict(zip(("per_beat", "bpm"), rungs[entry["working"]], strict=True))
        entry["best_tempo"] = (
            dict(zip(("per_beat", "bpm"), rungs[entry["best"]], strict=True)) if entry["best"] is not None else None
        )
        entry["goal"] = entry["best"] == len(rungs) - 1
        entry["milestone"] = milestone(drill, entry["best"])["reached"] if entry["best"] is not None else None
    return progress, streak_days(days)


def streak_days(days, today=None):
    day = today or time.strftime("%Y-%m-%d")
    if day not in days:
        day = time.strftime("%Y-%m-%d", time.localtime(time.mktime(time.strptime(day, "%Y-%m-%d")) - 86400))
    count = 0
    while day in days:
        count += 1
        day = time.strftime("%Y-%m-%d", time.localtime(time.mktime(time.strptime(day, "%Y-%m-%d")) - 86400))
    return count


def ladder_share(drill, rung):
    rungs = ladder(drill)
    rate = [per_beat * bpm for per_beat, bpm in rungs]
    start = rate[rung_of(drill, *DRILLS[drill]["start"])]
    # Below the starting tempo the share is negative, so no level is earned there.
    return min(1.0, (rate[rung] - start) / (rate[-1] - start))


def drill_levels(progress):
    """Level L needs LEVEL_KEYS[L-1] keys confirmed (three clean takes in a row) at (L-1)/9 of the
    ladder above the starting tempo; from level 4, with hands together where the drill allows it."""
    levels = {}
    for drill, spec in DRILLS.items():
        entries = [entry for entry in progress.values() if entry["config"]["drill"] == drill]
        possible = 12 * len(spec["variants"])
        together = any(hand in TOGETHER for hand in spec["hands"])
        rungs = ladder(drill)
        level, upcoming = 0, None
        for number, keys in enumerate(LEVEL_KEYS, start=1):
            share = (number - 1) / 9
            hands = number >= 4 and together
            qualified = {
                (entry["config"]["variant"], entry["config"]["tonic"])
                for entry in entries
                if entry["best"] is not None
                and ladder_share(drill, entry["best"]) >= share - 1e-9
                and (not hands or entry["config"]["hands"] in TOGETHER)
            }
            needed = min(keys, possible)
            if len(qualified) < needed:
                rung = next(index for index in range(len(rungs)) if ladder_share(drill, index) >= share - 1e-9)
                upcoming = {
                    "level": number,
                    "keys": needed,
                    "done": len(qualified),
                    "tempo": dict(zip(("per_beat", "bpm"), rungs[rung], strict=True)),
                    "rung": rung,
                    "hands_together": hands,
                }
                break
            level = number
        last = max((entry["last"] for entry in entries), default=None)
        levels[drill] = {"level": level, "next": upcoming, "last": last, "name": spec["name"], "group": spec["group"]}
    return levels


def coach_config(progress, levels, avoid=(), now=None, focus=None):
    """Pick the weakest drill (or `focus`), letting long-unpractised ones rise, then the key that would level it."""
    now = time.time() if now is None else now
    total = sum(level["level"] for level in levels.values())
    # Harder families open as the foundations grow: a heuristic, not an exam grade.
    tier = 1 + (total >= 4) + (total >= 10)
    unlocked = [drill for drill, spec in DRILLS.items() if spec["level"] <= tier]
    pool = [drill for drill in unlocked if drill not in avoid] or unlocked

    def weakness(drill):
        last = levels[drill]["last"]
        idle = 4 if last is None else min(4, (now - last) / 86400)
        return levels[drill]["level"] - 0.25 * idle

    drill = focus or min(pool, key=lambda d: (weakness(d), list(DRILLS).index(d)))
    spec = DRILLS[drill]
    level = levels[drill]["level"]
    goal = levels[drill]["next"] or {"level": 10, "rung": len(ladder(drill)) - 1, "hands_together": False}

    def variant_for(mode):
        if drill == "scale":
            return "major" if mode == "major" else "natural minor" if goal["level"] <= 3 else "harmonic minor"
        if drill == "five_finger":
            return "major" if mode == "major" else "natural minor"
        if drill == "seventh_arpeggio":
            return "dominant 7th" if mode == "major" else "diminished 7th"
        if drill == "chromatic":
            return "chromatic" if mode == "major" else None
        return mode if mode in spec["variants"] else None

    if goal["hands_together"]:
        hands = next(hand for hand in TOGETHER if hand in spec["hands"])
    else:
        single = [hand for hand in ("right", "left") if hand in spec["hands"]] or [spec["hands"][0]]
        practised = defaultdict(int)
        for entry in progress.values():
            if entry["config"]["drill"] == drill:
                practised[entry["config"]["hands"]] += entry["attempts"]
        hands = min(single, key=lambda hand: (practised[hand], single.index(hand)))
    reach = 1 if goal["level"] <= 3 else 2 if goal["level"] <= 6 else 4
    octaves = max(o for o in allowed_octaves(spec, hands) if o <= reach) if any(
        o <= reach for o in allowed_octaves(spec, hands)) else min(spec["octaves"])
    keys = [(tonic, variant_for(mode)) for tonic, mode in KEY_ORDER if variant_for(mode)]
    candidates = [
        {"drill": drill, "variant": variant, "tonic": tonic, "hands": hands, "octaves": octaves,
         "inversion": 0, "practice": "even"}
        for tonic, variant in keys
    ]
    candidates = [c for c in candidates if not (c["hands"] == "contrary" and c["variant"] == "melodic minor")]

    def standing(config):
        entry = progress.get(config_key(config))
        qualified = entry and entry["best"] is not None and entry["best"] >= goal["rung"]
        # Keep working a key already under way before opening a new one.
        return (bool(qualified), -(entry["working"] if entry else -1), candidates.index(config))

    config = min(candidates, key=standing)
    last = levels[drill]["last"]
    why = (
        f"Training {spec['name']} (level {level})"
        if focus
        else f"{spec['name']} is your weakest drill (level {level})"
        if last is not None and now - last < 2 * 86400
        else f"{spec['name']} (level {level}) has not been practised for a while"
        if last is not None
        else f"{spec['name']} has not been tried yet"
    )
    return config, f"{why}. This key is the next step toward level {goal['level']}."


def allowed_octaves(spec, hands):
    return [octaves for octaves in spec["octaves"] if hands != "contrary" or octaves <= 2]


def next_drill(store, request):
    progress, _ = drill_progress(store.attempts())
    reason = None
    if request.get("drill") is None:
        config, reason = coach_config(progress, drill_levels(progress), request.get("avoid") or (), focus=request.get("focus"))
    else:
        config = {field: request[field] for field in (*CONFIG, "practice")}
    validate(config)
    entry = progress.get(config_key(config))
    rung = request.get("rung")
    if rung is None:
        rung = entry["working"] if entry else rung_of(config["drill"], *DRILLS[config["drill"]]["start"])
    task = build_task(config, rung, entry)
    if reason:
        task["reason"] = f"{reason} {task['reason']}"
        task["drill"]["coach"] = reason
    store.add_task(task)
    return task


def naming_key(key):
    if key["mode"] != "minor":
        return key
    pitch_classes, names = list(key["pitch_classes"]), list(key["scale_names"])
    # Harmonic and melodic minor raise the sixth and seventh, spelled on the same letters.
    for step in (5, 6):
        pitch_classes.append((key["pitch_classes"][step] + 1) % 12)
        name = key["scale_names"][step]
        names.append(name[:-1] if name.endswith("b") else name + "#")
    return {**key, "pitch_classes": pitch_classes, "scale_names": names}


def crossing(previous, note):
    # A thumb passes under (or a finger over) when the finger order runs against the pitch direction.
    if not previous.get("finger") or not note.get("finger") or previous["hand"] != note["hand"]:
        return False
    fingers = note["finger"] - previous["finger"]
    pitches = note["pitch"] - previous["pitch"]
    if not fingers or not pitches:
        return False
    return (fingers > 0) != (pitches > 0) if note["hand"] == "right" else (fingers > 0) == (pitches > 0)


def timing_profile(raw, target, notes, matched, alignment, bpm, key):
    """Per-attack timing against the player's own tempo, the take's tempo and drift, and the moments
    worth naming."""
    attacks = []
    used = set(matched.values())
    # Attacks with nothing written for them are kept for the written note or chord that follows.
    inserted = []
    for group in alignment:
        if not group["expected"]:
            inserted.append(sorted({notes[j].pitch for j in group["played"]}))
            continue
        top = max(group["expected"], key=lambda i: target[i].pitch)
        heard = [notes[matched[i]] for i in group["expected"] if i in matched]
        attacks.append({
            "index": top,
            "expected": target[top].start,
            "played": min(n.start for n in heard) if heard else None,
            "velocity": round(median(n.velocity for n in heard)) if heard else None,
            "missed": [target[i].pitch for i in group["expected"] if i not in matched],
            "extra": sorted({notes[j].pitch for j in group["played"] if j not in used}),
            "inserted": inserted,
            "pitches": sorted(target[i].pitch for i in group["expected"]),
            "bar": int(target[top].start * bpm / 60 // 4) + 1,
        })
        inserted = []
    attacks.sort(key=lambda attack: attack["expected"])
    timed = [attack for attack in attacks if attack["played"] is not None]
    names = naming_key(key)
    issues = []
    crossings, others = [], []
    pairs = list(pairwise(timed))
    for a, b in pairs:
        expected, played = b["expected"] - a["expected"], b["played"] - a["played"]
        b["ratio"] = played / expected if expected > 0.07 and played > 0.07 else None
    for index, (a, b) in enumerate(pairs):
        # Judging a gap against its neighbourhood keeps a slow drift from counting as unevenness.
        window = [pair[1]["ratio"] for pair in pairs[max(0, index - LOCAL):index + LOCAL + 1] if pair[1]["ratio"]]
        local = median(window) if window else 1.0
        # The tempo the player held at this note, from it and its neighbours only, so a chart shows where the take
        # sped up or slowed rather than a curve smoothed flat.
        nearby = [pair[1]["ratio"] for pair in pairs[max(0, index - 1):index + 2] if pair[1]["ratio"]]
        b["tempo"] = round(bpm / median(nearby), 1) if nearby else None
        gap = (b["expected"] - a["expected"]) * local
        deviation = (b["played"] - a["played"]) - gap
        b["deviation_ms"] = round(1000 * deviation)
        # Lateness must beat recognition jitter and a fair share of the beat before it counts as a pause.
        if deviation > max(0.12, 0.35 * gap):
            b["flag"] = "late"
        elif deviation < -max(0.08, 0.3 * gap):
            b["flag"] = "early"
        (crossings if crossing(raw[a["index"]], raw[b["index"]]) else others).append(deviation)
    for attack in attacks:
        flag = attack.get("flag")
        # A wrong try before the right chord already explains the delay before it.
        if not flag or (flag == "late" and attack["inserted"]):
            continue
        where = f"{pitch_name(target[attack['index']].pitch, names)} in bar {attack['bar']}"
        size = abs(attack["deviation_ms"])
        text = f"Pause before {where}: {size} ms late" if flag == "late" else f"Rushed into {where}: {size} ms early"
        issues.append((size / 1000, text))
    for attack in attacks:
        for weight, text in describe_slips(attack, names):
            issues.append((weight, f"{text} in bar {attack['bar']}"))
    crossing_ms = None
    if len(crossings) >= 3 and others:
        crossing_ms = round(1000 * (median(crossings) - median(others)))
        if crossing_ms >= 40:
            issues.append((5, f"Thumb crossings ran {crossing_ms} ms late compared with the other notes"))
    issues.sort(key=lambda item: -item[0])
    if len(timed) >= 2:
        timed[0]["tempo"] = timed[1]["tempo"]
    ratios = [b["ratio"] for _, b in pairs if b["ratio"]]
    timeline = [
        {key: attack.get(key) for key in ("index", "bar", "deviation_ms", "flag", "velocity", "tempo")}
        | {"missed": bool(attack["missed"])}
        for attack in attacks
    ]
    return {
        "timeline": timeline,
        "issues": [text for _, text in issues[:5]],
        "crossing_ms": crossing_ms,
        "bpm": round(bpm / median(ratios), 1) if ratios else None,
        "drift_percent": drift([attack.get("ratio") for attack in timed]),
        "pauses": sum(attack.get("flag") == "late" for attack in attacks),
    }


def describe_slips(attack, names):
    """Name what went wrong at one written note or chord: a wrong key, a neighbouring key caught,
    a likely overtone, or a note that did not sound. Keys a tone or less away are neighbours."""
    missed = list(attack["missed"])
    played = [pitch for pitch in attack["pitches"] if pitch not in missed]
    written = " + ".join(pitch_name(pitch, names) for pitch in attack["pitches"])
    slips = []
    for pitches in attack["inserted"]:
        heard = " + ".join(pitch_name(pitch, names) for pitch in pitches)
        if pitches == attack["pitches"]:
            slips.append((6, f"Played {written} twice"))
        # Sharing most of its notes with the written chord, an extra attack was a try before the right one.
        elif len(set(pitches) & set(attack["pitches"])) * 2 >= len(attack["pitches"]) and not missed:
            slips.append((10, f"Played {heard} first, then corrected it to {written}"))
        else:
            slips.append((8, f"Extra {heard} before {written}"))
    for pitch in attack["extra"]:
        name = pitch_name(pitch, names)
        replaced = min((m for m in missed if abs(m - pitch) <= 2), key=lambda m: abs(m - pitch), default=None)
        neighbour = min((p for p in played if abs(p - pitch) <= 2), key=lambda p: abs(p - pitch), default=None)
        octave = next((p for p in attack["pitches"] if pitch != p and (pitch - p) % 12 == 0), None)
        if replaced is not None:
            missed.remove(replaced)
            slips.append((10, f"Played {name} instead of {pitch_name(replaced, names)}"))
        elif neighbour is not None:
            slips.append((9, f"Caught {name} beside {pitch_name(neighbour, names)}"))
        elif octave is not None:
            slips.append((4, f"Heard an extra {name}, an octave from {pitch_name(octave, names)}; possibly an overtone"))
        else:
            slips.append((8, f"Extra {name}"))
    if missed:
        slips.append((10, f"Missed {' + '.join(pitch_name(pitch, names) for pitch in sorted(missed))}"))
    return slips


def drift(ratios):
    """Tempo change from the first third of the gaps to the last, in percent; positive means faster."""
    valid = [ratio for ratio in ratios if ratio]
    if len(valid) < 6:
        return None
    third = len(valid) // 3
    return round(100 * (median(valid[:third]) / median(valid[-third:]) - 1), 1)


# Tempo estimates from onsets wobble by a percent or two; a take this close to a mark has reached it.
CREDIT_TOLERANCE = 1.03


def credit(drill, per_beat, bpm):
    """The highest ladder rung at or below the tempo actually played, or None below the ladder."""
    rate = per_beat * bpm * CREDIT_TOLERANCE
    rungs = [index for index, (p, b) in enumerate(ladder(drill)) if p * b <= rate + 1e-9]
    return rungs[-1] if rungs else None


def unique_target(notes):
    seen = set()
    result = []
    for note in notes:
        # Both thumbs on one key in contrary motion produce a single sound.
        if (note["pitch"], note["start"]) not in seen:
            seen.add((note["pitch"], note["start"]))
            result.append(note)
    return result


def match_take(raw, notes):
    target = [Note.model_validate(note) for note in raw]
    score = compare_performance(target, notes)
    matched, observations, spreads = {}, [], []
    for group in score["alignment"]:
        available = list(group["played"])
        hands = {}
        for index in group["expected"]:
            found = next((j for j in available if notes[j].pitch == target[index].pitch), None)
            if found is not None:
                available.remove(found)
                matched[index] = found
                hands.setdefault(raw[index]["hand"], []).append(notes[found].start)
            observations.append({
                "index": index,
                "expected": target[index].pitch,
                "start": target[index].start,
                "matched": found is not None,
                "played_index": found,
                "heard": [notes[j].pitch for j in group["played"]],
            })
        if len(hands) == 2:
            spreads.append(abs(min(hands["right"]) - min(hands["left"])))
    observations.sort(key=lambda item: item["index"])
    return target, score, matched, observations, spreads


def assess_drill(prompt, notes, context, quality):
    drill = prompt["drill"]
    raw = unique_target(prompt["target"])
    result = {
        "version": ASSESSMENT_VERSION,
        "score": None,
        "observations": [],
        "evidence": [],
        "quality": quality,
        "feedback": "No piano notes were recognized. Your tempo has not changed.",
        "drill": None,
    }
    if not notes:
        return result
    target, score, matched, observations, spreads = match_take(raw, notes)
    result["score"] = {key: value for key, value in score.items() if key != "alignment"}
    result["observations"] = observations
    pitch = score["pitch_accuracy"]
    evenness = score["rhythm_accuracy"]
    played_bpm = round(prompt["bpm"] * score["tempo_percent"] / 100)
    velocities = [notes[j].velocity for j in matched.values()]
    loudness = None
    if drill["practice"] == "even" and len(velocities) >= 5:
        center = median(velocities)
        loudness = round(100 * exp(-4 * median(abs(v - center) for v in velocities) / max(1, center)))
    accents = None
    if drill["practice"].startswith("accent"):
        hits = []
        for index, played in matched.items():
            if not raw[index].get("accent"):
                continue
            neighbours = [
                notes[matched[other]].velocity
                for other in matched
                if abs(raw[other]["start"] - raw[index]["start"]) <= 60 / prompt["bpm"] and not raw[other].get("accent")
            ]
            if neighbours:
                hits.append(notes[played].velocity >= median(neighbours) + ACCENT_MARGIN)
        accents = round(100 * sum(hits) / len(hits)) if hits else None
    usable = context["source"] == "microphone" and quality["usable"]
    profile = timing_profile(raw, target, notes, matched, score["alignment"], prompt["bpm"], prompt["key"])
    take_drift = profile["drift_percent"]
    # Credit goes to the tempo actually played, whatever the suggestion was.
    credited = credit(drill["drill"], drill["per_beat"], profile["bpm"]) if profile["bpm"] else None
    if take_drift is not None and abs(take_drift) > CLEAN["drift"]:
        direction = "sped up" if take_drift > 0 else "slowed down"
        profile["issues"] = [f"The tempo {direction} {abs(take_drift):g}% from the first third of the take to the last",
                             *profile["issues"]][:5]
    deviations = [row["deviation_ms"] / 1000 for row in profile["timeline"] if row["deviation_ms"] is not None]
    if len(deviations) >= 2:
        evenness = round(100 * sum(exp(-max(0, abs(d) - 0.06) / 0.18) for d in deviations) / len(deviations))
        timing_ms = round(1000 * sum(abs(d) for d in deviations) / len(deviations))
    else:
        evenness = timing_ms = None
    clean = (
        usable
        and drill["practice"] == "even"
        and profile["pauses"] == 0
        and evenness is not None
        and pitch >= CLEAN["pitch"]
        and evenness >= CLEAN["evenness"]
        and (take_drift is None or abs(take_drift) <= CLEAN["drift"])
        and credited is not None
    )
    result["drill"] = {
        "usable": usable,
        "clean": clean,
        "pitch": pitch,
        "evenness": evenness,
        "played_bpm": played_bpm,
        "loudness": loudness,
        "accents": accents,
        "sync_ms": round(1000 * median(spreads)) if spreads else None,
        "timing_ms": timing_ms,
        "suggested_bpm": prompt["bpm"],
        "credit": credited,
        "targets": CLEAN,
        **profile,
    }
    if context["source"] != "microphone":
        result["feedback"] = "Demonstration only. Your tempo has not changed."
        return result
    if not quality["usable"]:
        result["feedback"] = "Saved, but recognition was uncertain. Check the heard notes; this attempt does not move your tempo."
        return result
    spec = DRILLS[drill["drill"]]
    challenge = prompt["challenge"]
    evidence = result["evidence"]

    def add(skill, value, facet="all", label=None, weight=1.0):
        if skill not in SKILLS or not 0 <= value <= 1:
            raise ValueError("Invalid skill evidence")
        evidence.append({"skill": skill, "facet": facet, "label": label or SKILLS[skill][1],
                         "value": value, "weight": weight, "challenge": challenge})

    key = prompt["key"]
    add("technique.accuracy", pitch / 100)
    if evenness is not None and pitch >= 70 and drill["practice"] == "even":
        add("technique.evenness", evenness / 100)
    if clean:
        # Controlled speed is the share of the drill's ladder played cleanly and steadily.
        speed = max(0.0, ladder_share(drill["drill"], credited))
        tempo = ladder(drill["drill"])[credited]
        add("technique.tempo", speed)
        add("technique.tempo", speed, f"bpm:{tempo[1]}", f"{tempo[1]} BPM")
    if loudness is not None and pitch >= 85:
        add("technique.dynamics", loudness / 100, weight=0.4)
    skill = GROUP_SKILLS[spec["group"]]
    value = pitch / 100 * (0.8 + 0.2 * evenness / 100) if evenness is not None else pitch / 100
    add(skill, value)
    add(skill, value, f"key:{key['signature']}", key["name"])
    add(skill, value, f"drill:{drill['config_key']}", drill["title"])
    misses = [row for row in result["observations"] if not row["matched"]]
    pauses = profile["pauses"]
    if clean:
        feedback = f"Clean and steady at ♩ {played_bpm}."
    elif pauses and pitch >= CLEAN["pitch"]:
        feedback = f"Accurate, but {pauses} pause{'s' if pauses > 1 else ''} kept it from being clean. Play through the spot slowly until it flows."
    elif misses:
        counts = defaultdict(int)
        for row in misses:
            counts[row["expected"]] += 1
        worst = max(counts, key=counts.get)
        feedback = f"{len(misses)} expected notes did not match, most often {pitch_name(worst, naming_key(key))}. Slow down until every note is secure."
    elif evenness is not None and evenness < CLEAN["evenness"]:
        feedback = "The notes were right; the spacing was uneven. Listen for equal gaps, especially at thumb crossings."
    elif take_drift is not None and abs(take_drift) > CLEAN["drift"]:
        feedback = f"You {'sped up' if take_drift > 0 else 'slowed down'} {abs(take_drift):g}% over the take. Settle on one tempo you can hold, slower if need be."
    elif drill["practice"] != "even":
        feedback = "Rhythm and accent practice is recorded. Switch back to even notes to move your tempo."
    else:
        feedback = "Close. Another pass at this tempo."
    if accents is not None:
        feedback += f" Accents stood out on {accents}% of the accented notes."
    result["feedback"] = feedback
    return result


if __name__ == "__main__":
    main()
