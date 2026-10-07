from collections import Counter, defaultdict
from itertools import pairwise
from math import exp
from statistics import median

from piano_duet.learning import compare_performance
from piano_duet.notes import Note
from piano_duet.profile import ASSESSMENT_VERSION, SKILLS


def main():
    print("Contextual performance assessment produces observations and shared skill evidence.")


def pitch_name(pitch, key=None):
    if key and pitch % 12 in key["pitch_classes"]:
        name = key["scale_names"][key["pitch_classes"].index(pitch % 12)]
        natural = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[name[0]]
        semitone = natural + name.count("#") - name.count("b")
        octave = (pitch - semitone) // 12 - 1
        return name.replace("#", "♯").replace("b", "♭") + str(octave)
    return f"{('C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B')[pitch % 12]}{pitch // 12 - 1}"


def assess(prompt, notes, context, quality):
    target = [Note.model_validate(note) for note in prompt["target"]]
    result = {
        "version": ASSESSMENT_VERSION,
        "score": None,
        "observations": [],
        "evidence": [],
        "quality": quality,
        "feedback": "Saved as musical exploration. There is no intended sequence to grade.",
    }
    if not notes:
        result["feedback"] = "No piano notes were recognized. Your levels have not changed."
        return result
    if not target:
        result["observed"] = {
            "range": [min(n.pitch for n in notes), max(n.pitch for n in notes)],
            "notes": len(notes),
            "duration": max(n.start + n.duration for n in notes),
        }
        return result
    score = compare_performance(target, notes)
    if prompt["family"] == "theory":
        score["score"] = score["pitch_accuracy"]
        score["rhythm_accuracy"] = None
    result["score"] = {key: value for key, value in score.items() if key != "alignment"}
    observations = result["observations"]
    for group in score["alignment"]:
        available = list(group["played"])
        for index in group["expected"]:
            matches = [j for j in available if notes[j].pitch == target[index].pitch]
            found = matches[0] if matches else None
            if found is not None:
                available.remove(found)
            observations.append(
                {
                    "index": index,
                    "expected": target[index].pitch,
                    "start": target[index].start,
                    "matched": found is not None,
                    "played_index": found,
                    "heard": [notes[j].pitch for j in group["played"]],
                }
            )
    observations.sort(key=lambda item: item["index"])
    if context["source"] != "microphone":
        result["feedback"] = "Demonstration only. Your levels have not changed."
        return result
    if not quality["usable"]:
        result["feedback"] = (
            "Saved, but recognition was uncertain. Check the heard notes; this attempt does not affect your levels."
        )
        return result
    family = prompt["family"]
    challenge = prompt["challenge"]
    pitch = score["pitch_accuracy"] / 100
    rhythm = score["rhythm_accuracy"]
    evidence = result["evidence"]

    def add(skill, value, facet="all", label=None, weight=1.0, level=challenge):
        if skill not in SKILLS or not 0 <= value <= 1:
            raise ValueError("Invalid skill evidence")
        evidence.append(
            {
                "skill": skill,
                "facet": facet,
                "label": label or SKILLS[skill][1],
                "value": value,
                "weight": weight,
                "challenge": level,
            }
        )

    # A wrong note in a recall task does not identify a motor error.
    execution_known = (
        family in ("technique", "repertoire")
        and (context["notation_visible"] or context["reveals"] > 0)
    ) or pitch >= 0.85
    assisted = (
        context["reveals"] > 0
        or context["hints"] > 0
        or (context["hearings"] > 0 and family != "ear")
    )
    if execution_known:
        add("technique.accuracy", pitch)
    if rhythm is not None and pitch >= 0.7:
        rhythm_value = rhythm / 100
        if prompt.get("even"):
            add("technique.evenness", rhythm_value)
        if prompt.get("bpm") and execution_known:
            speed_value = min(1, score["tempo_percent"] / 100) * pitch * rhythm_value
            add("technique.tempo", speed_value)
            add("technique.tempo", speed_value, f"bpm:{prompt['bpm']}", f"{prompt['bpm']} BPM")
    key = prompt.get("key")
    key_id = f"key:{key['signature']}" if key else None
    shape = prompt.get("shape")
    if shape == "scale" and execution_known:
        skill = "technique.scales"
        value = pitch * (0.8 + 0.2 * rhythm / 100) if rhythm is not None else pitch
        add(skill, value)
        if key_id:
            add(skill, value, key_id, key["name"])
    chord_values = []
    for group in score["alignment"]:
        if len(group["expected"]) < 2:
            continue
        expected = Counter(target[i].pitch for i in group["expected"])
        played = Counter(notes[i].pitch for i in group["played"])
        value = 2 * (expected & played).total() / (expected.total() + played.total())
        if execution_known or value >= 0.85:
            chord_values.append(value)
            pitches = sorted(expected)
            add(
                "technique.chords",
                value,
                "chord:" + ",".join(map(str, pitches)),
                " + ".join(pitch_name(pitch, key) for pitch in pitches),
            )
    if chord_values:
        value = sum(chord_values) / len(chord_values)
        add("technique.chords", value)
        if key_id:
            add("technique.chords", value, key_id, key["name"])
    if execution_known:
        for before, after in pairwise(observations):
            if before["start"] != after["start"]:
                add(
                    "technique.accuracy",
                    float(before["matched"] and after["matched"]),
                    f"transition:{before['expected']}:{after['expected']}",
                    f"{pitch_name(before['expected'], key)} → {pitch_name(after['expected'], key)}",
                )
    if prompt.get("dynamics") == "even" and pitch >= 0.85 and len(notes) >= 5:
        velocities = [n.velocity for n in notes]
        center = median(velocities)
        spread = median(abs(v - center) for v in velocities) / max(1, center)
        add("technique.dynamics", exp(-4 * spread), weight=0.4)
    reading = family == "reading" and not assisted
    ear = family == "ear" and context["hearings"] >= 1 and not context["reveals"]
    if reading or ear:
        skill = "reading.pitch" if reading else "ear.pitch"
        add(skill, pitch, weight=0.7 if ear and context["hearings"] > 1 else 1)
        if rhythm is not None:
            add("reading.rhythm" if reading else "ear.rhythm", rhythm / 100)
        if key_id:
            add(skill, pitch, key_id, key["name"])
        if reading:
            by_pitch = defaultdict(list)
            by_clef = defaultdict(list)
            for observation in observations:
                by_pitch[observation["expected"]].append(observation["matched"])
                by_clef["treble" if observation["expected"] >= 60 else "bass"].append(
                    observation["matched"]
                )
            for pitch_, outcomes in by_pitch.items():
                add(
                    skill, sum(outcomes) / len(outcomes), f"pitch:{pitch_}", pitch_name(pitch_, key)
                )
            for clef, outcomes in by_clef.items():
                add(skill, sum(outcomes) / len(outcomes), f"clef:{clef}", f"{clef.title()} clef")
            for before, after in pairwise(observations):
                interval = after["expected"] - before["expected"]
                if interval:
                    value = float(before["matched"] and after["matched"])
                    # Combine repeated features below so a long phrase cannot inflate confidence.
                    add(
                        skill,
                        value,
                        f"interval:{interval}",
                        f"{'Up' if interval > 0 else 'Down'} {abs(interval)} semitones",
                    )
    if family == "theory" and not assisted and shape in ("scale", "chord"):
        skill = "theory.scales" if shape == "scale" else "theory.chords"
        add(skill, pitch)
        add(skill, pitch, key_id, key["name"])
    if (
        family == "repertoire"
        and context["familiar"]
        and not assisted
        and not context["notation_visible"]
    ):
        add("repertoire.recall", score["score"] / 100)
        add(
            "repertoire.recall",
            score["score"] / 100,
            f"piece:{prompt['piece_id']}",
            prompt["title"],
        )
    grouped = defaultdict(list)
    for item in evidence:
        grouped[item["skill"], item["facet"]].append(item)
    result["evidence"] = [
        {**items[0], "value": sum(item["value"] for item in items) / len(items)}
        for items in grouped.values()
    ]
    mistakes = [row for row in observations if not row["matched"]]
    if mistakes:
        counts = Counter(row["expected"] for row in mistakes)
        name = pitch_name(counts.most_common(1)[0][0], key)
        feedback = f"Look at {name}: {len(mistakes)} expected notes did not match. Try a slower, steady pace."
    elif score["extra"]:
        feedback = "The target notes matched, with extra notes heard. Check the transcription before treating these as mistakes."
    elif rhythm is not None and rhythm < 85:
        feedback = "The pitches matched. Focus on keeping the spaces between the notes steady."
    elif score["tempo_percent"] < 85 and prompt.get("bpm"):
        feedback = (
            "Accurate at a slower tempo. Keep this control as you work toward the suggested speed."
        )
    else:
        feedback = "That matched well. The next exercise can explore something less familiar."
    if assisted and family in ("reading", "theory", "repertoire"):
        feedback += (
            " Help was used, so this informs execution rather than independent reading or recall."
        )
    result["feedback"] = feedback
    return result


if __name__ == "__main__":
    main()
