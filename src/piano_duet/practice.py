import hashlib
import json
import random
import time
from collections import Counter
from itertools import pairwise
from uuid import uuid4

from piano_duet.assessment import pitch_name
from piano_duet.key_tracking import MusicalKey

FOCUSES = ("guided", "technique", "reading", "theory", "ear", "repertoire")
ANCHORS = {
    "technique": "technique.scales",
    "reading": "reading.pitch",
    "theory": "theory.chords",
    "ear": "ear.pitch",
    "repertoire": "repertoire.recall",
}
KEY_ORDER = [
    (0, "major"),
    (7, "major"),
    (5, "major"),
    (9, "minor"),
    (2, "major"),
    (4, "minor"),
    (10, "major"),
    (2, "minor"),
    (9, "major"),
    (3, "major"),
]
KEY_ORDER += [
    (tonic, mode)
    for mode in ("major", "minor")
    for tonic in range(12)
    if (tonic, mode) not in KEY_ORDER
]


def main():
    from piano_duet.profile import LearnerStore

    print(json.dumps(next_task(LearnerStore()), indent=2))


def fingerprint(notes):
    first = notes[0]["start"]
    attacks = sorted({n["start"] for n in notes})
    beat = min((b - a for a, b in pairwise(attacks)), default=1)
    content = [
        (n["pitch"], round((n["start"] - first) / beat, 3), round(n["duration"] / beat, 3))
        for n in notes
    ]
    return hashlib.sha256(json.dumps(content).encode()).hexdigest()


def sequence(pitches, bpm, beats=None):
    beats = beats if beats is not None else [1] * len(pitches)
    notes = []
    position = 0
    for pitch, length in zip(pitches, beats, strict=True):
        notes.append(
            {
                "pitch": pitch,
                "start": position * 60 / bpm,
                "duration": length * 60 / bpm,
                "velocity": 76,
            }
        )
        position += length
    return notes


def choose_focus(profile):
    recent = profile["practice_recent"]
    skills = {s["id"]: s for s in profile["skills"]}
    if not recent:
        return "technique", "Explore", "A comfortable scale gives us a first look at your playing."
    last = recent[0]
    family = last["context"]["family"]
    score = last["assessment"]["score"]
    same = sum(a["context"]["family"] == family for a in recent[:3])
    if (
        family == "theory"
        and score
        and score["score"] < 80
        and last["assessment"]["evidence"]
        and not last["context"]["reveals"]
        and not last["context"]["hints"]
        and not last["context"]["hearings"]
    ):
        return (
            "technique",
            "Check",
            "Try the same notes with the answer shown. This helps separate remembering the notes from executing them.",
        )
    if family == "repertoire" and any(
        row["skill"] == "technique.chords" and row["facet"] == "all" and row["value"] < 0.8
        for row in last["assessment"]["evidence"]
    ):
        return (
            "technique",
            "Repair",
            "Isolate a chord that was difficult in your piece, with its notes shown.",
        )
    if score and score["score"] < 80 and last["assessment"]["evidence"] and same < 3:
        return family, "Repair", "Your last attempt suggests a useful place to slow down and focus."
    for focus, anchor in ANCHORS.items():
        seen = any(a["context"]["family"] == focus for a in recent)
        if not seen and skills[anchor]["accuracy"] is None:
            return focus, "Explore", f"We have little evidence about your {focus} yet."
    oldest = min(
        ANCHORS,
        key=lambda focus: max(
            (a["created_at"] for a in recent if a["context"]["family"] == focus), default=0
        ),
    )
    skill = skills[ANCHORS[oldest]]
    if skill["last_practiced"] and time.time() - skill["last_practiced"] > 7 * 86400:
        return oldest, "Revisit", "Return to a skill after a break to see what has stayed with you."
    return (
        oldest,
        "Extend" if (skill["accuracy"] or 0) >= 85 else "Explore",
        "Keep your practice balanced across skills.",
    )


def select_key(skill):
    conditions = {row["id"]: row for row in skill["conditions"]}
    accessible = 4 if not skill.get("level") else 8 if skill["level"] == 1 else 24
    keys = [MusicalKey(*item).to_dict() for item in KEY_ORDER[:accessible]]
    weak = [
        key
        for key in keys
        if conditions.get(f"key:{key['signature']}", {}).get("accuracy", 100) < 80
    ]
    if weak:
        key = min(weak, key=lambda key: conditions[f"key:{key['signature']}"]["accuracy"])
        return key, f"Focus on {key['name']}, where recent attempts were less accurate."
    key = min(
        keys, key=lambda key: conditions.get(f"key:{key['signature']}", {}).get("attempts", 0)
    )
    return key, f"Explore {key['name']}, which has less practice in this skill."


def next_task(store, focus="guided", rng=None, piece_id=None):
    if focus not in FOCUSES:
        raise ValueError("Unknown practice focus")
    rng = rng or random.SystemRandom()
    profile = store.profile()
    skills = {skill["id"]: skill for skill in profile["skills"]}
    family, purpose, reason = (
        choose_focus(profile)
        if focus == "guided"
        else (focus, "Explore", "Practice the focus you selected.")
    )
    skill = skills[ANCHORS[family]]
    theory_shape = "chord"
    if (
        family == "theory"
        and skills["theory.chords"]["attempts"] > skills["theory.scales"]["attempts"]
    ):
        theory_shape = "scale"
        skill = skills["theory.scales"]
    challenge = min(5, (skill["level"] or 0) + 1)
    if skill["accuracy"] is not None and skill["accuracy"] < 70:
        challenge = max(1, skill["challenge"] - 1)
        purpose = "Repair"
    key, key_reason = select_key(skill)
    diagnostic = profile["practice_recent"][0] if purpose == "Check" else None
    if diagnostic:
        key = diagnostic["key"]
        key_reason = ""
    if family in ("reading", "ear") and challenge == 1:
        key = MusicalKey(0, "major").to_dict()
        key_reason = "Start with a small range in C major."
    bpm = (50, 60, 76, 92, 112)[challenge - 1]
    root = 60 + key["tonic"]
    root_name = f"{key['name'].split()[0]}4"
    intervals = (0, 2, 4, 5, 7, 9, 11) if key["mode"] == "major" else (0, 2, 3, 5, 7, 8, 10)
    scale = [root + step for step in intervals] + [root + 12]
    shape = "melody"
    piece = None
    familiar = False
    even = False
    task = {
        "id": str(uuid4()),
        "family": family,
        "challenge": challenge,
        "bpm": bpm,
        "meter": "4/4",
        "key": key,
        "reason": f"{reason} {key_reason}",
        "purpose": purpose,
        "context": {
            "notation_visible": family in ("technique", "reading"),
            "hearings": 0,
            "reveals": 0,
            "hints": 0,
            "familiar": False,
        },
    }
    chord_conditions = [
        row
        for row in skills["technique.chords"]["conditions"]
        if row["id"].startswith("chord:") and row["accuracy"] < 80
    ]
    if family == "technique" and (diagnostic or chord_conditions):
        if diagnostic:
            pitches = [row["expected"] for row in diagnostic["assessment"]["observations"]]
            shape = diagnostic["shape"]
        else:
            condition = min(chord_conditions, key=lambda row: row["accuracy"])
            pitches = [int(pitch) for pitch in condition["id"].split(":")[1].split(",")]
            shape = "chord"
            source = next(
                (
                    attempt
                    for attempt in profile["recent"]
                    if not attempt["excluded"]
                    and any(
                        row["facet"] == condition["id"] for row in attempt["assessment"]["evidence"]
                    )
                ),
                None,
            )
            key = source["key"] if source and source["key"] else key
        task.update(
            {
                "key": key,
                "shape": shape,
                "challenge": 1,
                "bpm": 50,
                "even": shape == "scale",
                "dynamics": None,
                "title": "Find the notes with a guide"
                if diagnostic
                else "Give this chord some room",
                "instruction": "Play the notes shown at a comfortable, steady pace. For a chord, play all its notes together, four times with space between attacks.",
                "lesson": "Use the note names to find the keys before you begin. Start slowly. We are checking this particular pattern, without asking you to recall its notes.",
                "target": (
                    [
                        {"pitch": pitch, "start": attack * 2.4, "duration": 1.2, "velocity": 76}
                        for attack in range(4)
                        for pitch in pitches
                    ]
                    if shape == "chord"
                    else sequence(pitches, 50)
                ),
            }
        )
        task["cue"] = (
            " + ".join(pitch_name(pitch, key) for pitch in pitches)
            if shape == "chord"
            else " → ".join(pitch_name(pitch, key) for pitch in pitches)
        )
        task["reason"] = (
            reason
            if diagnostic or purpose == "Repair"
            else "Your other playing showed a difficult chord. Give that pattern some focused practice."
        )
        store.add_task(task)
        return task
    if family in ("technique", "theory"):
        shape = "scale" if family == "technique" else theory_shape
        if shape == "scale":
            if challenge >= 4:
                scale += [pitch + 12 for pitch in scale[1:]]
            pitches = scale + scale[-2::-1] if family == "technique" else scale
            task["target"] = sequence(pitches, bpm)
            natural = "natural " if key["mode"] == "minor" else ""
            title_key = key["name"].replace("minor", f"{natural}minor")
            task["title"] = f"{title_key} scale"
            direction = "up and back down" if family == "technique" else "upward"
            if family == "theory" and challenge in (3, 5):
                task["target"] = sequence(list(reversed(pitches)), bpm)
                direction = "downward"
            task["instruction"] = (
                f"Play the {title_key} scale {direction}, starting on {root_name}. Use one hand."
            )
            if direction == "downward":
                task["instruction"] = (
                    f"Play the {title_key} scale downward. Start {2 if challenge == 5 else 1} octave(s) above {root_name}."
                )
            even = family == "technique"
            if even:
                task["instruction"] += (
                    f" Aim for an even sound and one note per beat at {bpm} BPM. Start slower if you need to."
                )
            else:
                task["instruction"] += (
                    " Work out the notes yourself, or reveal the score for help. Timing is optional."
                )
                task["bpm"] = None
        else:
            pitches = [root, root + (4 if key["mode"] == "major" else 3), root + 7]
            inversion = {3: "first inversion", 4: "second inversion"}.get(challenge)
            if challenge == 3:
                pitches = pitches[1:] + [root + 12]
            elif challenge == 4:
                pitches = pitches[2:] + [root + 12, pitches[1] + 12]
            elif challenge == 5:
                pitches.append(root + (11 if key["mode"] == "major" else 10))
            task["target"] = [
                {"pitch": pitch, "start": 0, "duration": 2, "velocity": 76} for pitch in pitches
            ]
            task["title"] = f"Build a {key['name']} chord"
            task["instruction"] = (
                f"Play a {key['name']} triad as one chord, starting with {root_name} as its lowest note. Work out the other two notes, or reveal the score for help."
            )
            if inversion:
                task["title"] += f" · {inversion}"
                task["instruction"] = (
                    f"Build the {key['name']} triad from {root_name}, then play its {inversion}: move the lowest {1 if challenge == 3 else 2} note(s) up an octave. Play all three notes together."
                )
            elif challenge == 5:
                task["title"] = f"Build a {key['name']} seventh chord"
                task["instruction"] = (
                    f"Build a {key['name']} seventh chord in root position, beginning on {root_name}. Include the root, third, fifth, and seventh. Play the four notes together."
                )
            task["bpm"] = None
        task["lesson"] = (
            "A major scale steps whole, whole, half, whole, whole, whole, half; natural minor steps whole, half, whole, whole, half, whole, whole. A half step is the next key, including black keys."
            if shape == "scale"
            else "A major triad has a root, a note 4 half steps above it, and a note 7 half steps above it. A minor triad uses 3 and 7 half steps. Count every key, including black keys."
        )
        if shape == "chord" and challenge == 5:
            task["lesson"] += (
                " The major seventh is 11 half steps above the root; the minor seventh is 10."
            )
    elif family in ("reading", "ear"):
        conditions = {c["id"]: c for c in skill["conditions"]}
        bass = family == "reading" and conditions.get("clef:treble", {}).get(
            "attempts", 0
        ) > conditions.get("clef:bass", {}).get("attempts", 0)
        weak_notes = sorted(
            (
                row
                for row in skill["conditions"]
                if row["id"].startswith("pitch:") and row["accuracy"] < 80
            ),
            key=lambda row: (row["accuracy"], row["last_practiced"]),
        )
        if family == "reading" and weak_notes:
            bass = int(weak_notes[0]["id"].split(":")[1]) < 60
        base = 48 if bass else 60
        pool = [base + key["tonic"] + step for step in intervals[: min(7, 4 + challenge)]]
        if bass and max(pool) >= 60:
            pool = [pitch - 12 for pitch in pool]
        priority = sorted(
            pool,
            key=lambda pitch: (
                0 if conditions.get(f"pitch:{pitch}", {}).get("accuracy", 100) < 80 else 1,
                conditions.get(f"pitch:{pitch}", {}).get("accuracy", 0),
                conditions.get(f"pitch:{pitch}", {}).get("attempts", 0),
            ),
        )[:2]
        weights = [
            1 + (100 - conditions.get(f"pitch:{pitch}", {}).get("accuracy", 0)) / 20
            for pitch in pool
        ]
        length = (
            (8, 8, 12, 16, 16)[challenge - 1]
            if family == "reading"
            else (4, 5, 6, 8, 10)[challenge - 1]
        )
        existing = store.reading_fingerprints() if family == "reading" else set()
        for _ in range(200):
            pitches = []
            limit = max(2, length // 3)
            for _ in range(length):
                available = [
                    pitch
                    for pitch in pool
                    if pitches.count(pitch) < limit and pitches[-2:] != [pitch, pitch]
                ]
                available_weights = [weights[pool.index(pitch)] for pitch in available]
                pitches.append(rng.choices(available, weights=available_weights, k=1)[0])
            if family == "reading":
                for position, pitch in zip(rng.sample(range(length), 2), priority, strict=True):
                    pitches[position] = pitch
            if (
                len(set(pitches)) < min(4 if family == "reading" else 3, length)
                or max(Counter(pitches).values()) > limit
                or any(pitches[i - 2 : i + 1] == [pitches[i]] * 3 for i in range(2, len(pitches)))
            ):
                continue
            beats = [rng.choice([0.5, 0.5, 1]) for _ in pitches] if challenge >= 3 else [1] * length
            notes = sequence(pitches, bpm, beats)
            if fingerprint(notes) not in existing:
                break
        else:
            raise RuntimeError("Could not generate an unseen reading exercise")
        task["target"] = notes
        task["title"] = "A fresh reading" if family == "reading" else "From your ear to the keys"
        task["instruction"] = (
            f"Read this new {'bass' if bass else 'treble'} part at a comfortable, steady pace. Aim for {bpm} BPM. You will get different music next time."
            if family == "reading"
            else "Hear the short melody, then play it back from memory. It starts near middle C. Take a slower, steady pace if needed."
        )
        if family == "reading":
            task["reason"] += (
                f" More attention to {', '.join(pitch_name(p, key) for p in priority)} and the {'bass' if bass else 'treble'} clef."
            )
        task["lesson"] = (
            "Middle C is immediately to the left of the pair of black keys nearest the center of the piano. Read the upper staff with the right hand and the lower staff with the left hand. A higher note on the page means a higher key."
        )
    else:
        pieces = store.pieces()
        if not pieces:
            piece = {
                "id": str(uuid4()),
                "title": "First steps",
                "key": MusicalKey(0, "major").to_dict(),
                "challenge": 1,
                "bpm": 60,
                "notes": sequence([60, 62, 64, 62, 60, 64, 62, 60], 60),
            }
            store.add_piece(piece)
            pieces = [piece]
        if piece_id:
            selected = [p for p in pieces if p["id"] == piece_id]
            if not selected:
                raise ValueError("Unknown practice piece")
            piece = selected[0]
        else:
            piece = pieces[-1]
        familiar = any(
            a["prompt"].get("piece_id") == piece["id"] and a["notes"] and not a["excluded"]
            for a in store.attempts()
        )
        task.update(
            {
                "title": piece["title"],
                "piece_id": piece["id"],
                "key": piece["key"],
                "challenge": piece["challenge"],
                "bpm": piece["bpm"],
                "target": piece["notes"],
                "instruction": f"{'Play this piece from memory' if familiar else 'Learn this short piece'}. Reveal the score or hear it whenever you need help. Later, try it without either.",
                "reason": "Return to a piece you have chosen to keep. Repetitions build familiarity; an unaided attempt gives evidence about recall.",
                "lesson": "Learn a small part at a time. When you can play it comfortably, look away and try it again. Use a steady tempo that lets you keep going.",
            }
        )
        task["context"]["notation_visible"] = not familiar
    task["shape"] = shape
    task["cue"] = (
        " → ".join(pitch_name(note["pitch"], key) for note in task["target"])
        if family == "technique"
        else ""
    )
    task["even"] = even
    task["dynamics"] = "even" if even else None
    task["context"]["familiar"] = familiar
    store.add_task(task, fingerprint(task["target"]) if family == "reading" else None)
    return task


if __name__ == "__main__":
    main()
