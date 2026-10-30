from statistics import mean, median

from piano_duet.reading_music import SHIFT_RATE, varied_options
from piano_duet.reading_rewards import level_progress, score_xp, stage_clear_xp
from piano_duet.reading_stages import curriculum_progress

WHITE_KEYS = [pitch for pitch in range(21, 109) if pitch % 12 in (0, 2, 4, 5, 7, 9, 11)]
VOCABULARIES = {
    "treble": [60, 62, 64, 65, 67, 69, 71, 72, 74, 76],
    "bass": [48, 50, 52, 53, 55, 57, 59],
}
READING_SKILLS = (
    (
        "starts",
        "Find your starting note",
        "Find a note on the keyboard without a preceding note to guide you.",
    ),
    ("patterns", "Read steps and skips", "Follow the movement between notes in a fresh phrase."),
    (
        "shifts",
        "Move between positions",
        "Find a fresh starting point at the next bar, then continue reading.",
    ),
)
POSITION_PAUSE_LIMIT = 10
BARS = 4
FLUENCY_ALPHA = 1 - 2 ** (-1 / 5)


def main():
    print("Reading grows through fresh phrases, varied starting positions, and small shifts.")


def white_name(pitch):
    return {0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B"}[pitch % 12] + str(
        pitch // 12 - 1
    )


def reading_rows(prompt, observations):
    segments = prompt.get("reading", {}).get("segments", [0])
    clef = prompt.get("reading", {}).get("clef")
    previous = {}
    for row in observations:
        index = row["index"]
        pitch = row["expected"]
        start = index in segments
        staff = prompt["target"][index].get("staff") or (clef if clef in VOCABULARIES else "treble" if pitch >= 60 else "bass")
        yield {
            "pitch": pitch,
            "clef": staff,
            "kind": "shifts" if start and staff in previous else "starts" if start else "patterns",
            "interval": None if start else pitch - previous.get(staff, pitch),
            "value": float(row["matched"]),
        }
        previous[staff] = pitch


def summarize(rows):
    recent = rows[-32:]
    accuracy = round(100 * mean(row["value"] for row in recent)) if recent else None
    contexts = {(row["pitch"], row["interval"]) for row in recent}
    attempts = len({row["attempt"] for row in recent})
    ready = (
        accuracy is not None
        and accuracy >= 85
        and len(recent) >= 6
        and attempts >= 3
        and len(contexts) >= 3
    )
    return {
        "accuracy": accuracy,
        "samples": len(rows),
        "attempts": attempts,
        "ready": ready,
        "status": "Steady"
        if ready
        else "New"
        if not recent
        else "Needs practice"
        if attempts >= 3 and accuracy < 70
        else "Building",
    }


def fluency_average(rows, field):
    if not rows:
        return None
    value = rows[0][field]
    for row in rows[1:]:
        value += FLUENCY_ALPHA * (row[field] - value)
    return round(value, 2)


def measure_landings(changes, observations, context):
    measured = []
    timing = context.get("reading_timing")
    for change in changes:
        index = change["index"]
        landing = observations[index]
        previous = next((row for row in reversed(observations[:index]) if row["start"] < landing["start"]), None)
        if previous is None:
            continue
        gap = landing["heard_at"] - previous["heard_at"]
        reason = None
        if context.get("introduction", False):
            reason = "Note introductions show the answer."
        elif timing is None:
            reason = "Recording continuity was not tracked."
        elif min(previous["confidence"], landing["confidence"]) < 0.8:
            reason = "Recognition at the change was uncertain."
        elif any(
            previous["group"] < boundary <= landing["group"] for boundary in timing["interruptions"]
        ):
            reason = "Recording was interrupted during this change."
        elif gap <= 0:
            reason = "The two attacks could not be timed separately."
        elif gap > POSITION_PAUSE_LIMIT:
            reason = "A long pause made this change unsuitable for timing."
        measured.append(
            {
                **change,
                "arrival_seconds": round(gap, 3) if reason is None else None,
                "arrival_reason": reason,
            }
        )
    return measured


def filter_fluency(changes, field):
    by_pitch = {}
    excluded = set()
    for index, change in enumerate(changes):
        if change["arrival_seconds"] is None or change["arrival_seconds"] > POSITION_PAUSE_LIMIT:
            excluded.add(index)
        else:
            by_pitch.setdefault((change["clef"], change["pitch"]), []).append((index, change))
    for rows in by_pitch.values():
        for position, (index, change) in enumerate(rows):
            nearby = rows[max(0, position - 10) : position + 11]
            if len(nearby) < 5:
                continue
            values = [row[field] for _, row in nearby]
            center = median(values)
            deviation = median(abs(value - center) for value in values)
            ceiling = center + max(1.5, 4 * 1.4826 * deviation)
            # Exclude isolated spikes, but keep repeated slow landings as genuine practice evidence.
            neighbors = rows[max(0, position - 1) : position] + rows[position + 1 : position + 2]
            if change[field] > ceiling and not any(row[field] > ceiling for _, row in neighbors):
                excluded.add(index)
    return [row for index, row in enumerate(changes) if index not in excluded], excluded


def summarize_fluency(changes):
    timed = [change for change in changes if change["extra_seconds"] is not None]
    measured, outliers = filter_fluency(timed, "extra_seconds")
    arrivals = [change for change in changes if change["arrival_seconds"] is not None]
    landings, landing_outliers = filter_fluency(arrivals, "arrival_seconds")
    window = min(20, len(measured) // 2) if len(measured) >= 10 else len(measured)
    recent = measured[-window:] if window else []
    earlier = measured[-2 * window : -window] if len(measured) >= 10 else []
    contexts = {}
    for change in measured:
        key = (change["pitch"], change["finger"], change["shift_steps"])
        contexts.setdefault(key, []).append(change)
    return {
        "samples": len(measured),
        "untimed": len(changes) - len(timed),
        "outliers": len(outliers),
        "recent_samples": len(recent),
        "extra_seconds": fluency_average(recent, "extra_seconds"),
        "extra_beats": fluency_average(recent, "extra_beats"),
        "bpm": round(fluency_average(recent, "bpm")) if recent else None,
        "previous_seconds": fluency_average(earlier, "extra_seconds"),
        "previous_beats": fluency_average(earlier, "extra_beats"),
        "landings": [
            {
                "pitch": pitch,
                "samples": len(rows := [row for row in landings if row["pitch"] == pitch]),
                "arrival_seconds": fluency_average(rows, "arrival_seconds"),
                "outliers": sum(arrivals[index]["pitch"] == pitch for index in landing_outliers),
            }
            for pitch in sorted({row["pitch"] for row in arrivals})
        ],
        "transitions": [
            {
                "pitch": pitch,
                "finger": finger,
                "shift_steps": shift,
                "samples": len(rows),
                "extra_beats": round(median(row["extra_beats"] for row in rows[-5:]), 2),
            }
            # Later stages leave fingering to the player, so a change may have no suggested finger.
            for (pitch, finger, shift), rows in sorted(contexts.items(), key=lambda item: (item[0][0], item[0][1] or 0, item[0][2]))
        ],
    }


def reading_progress(attempts):
    rows = []
    changes = []
    rounds = []
    score_xps = {}
    introduced = {clef: set() for clef in VOCABULARIES}
    for attempt in attempts:
        if attempt["excluded"] or attempt["context"]["source"] != "microphone":
            continue
        if attempt["prompt"]["family"] != "reading":
            continue
        assessment = attempt["assessment"]
        if attempt["context"].get("interaction") == "step_by_step":
            score_xps[attempt["id"]] = score_xp(attempt["prompt"], assessment, attempt["context"])["total"]
        changes.extend(
            measure_landings(
                assessment.get("fluency", []),
                assessment["observations"],
                attempt["context"],
            )
        )
        introduction = attempt["prompt"].get("reading", {}).get("introduce")
        if introduction is not None:
            introduced[attempt["prompt"]["reading"]["clef"]].add(introduction)
        if not any(item["skill"] == "reading.pitch" for item in assessment["evidence"]):
            continue
        current = [
            dict(row, attempt=attempt["id"])
            for row in reading_rows(attempt["prompt"], assessment["observations"])
        ]
        rows.extend(current)
        rounds.append(
            {
                "id": attempt["id"],
                "accuracy": round(100 * mean(row["value"] for row in current)),
                "rhythm": assessment.get("rhythm", {}).get("accuracy"),
                "xp": score_xps.get(attempt["id"], 0),
                "stage": attempt["prompt"].get("reading", {}).get("stage_number", 1),
                "at": attempt["created_at"],
            }
        )
    hands = {}
    for clef, vocabulary in VOCABULARIES.items():
        hand_rows = [row for row in rows if row["clef"] == clef]
        measured_pitches = sorted(set(vocabulary) | {row["pitch"] for row in hand_rows})
        by_pitch = {
            str(pitch): summarize([row for row in hand_rows if row["pitch"] == pitch])
            for pitch in measured_pitches
        }
        starts = {
            str(pitch): summarize(
                [
                    row
                    for row in hand_rows
                    if row["pitch"] == pitch and row["kind"] in ("starts", "shifts")
                ]
            )
            for pitch in measured_pitches
        }
        size = 3
        while size < len(vocabulary) and all(
            by_pitch[str(pitch)]["samples"] >= 3 and by_pitch[str(pitch)]["accuracy"] >= 85
            for pitch in vocabulary[:size]
        ):
            size += 1
        hands[clef] = {
            "samples": len(hand_rows),
            "vocabulary": vocabulary[:size],
            "pitches": by_pitch,
            "starting_pitches": starts,
            "introduced": sorted(introduced[clef]),
            "fluency": summarize_fluency([change for change in changes if change["clef"] == clef]),
            "movements": {
                str(interval): summarize([row for row in hand_rows if row["interval"] == interval])
                for interval in {
                    row["interval"] for row in hand_rows if row["interval"] is not None
                }
            },
            **{
                kind: summarize([row for row in hand_rows if row["kind"] == kind])
                for kind, _, _ in READING_SKILLS
            },
        }
    skills = [
        {
            "id": kind,
            "label": label,
            "description": description,
            **summarize([row for row in rows if row["kind"] == kind]),
            "hands": {clef: hands[clef][kind] for clef in hands},
            "ready": all(hands[clef][kind]["ready"] for clef in hands),
        }
        for kind, label, description in READING_SKILLS
    ]
    recent = rows[-32:]
    earlier = rows[-64:-32]
    change = (
        round(100 * (mean(row["value"] for row in recent) - mean(row["value"] for row in earlier)))
        if len(earlier) >= 16
        else None
    )
    curriculum = curriculum_progress(attempts)
    cleared = sum(stage_clear_xp(stage["number"]) for stage in curriculum["path"] if stage["status"] == "Complete")
    return {
        "curriculum": curriculum,
        "xp": level_progress(sum(score_xps.values()) + cleared),
        "hands": hands,
        "skills": skills,
        "rounds": len(rounds),
        "notes": len(rows),
        "accuracy": round(100 * mean(row["value"] for row in recent)) if recent else None,
        "change": change,
        "history": rounds[-12:],
        "current": next((item["id"] for item in skills if not item["ready"]), "shifts"),
        "introductions": sum(len(pitches) for pitches in introduced.values()),
    }


def choose_pitch(pitches, stats, rng):
    weights = [
        1
        + (100 - (stats[str(pitch)]["accuracy"] or 0)) / 20
        + 3 / (1 + stats[str(pitch)]["samples"])
        for pitch in pitches
    ]
    return rng.choices(pitches, weights=weights)[0]


def position_choices(pitches, previous=None):
    indices = [WHITE_KEYS.index(pitch) for pitch in pitches]
    choices = list(range(max(0, max(indices) - 4), min(indices) + 1))
    if previous in choices and len(choices) > 1:
        choices.remove(previous)
    return choices


def hand_position(pitches, rng, previous=None):
    return rng.choice(position_choices(pitches, previous))


def choose_position_change(hand, clef, previous, rng):
    fluency = hand["fluency"]
    fluent = hand["shifts"]["ready"] and fluency["samples"] >= 5 and fluency["extra_beats"] <= 0.25
    needs = {
        (row["pitch"], row["finger"], row["shift_steps"]): row["extra_beats"]
        for row in fluency["transitions"]
        if row["samples"] >= 3
    }
    choices, weights = [], []
    for pitch in hand["vocabulary"]:
        nearby = sorted(
            hand["vocabulary"],
            key=lambda note: abs(WHITE_KEYS.index(note) - WHITE_KEYS.index(pitch)),
        )[:3]
        for low in position_choices(nearby, previous):
            if low == previous:
                continue
            finger = WHITE_KEYS.index(pitch) - low + 1
            if clef == "bass":
                finger = 6 - finger
            shift = low - previous
            stats = hand["starting_pitches"][str(pitch)]
            need = 1 + (100 - (stats["accuracy"] or 0)) / 20 + 3 / (1 + stats["samples"])
            need *= 1 + min(3, needs.get((pitch, finger, shift), 0))
            need *= 1 + min(5, abs(shift)) / 5 if fluent else 1 / (1 + abs(shift))
            choices.append((pitch, low))
            weights.append(need)
    if not choices:
        raise ValueError("The reading vocabulary has no playable position change")
    return rng.choices(choices, weights=weights)[0]


def reading_candidate(progress, rng, phrase, previous=None, variation=0, repair=False, teach=False, context=None):
    hands = progress["hands"]
    # Balance clefs while returning to a recently weak hand more often.
    clef = min(hands, key=lambda name: (hands[name]["samples"], name == "bass"))
    weak = [
        name
        for name, hand in hands.items()
        if any(
            hand[kind]["accuracy"] is not None and hand[kind]["accuracy"] < 70
            for kind in ("starts", "patterns")
        )
        or any(
            row["samples"] >= 3 and row["extra_beats"] > 0.5
            for row in hand["fluency"]["transitions"]
        )
    ]
    if weak and (repair or rng.random() < 0.65):
        clef = rng.choice(weak)
    hand = hands[clef]
    vocabulary = hand["vocabulary"]
    if progress["curriculum"]["target_number"] == 1:
        vocabulary = vocabulary[:3]
        hand = {**hand, "vocabulary": vocabulary}
    starts_ready = hand["starts"]["ready"]
    patterns_ready = hand["patterns"]["ready"]
    focus = (
        "shifts"
        if starts_ready and patterns_ready and rng.random() < 0.5
        else "starts"
        if not starts_ready or rng.random() < 0.3
        else "patterns"
    )
    priority = choose_pitch(
        vocabulary, hand["starting_pitches"] if focus == "starts" else hand["pitches"], rng
    )
    introduction = (
        next(
            (
                pitch
                for pitch in vocabulary
                if pitch not in hand["introduced"] and not hand["pitches"][str(pitch)]["samples"]
            ),
            None,
        )
        if teach and variation == 0
        else None
    )
    max_step = (
        2
        if hand["patterns"]["accuracy"] is not None
        and hand["patterns"]["accuracy"] >= 85
        and hand["patterns"]["samples"] >= 6
        else 1
    )
    length = 4
    if introduction is not None:
        priority, length, focus = introduction, 1, "starts"
    positions = []
    notes = []
    segments = []
    previous_low = (
        previous["reading"]["positions"][-1]["low"]
        if previous and previous.get("reading") and previous["reading"]["clef"] == clef
        else None
    )
    # Plan the landings before writing, so a bar can avoid a triple repeat across the bar line. A melody shifts
    # hand position at least once; its other bars shift at the composer's usual rate, and otherwise stay put
    # with Aria choosing their first note too. Introductions show their note with a finger in every bar.
    required = rng.randrange(1, BARS)
    plan = []
    for segment in range(BARS):
        if segment and introduction is None and segment != required and rng.random() >= SHIFT_RATE:
            plan.append((None, previous_low))
            continue
        if segment and introduction is None:
            priority, low = choose_position_change(hand, clef, previous_low, rng)
        else:
            possible = (
                [introduction]
                if introduction is not None
                else sorted(
                    vocabulary,
                    key=lambda pitch: abs(WHITE_KEYS.index(pitch) - WHITE_KEYS.index(priority)),
                )[:3]
            )
            low = hand_position(possible, rng, previous_low)
        if segment and low == plan[-1][1]:
            raise ValueError("A position change must move the hand")
        plan.append((priority, low))
        previous_low = low
    # Introductions show single notes, so only a melody needs Aria.
    session = phrase(rng, context) if introduction is None else None
    melody = []
    for segment, (priority, low) in enumerate(plan):
        pool = [pitch for pitch in vocabulary if low <= WHITE_KEYS.index(pitch) <= low + 4]
        following = plan[segment + 1][0] if segment + 1 < len(plan) else None
        beat = segment * 4
        if priority is not None:
            if session:
                session.note(beat, {priority: 1.0}, {1.0: 1.0})
            melody.append(priority)
        for offset in range(0 if priority is None else 1, length):
            options = {}
            for pitch in pool:
                if abs(WHITE_KEYS.index(pitch) - WHITE_KEYS.index(melody[-1])) > max_step:
                    continue
                movement = hand["movements"].get(str(pitch - melody[-1]))
                need = 4 if movement is None else 1 + (100 - movement["accuracy"]) / 20
                need += (100 - (hand["pitches"][str(pitch)]["accuracy"] or 0)) / 20
                options[pitch] = need * (0.35 if pitch == melody[-1] else 1)
            # The last note also avoids three in a row with the next bar's first note.
            ahead = [following] if offset == length - 1 and melody[-1] == following else []
            options = varied_options(options, melody, ahead)
            melody.append(session.note(beat + offset, options, {1.0: 1.0})[0])
        start_index = len(notes)
        finger = None
        if priority is not None:
            segments.append(start_index)
            finger = WHITE_KEYS.index(priority) - low + 1
            if clef == "bass":
                finger = 6 - finger
            positions.append({"index": start_index, "low": low, "finger": finger})
        for offset, pitch in enumerate(melody[-length:]):
            notes.append(
                {
                    "pitch": pitch,
                    "start": beat + offset,
                    "duration": 1,
                    "velocity": 76,
                    **({"finger": finger} if offset == 0 and finger is not None else {}),
                }
            )
    labels = {kind: label for kind, label, _ in READING_SKILLS}
    instruction = {
        "starts": "Find the first note, using the suggested finger. Then read on.",
        "patterns": "Follow the steps and skips. A step moves to a neighboring white key.",
        "shifts": "Read ahead to the next bar and prepare your new hand position.",
    }[focus]
    instruction += " Move your hand when a numbered finger appears."
    title = {
        "starts": "Starting notes",
        "patterns": "Steps and skips",
        "shifts": "Changing position",
    }[focus]
    if introduction is not None:
        name = white_name(introduction)
        bottom = 64 if clef == "treble" else 43
        distance = WHITE_KEYS.index(introduction) - WHITE_KEYS.index(bottom)
        location = (
            f"{'line' if distance % 2 == 0 else 'space'} {distance // 2 + 1} from the bottom"
            if 0 <= distance <= 8
            else "below the staff"
            if distance < 0
            else "above the staff"
        )
        instruction = f"This is {name}{' (middle C)' if introduction == 60 else ''}, {location}. Play it with the numbered finger in each bar. This introduction is unscored."
        title = f"Meet {name}"
    return {
        "target": notes,
        "title": title,
        "summary": instruction,
        "instruction": instruction,
        "bpm": 60,
        "challenge": 3 if focus == "shifts" else 2 if max_step == 2 else 1,
        "reason": f"Practice {clef} clef in a fresh setting. Starting notes and intervals are assessed separately; finger choice is not graded.",
        "lesson": f"The first note is {white_name(notes[0]['pitch'])}. The number is a finger, not a note name: thumb 1 through little finger 5. Higher on the staff means farther right on the keyboard.",
        "reading": {
            "stage_id": progress["curriculum"]["target"],
            "stage_number": progress["curriculum"]["target_number"],
            "focus": focus,
            "label": labels[focus],
            "clef": clef,
            "hand": "left" if clef == "bass" else "right",
            "segments": segments,
            "bars_per_row": 2,
            "bars": BARS,
            "positions": positions,
            "vocabulary": vocabulary,
            "max_step": max_step,
            "introduce": introduction,
            **({"composition": {"method": "aria"}} if session else {}),
        },
    }
