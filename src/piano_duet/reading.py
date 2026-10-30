from collections import defaultdict
from itertools import pairwise
from statistics import mean, median

from piano_duet.assessment import pitch_name
from piano_duet.profile import ASSESSMENT_VERSION
from piano_duet.reading_curriculum import POSITION_PAUSE_LIMIT, measure_landings, reading_rows
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import reading_rhythm


def main():
    print("Live reading measures pitch accuracy and position-change fluency separately.")


def matches_reading(pitches, expected):
    expected = [expected] if isinstance(expected, int) else expected
    return all(pitch in pitches for pitch in expected) and all(
        any((pitch - target) % 12 == 0 for target in expected) for pitch in pitches
    )


def measure_position_changes(task, observations, context, usable, assisted):
    changes = []
    reading = task["reading"]
    target = task["target"]
    timing = context.get("reading_timing")
    by_staff = defaultdict(list)
    for position in reading["positions"]:
        by_staff[position.get("clef", reading["clef"])].append(position)
    for preceding, position in [pair for cues in by_staff.values() for pair in pairwise(cues)]:
        index = position["index"]
        clef = position.get("clef", reading["clef"])
        change = {
            "index": index,
            "clef": clef,
            "hand": position.get("hand", reading["hand"]),
            "pitch": target[index]["pitch"],
            "finger": position["finger"],
            "from_position": preceding["low"],
            "to_position": position["low"],
            "shift_steps": position["low"] - preceding["low"],
            "extra_seconds": None,
            "extra_beats": None,
            "bpm": None,
            "reason": None,
        }
        changes.append(change)
        baseline = []
        for row in observations[preceding["index"] : index]:
            if target[row["index"]].get("staff", reading["clef"]) == clef and (
                not baseline or row["start"] != baseline[-1]["start"]
            ):
                baseline.append(row)
        baseline = baseline[-4:]
        landing = observations[index]
        if assisted:
            change["reason"] = "Assisted practice or a note introduction."
        elif not usable or any(row["confidence"] < 0.8 for row in [*baseline, landing]):
            change["reason"] = "Recognition was uncertain."
        elif timing is None:
            change["reason"] = "Recording continuity was not tracked."
        elif len(baseline) < 4:
            change["reason"] = "Play four notes before the change to establish a pace."
        elif any(not row["matched"] for row in [*baseline, landing]):
            change["reason"] = "The preceding bar or landing needed a correction."
        elif any(
            baseline[0]["group"] < boundary <= landing["group"]
            for boundary in timing["interruptions"]
        ):
            change["reason"] = "Recording was interrupted during this change."
        if change["reason"]:
            continue
        periods = [
            (right["heard_at"] - left["heard_at"])
            / ((right["start"] - left["start"]) * task["bpm"] / 60)
            for left, right in pairwise(baseline)
        ]
        period = median(periods)
        if period <= 0 or any(abs(value - period) > max(0.08, period * 0.25) for value in periods):
            change["reason"] = "The first bar did not establish a steady pace."
            continue
        expected = (landing["start"] - baseline[-1]["start"]) * task["bpm"] / 60 * period
        gap = landing["heard_at"] - baseline[-1]["heard_at"]
        # Long silence cannot reliably distinguish a practice break from hesitation.
        if gap > min(POSITION_PAUSE_LIMIT, max(6, expected * 4)):
            change["reason"] = "A long pause made this change unsuitable for timing."
            continue
        if gap < expected * 0.75:
            change["reason"] = "The landing was substantially ahead of your established pulse."
            continue
        change.update(
            extra_seconds=round(max(0, gap - expected), 3),
            extra_beats=round(max(0, gap - expected) / period, 3),
            bpm=round(60 / period, 1),
        )
    return measure_landings(changes, observations, context)


def assess_reading(task, groups, context):
    target = task["target"]
    attacks = reading_attacks(target)
    observations = []
    notes = []
    strengths = []
    attempts = []
    cursor = 0
    previous = -1
    for group_index, group in enumerate(groups):
        start = min(note["start"] for note in group)
        if start < previous or cursor >= len(attacks):
            raise ValueError("Reading attacks must be chronological and end with the last target")
        previous = start
        pitches = [note["pitch"] for note in group]
        attempts.append(pitches)
        notes.extend(
            {key: note[key] for key in ("pitch", "start", "velocity")} | {"duration": 0.1}
            for note in group
        )
        strengths.extend(note["confidence"] for note in group)
        expected = [target[index]["pitch"] for index in attacks[cursor]["indices"]]
        if not matches_reading(pitches, expected):
            continue
        observations.extend(
            {
                "index": index,
                "expected": target[index]["pitch"],
                "start": target[index]["start"],
                "heard_at": start,
                "group": group_index,
                "confidence": min(note["confidence"] for note in group),
                "matched": len(attempts) == 1,
                "heard": [pitch for attempt in attempts for pitch in attempt],
                "tries": attempts,
            }
            for index in attacks[cursor]["indices"]
        )
        cursor += 1
        attempts = []
    if cursor != len(attacks):
        raise ValueError("Finish every note in the score before saving the reading")
    first_try = sum(item["matched"] for item in observations)
    accuracy = first_try / len(target)
    usable = mean(strengths) >= 0.75 and mean(value >= 0.6 for value in strengths) >= 0.8
    assisted = any(context[name] for name in ("hearings", "reveals", "hints")) or context.get(
        "introduction", False
    )
    fluency = measure_position_changes(task, observations, context, usable, assisted)
    rhythm = reading_rhythm(task, observations, context)
    assessment = {
        "version": ASSESSMENT_VERSION,
        "score": {
            "score": round(accuracy * 100),
            "pitch_accuracy": round(accuracy * 100),
            "rhythm_accuracy": rhythm["accuracy"] if task["reading"].get("rhythm_required") else None,
            "first_try": first_try,
            "total": len(target),
            "corrections": len(groups) - len(attacks),
        },
        "observations": observations,
        "evidence": [],
        "fluency": fluency,
        "rhythm": rhythm,
        "quality": {
            "usable": usable,
            "onset_support": round(mean(strengths), 3),
            "reason": "Live onset support; position-change timing is separate from pitch accuracy",
        },
        "feedback": f"{first_try} of {len(target)} notes right on the first try. Position-change timing does not change this score.",
    }
    if not usable or assisted:
        assessment["feedback"] += (
            " Introduction completed; the answer was shown, so this does not raise your reading rating."
            if context.get("introduction")
            else " Saved as assisted practice."
            if assisted
            else " Recognition was uncertain; levels were not changed."
        )
        return assessment, notes
    facets = defaultdict(list)
    for row in observations:
        value = float(row["matched"])
        facets["all", "Reading pitches"].append(value)
        facets[f"pitch:{row['expected']}", pitch_name(row["expected"], task["key"])].append(value)
        clef = target[row["index"]].get("staff", task["reading"]["clef"])
        facets[f"clef:{clef}", f"{clef.title()} clef"].append(value)
        facets[f"key:{task['key']['signature']}", task["key"]["name"]].append(value)
    labels = {
        "starts": "Finding a starting note",
        "patterns": "Following steps and skips",
        "shifts": "Reading after a position change",
    }
    for row in reading_rows(task, observations):
        facets[f"position:{row['kind']}", labels[row["kind"]]].append(row["value"])
        if row["kind"] in ("starts", "shifts"):
            facets[
                f"start:{row['pitch']}", f"Starting on {pitch_name(row['pitch'], task['key'])}"
            ].append(row["value"])
        else:
            interval = row["interval"]
            facets[f"transition:{interval}", f"Reading a {interval:+d}-semitone movement"].append(
                row["value"]
            )
    assessment["evidence"] = [
        {
            "skill": "reading.pitch",
            "facet": facet,
            "label": label,
            "value": mean(values),
            "weight": 1.0,
            "challenge": task["challenge"],
        }
        for (facet, label), values in facets.items()
    ]
    if task["reading"].get("rhythm_required") and rhythm["accuracy"] is not None:
        assessment["evidence"].append({
            "skill": "reading.rhythm", "facet": "all", "label": "Reading rhythm",
            "value": rhythm["accuracy"] / 100, "weight": 1.0, "challenge": task["challenge"],
        })
        assessment["feedback"] += f" Rhythm {rhythm['accuracy']}% at {rhythm['bpm']} BPM."
    return assessment, notes
