from collections import Counter
from itertools import pairwise
from statistics import mean, median

from piano_duet.key_tracking import MusicalKey

MAJOR_KEYS = [(tonic, "major") for tonic in (0, 7, 5, 2, 10, 9, 3, 4, 8, 11, 1, 6)]
MINOR_KEYS = [(tonic, "minor") for tonic in (9, 4, 2, 11, 7, 6, 0, 1, 5, 8, 10, 3)]
STAGE_CHANGES = (
    ("first_notes", "First notes", "Find C, D and E in both clefs.", {}),
    ("steps_skips", "Steps and skips", "Read a wider range in changing five-finger positions.", {}),
    (
        "fourths",
        "Fourth-sized moves",
        "Read a fourth inside a familiar hand position.",
        {"step": 3},
    ),
    ("fifths", "Fifth-sized moves", "Read across a whole five-finger position.", {"step": 4}),
    (
        "long_notes",
        "Long and short notes",
        "Keep a pulse through quarter, half and whole notes.",
        {"rhythm": "long", "rhythm_required": True},
    ),
    ("eighths", "Eighth notes", "Fit two short notes into one beat.", {"rhythm": "eighths"}),
    (
        "first_keys",
        "One sharp or flat",
        "Read F-sharp in G major and B-flat in F major.",
        {"keys": MAJOR_KEYS[:3], "phase": "Developing", "fingering": False, "bass_low": 45},
    ),
    (
        "minor",
        "Minor melodies",
        "Read minor scales and their raised leading notes.",
        {"keys": MAJOR_KEYS[:3] + MINOR_KEYS[:3], "chromatic": 1},
    ),
    (
        "pairs",
        "Two notes at once",
        "Recognize thirds and fifths as a single shape.",
        {"texture": "dyads"},
    ),
    (
        "grand_staff",
        "Both clefs together",
        "Follow a phrase as it passes between the hands.",
        {"texture": "alternating"},
    ),
    (
        "together",
        "Hands together",
        "Read a moving melody above a simple held bass.",
        {"texture": "together"},
    ),
    (
        "dotted",
        "Dotted rhythms",
        "Read long-short patterns in 2/4, 3/4 and 4/4.",
        {
            "rhythm": "dotted",
            "meters": ("2/4", "3/4", "4/4"),
            "tempo": 44,
            "phase": "Intermediate",
            "required_scores": 4,
            "rhythm_scope": "continuous",
        },
    ),
    (
        "triads",
        "Chord shapes",
        "Read major and minor triads and their inversions.",
        {"texture": "triads", "span": 7},
    ),
    (
        "ties",
        "Ties and offbeats",
        "Carry a note over a beat and enter between beats.",
        {"rhythm": "syncopation", "rest_probability": 0.35},
    ),
    (
        "compound",
        "Compound time",
        "Feel two groups of three eighth notes in 6/8.",
        {"rhythm": "compound", "meters": ("6/8",)},
    ),
    (
        "ledger_lines",
        "Beyond the staff",
        "Read ledger lines and larger position changes.",
        {"register": 1, "shift": 7},
    ),
    (
        "more_keys",
        "More key signatures",
        "Read up to four sharps or flats with occasional accidentals.",
        {"keys": MAJOR_KEYS[:9] + MINOR_KEYS[:9], "chromatic": 2},
    ),
    (
        "sixteenths",
        "Sixteenth notes",
        "Read four even subdivisions within a beat.",
        {
            "rhythm": "sixteenths",
            "meters": ("3/4", "4/4"),
            "tempo": 48,
            "phase": "Advanced",
            "required_scores": 6,
        },
    ),
    (
        "triplets",
        "Triplets",
        "Fit three eighth notes into one quarter-note beat.",
        {"rhythm": "triplets"},
    ),
    (
        "independence",
        "Independent hands",
        "Read different onset patterns in the two hands.",
        {"texture": "independent", "rhythm": "mixed", "tempo": 52},
    ),
    (
        "all_keys",
        "Every major and minor key",
        "Transfer your reading to all 24 keys.",
        {"keys": MAJOR_KEYS + MINOR_KEYS},
    ),
    (
        "meters",
        "Changing beat groups",
        "Read 9/8, 12/8, 5/4 and grouped 7/8.",
        {"meters": ("4/4", "6/8", "9/8", "12/8", "5/4", "7/8")},
    ),
    (
        "voicings",
        "Fuller textures",
        "Read seventh chords, octave shapes and wider leaps.",
        {"texture": "voicings", "register": 2, "shift": 10, "tempo": 60},
    ),
    (
        "expert",
        "Expert reading practice",
        "Combine all keys, independent hands, complex rhythms and changing registers.",
        {"rhythm": "mixed", "tempo": 72, "phase": "Expert"},
    ),
)
STAGE_LESSONS = {
    "first_notes": "Higher notes on the staff sound higher on the piano. Find the first note, then follow the next notes. Thumb is finger 1 on either hand.",
    "steps_skips": "Line to neighboring space is one scale step; line to the next line is a skip. Check your absolute starting note again at each bar.",
    "fourths": "A fourth spans four letter names, counting both ends: C–D–E–F. On the staff it goes from a line to a space, or a space to a line, three staff steps away.",
    "fifths": "A fifth spans five letter names, such as C to G. Both ends sit on lines or both on spaces. Look ahead to the numbered first note of the next bar.",
    "long_notes": "In 4/4, a filled note with a stem lasts one beat, an open note with a stem lasts two, and an open note without a stem lasts four. Keep counting while you hold.",
    "eighths": "Two eighth notes fit in one quarter-note beat. Count '1 and 2 and'. A flag or beam marks an eighth; a quarter has neither.",
    "first_keys": "The key signature changes every note with that letter name, in every octave. G major has F-sharp; F major has B-flat. Fingering is now your choice.",
    "minor": "A minor key has its own key signature. A raised seventh often leads up to the tonic: in A minor, G-sharp leads to A. An accidental lasts to the bar line.",
    "pairs": "Read the two noteheads vertically and strike both keys together. Thirds span three letter names; fifths span five. An extra detected octave is tolerated, but every written pitch is required.",
    "grand_staff": "The brace joins treble and bass into one piano score. Follow the active hand; the other staff shows rests. Read the next hand's first note before it arrives.",
    "together": "Notes aligned vertically start together. Keep holding the bass for its written length while the right hand continues. A held bass does not need to be struck again.",
    "dotted": "A dot adds half a note's value: a dotted quarter lasts one and a half beats. Count the eighth-note subdivisions to place the short note accurately.",
    "triads": "A triad contains three pitches. An inversion moves a chord tone into another octave, changing the spacing on the staff. Read the whole shape before playing.",
    "ties": "A tie joins the same pitch into one held sound. Do not strike its second notehead again. Count through offbeats and occasional rests: a rest is written time without playing.",
    "compound": "In 6/8 there are two main pulses, each containing three eighth notes: '1-la-li, 2-la-li'. The app's BPM is still measured in quarter-note units.",
    "ledger_lines": "Ledger lines extend the same line-space pattern beyond the staff. Use nearby C landmarks, and preview the next bar before moving your hand.",
    "more_keys": "Read the key signature first, then check local accidentals. A natural cancels a sharp or flat for that letter and octave until the bar line.",
    "sixteenths": "Four sixteenths fit in one quarter-note beat. Count '1 e and a'. Keep the underlying pulse the same when changing between quarters, eighths and sixteenths.",
    "triplets": "A group marked 3 fits three eighth notes into the time of two. Divide the quarter-note beat into three equal parts, without speeding up the pulse.",
    "independence": "Read vertically to see which notes start together, then follow each hand's rhythm. Keep one shared pulse even when the hands attack at different moments.",
    "all_keys": "Use the signature to establish the scale, then read intervals and chord shapes within it. Enharmonic spellings can name the same piano key differently.",
    "meters": "Read the time signature before starting. 9/8 and 12/8 group eighths in threes; these 7/8 scores group them 2+2+3. In 5/4 there are five quarter-note beats.",
    "voicings": "Find the outer notes of the chord, then fill in the inner notes. Octave shapes repeat the same letter name eight scale steps apart. Prepare wider shifts in advance.",
    "expert": "Preview the signature, beat groups, rhythm changes and hand shifts before beginning. Read ahead in shapes while keeping the pulse across both hands.",
}


def main():
    for stage in stages():
        print(f"{stage['number']}. {stage['label']}: {stage['description']}")


def stages():
    settings = {
        "step": 2,
        "rhythm": "quarters",
        "rest_probability": 0,
        "rhythm_required": False,
        "rhythm_scope": "within_position",
        "required_scores": 3,
        "phase": "Beginner",
        "fingering": True,
        "bass_low": 48,
        "keys": MAJOR_KEYS[:1],
        "texture": "single",
        "span": 4,
        "register": 0,
        "shift": 3,
        "meters": ("4/4",),
        "chromatic": 0,
        "tempo": 0,
        "bars": 4,
    }
    result = []
    for number, (id_, label, description, changes) in enumerate(STAGE_CHANGES, 1):
        settings = {**settings, **changes}
        result.append(
            {
                **settings,
                "id": id_,
                "number": number,
                "label": label,
                "description": description,
                "lesson": STAGE_LESSONS[id_],
            }
        )
    return result


STAGES = stages()


def stage_by_id(id_):
    return next(stage for stage in STAGES if stage["id"] == id_)


def reading_rhythm(task, observations, context):
    attacks = []
    for row in observations:
        if not attacks or row["start"] != attacks[-1]["start"]:
            attacks.append(row)
    periods = []
    intervals = []
    eligible = 0
    stage_id = task["reading"].get("stage_id")
    within_position = (
        stage_id in (None, "rests") or stage_by_id(stage_id)["rhythm_scope"] == "within_position"
    )
    landings = {position["index"] for position in task["reading"]["positions"]}
    timing = context.get("reading_timing")
    if timing is None:
        return {"accuracy": None, "bpm": None, "coverage": 0, "intervals": 0}
    for left, right in pairwise(attacks):
        if within_position and right["index"] in landings:
            continue
        eligible += 1
        written = (right["start"] - left["start"]) * task["bpm"] / 60
        elapsed = right["heard_at"] - left["heard_at"]
        if written <= 0:
            raise ValueError("Reading attack positions must increase")
        interrupted = any(
            left["group"] < point <= right["group"] for point in timing["interruptions"]
        )
        if (
            interrupted
            or elapsed > 10
            or elapsed <= 0
            or min(left["confidence"], right["confidence"]) < 0.8
            or not left["matched"]
            or not right["matched"]
        ):
            continue
        intervals.append((written, elapsed))
        periods.append(elapsed / written)
    coverage = len(intervals) / max(1, eligible)
    if len(periods) < (2 if within_position else 3) or coverage < 0.75:
        return {
            "accuracy": None,
            "bpm": None,
            "coverage": round(coverage, 2),
            "intervals": len(periods),
        }
    period = median(periods)
    values = [
        max(
            0,
            1 - max(0, abs(elapsed - written * period) - 0.08) / max(0.12, written * period * 0.5),
        )
        for written, elapsed in intervals
    ]
    return {
        "accuracy": round(100 * mean(values)),
        "bpm": round(60 / period),
        "coverage": round(coverage, 2),
        "intervals": len(periods),
    }


def stage_requirements(stage, records):
    recent = records[-24:]
    required = stage["required_scores"]
    hands = ("treble", "bass") if stage["texture"] in ("single", "dyads") else ("grand",)
    groups = []
    for hand in hands:
        rows = [row for row in recent if row["clef"] == hand][-required:]
        pitches = [value for row in rows for value in row["pitch_values"]]
        accuracy = round(100 * mean(pitches)) if pitches else None
        rhythms = [
            row["rhythm"]["accuracy"] for row in rows if row["rhythm"]["accuracy"] is not None
        ]
        tempos = [row["rhythm"]["bpm"] for row in rows if row["rhythm"]["bpm"] is not None]
        rhythm = round(mean(rhythms)) if rhythms else None
        tempo = round(median(tempos)) if tempos else None
        needs_rhythm = stage["rhythm_required"]
        passed = len(rows) >= required and accuracy >= 90
        passed = passed and (not needs_rhythm or (len(rhythms) >= required and rhythm >= 80))
        passed = passed and (not stage["tempo"] or (tempo is not None and tempo >= stage["tempo"]))
        groups.append(
            {
                "hand": hand,
                "samples": len(rows),
                "required": required,
                "accuracy": accuracy,
                "rhythm": rhythm,
                "rhythm_samples": len(rhythms),
                "bpm": tempo,
                "ready": passed,
            }
        )
    successful = [
        row
        for row in records
        if mean(row["pitch_values"]) >= 0.9
        and (
            not stage["rhythm_required"]
            or (row["rhythm"]["accuracy"] is not None and row["rhythm"]["accuracy"] >= 80)
        )
        and (not stage["tempo"] or (row["rhythm"]["bpm"] or 0) >= stage["tempo"])
    ]
    played_keys = {row["key"] for row in successful}
    required_keys = (
        len(stage["keys"])
        if stage["id"] in ("first_keys", "minor", "more_keys", "all_keys")
        else min(3, len(stage["keys"]))
    )
    meters = {row["meter"] for row in successful}
    required_meters = len(stage["meters"]) if stage["id"] == "meters" else 1
    notes = []
    if stage["number"] <= 2:
        vocabulary = {
            "treble": [60, 62, 64, 65, 67, 69, 71, 72, 74, 76],
            "bass": [48, 50, 52, 53, 55, 57, 59],
        }
        for hand, pitches in vocabulary.items():
            for pitch in pitches[:3] if stage["number"] == 1 else pitches:
                values = [
                    value
                    for row in records
                    if row["clef"] == hand
                    for expected, value in zip(row["pitches"], row["pitch_values"], strict=True)
                    if expected == pitch
                ][-8:]
                notes.append(len(values) >= 3 and mean(values) >= 0.85)
    return {
        "groups": groups,
        "keys": len(played_keys),
        "key_signatures": sorted(played_keys),
        "required_keys": required_keys,
        "meters": len(meters),
        "required_meters": required_meters,
        "notes": sum(notes),
        "required_notes": len(notes),
        "ready": all(group["ready"] for group in groups)
        and all(notes)
        and len(played_keys) >= required_keys
        and len(meters) >= required_meters,
    }


def curriculum_progress(attempts, replay=None):
    records = {stage["id"]: [] for stage in STAGES}
    earned = set()
    seen = set()
    for attempt in attempts:
        if attempt["excluded"] or attempt["context"]["source"] != "microphone":
            continue
        task, assessment = attempt["prompt"], attempt["assessment"]
        if (
            task["family"] != "reading"
            or not task.get("reading")
            or not any(item["skill"] == "reading.pitch" for item in assessment["evidence"])
        ):
            continue
        if task["id"] in seen:
            continue
        seen.add(task["id"])
        id_ = task.get("reading", {}).get("stage_id")
        if id_ == "rests":
            continue
        record = {
            "clef": task["reading"]["clef"],
            "key": task["key"]["signature"],
            "meter": task["meter"],
            "pitch_values": [float(row["matched"]) for row in assessment["observations"]],
            "pitches": [row["expected"] for row in assessment["observations"]],
            "rhythm": reading_rhythm(task, assessment["observations"], attempt["context"]),
            "rhythm_pattern": [
                [
                    round(note["start"] * task["bpm"] / 60, 4),
                    round(note["duration"] * task["bpm"] / 60, 4),
                ]
                for note in task["target"]
            ],
        }
        # Saved white-key exercises can establish foundations, never unplayed advanced material.
        for stage_id in [id_] if id_ is not None else ["first_notes", "steps_skips"]:
            stage = stage_by_id(stage_id)
            records[stage_id].append(record)
            if stage_id not in earned and stage_requirements(stage, records[stage_id])["ready"]:
                earned.add(stage_id)
    current = next((stage for stage in STAGES if stage["id"] not in earned), STAGES[-1])
    # New scores come from the frontier stage unless the player replays an earned one.
    target = current
    if replay is not None:
        if not 1 <= replay <= len(STAGES):
            raise ValueError(f"Reading stages run from 1 to {len(STAGES)}")
        target = STAGES[replay - 1]
        if target["id"] not in earned and target["id"] != current["id"]:
            raise ValueError(f"Stage {replay} is locked until the earlier stages are complete")
    path = []
    for stage in STAGES:
        requirements = stage_requirements(stage, records[stage["id"]])
        path.append(
            {
                "id": stage["id"],
                "number": stage["number"],
                "label": stage["label"],
                "description": stage["description"],
                "phase": stage["phase"],
                "status": "Complete"
                if stage["id"] in earned
                else "Current"
                if stage["id"] == current["id"]
                else "Ahead",
                "rhythm_required": stage["rhythm_required"],
                "rhythm_scope": stage["rhythm_scope"],
                "minimum_bpm": stage["tempo"],
                **requirements,
            }
        )
    context_counts = Counter(
        (row["clef"], row["key"], row["meter"]) for row in records[target["id"]]
    )
    return {
        "current": current["id"],
        "number": current["number"],
        "label": current["label"],
        "completed": len(earned),
        "total": len(STAGES),
        "path": path,
        "finished": all(stage["id"] in earned for stage in STAGES),
        "contexts": [
            {"clef": clef, "key": key, "meter": meter, "samples": count}
            for (clef, key, meter), count in context_counts.items()
        ],
        "target": target["id"],
        "target_number": target["number"],
        "key_names": [MusicalKey(*key).name for key in target["keys"]],
        "demonstrated_keys": path[target["number"] - 1]["key_signatures"],
        "recent_rhythms": [row["rhythm_pattern"] for row in records[target["id"]][-4:]],
    }


if __name__ == "__main__":
    main()
