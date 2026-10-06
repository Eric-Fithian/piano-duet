from collections import Counter
from itertools import pairwise
from math import exp
from statistics import median

import mlx.core as mx
import numpy as np
from tqdm import tqdm

from piano_duet.notes import to_midi_dict

CONTEXT_NOTES = 512
BLOCK_NOTES = 64
CHORD_WINDOW = 0.07


def main():
    print("Learning mode scores original note prefixes and compares a replay with its target.")


def pitch_probabilities(logits, generator):
    ids = mx.array(generator.note_ids)
    probabilities = mx.softmax(logits[ids].astype(mx.float32)).tolist()
    pitches = np.zeros(88, dtype=np.float64)
    for token_id, probability in zip(generator.note_ids, probabilities, strict=True):
        pitches[generator.tokenizer.id_to_tok[token_id][1] - 21] += probability
    if not np.isfinite(pitches).all() or not np.isclose(pitches.sum(), 1, atol=1e-5):
        raise RuntimeError("Aria returned invalid pitch probabilities")
    return pitches


def analyze_phrase(generator, notes, threshold, cancel, on_note):
    if not notes or not 0 <= threshold <= 1:
        raise ValueError("Learning requires notes and a surprise threshold between 0 and 1")
    notes = sorted(notes, key=lambda n: (n.start, n.pitch))
    tokenizer = generator.tokenizer
    corrected = []
    analysis = []
    origin = notes[0].start
    original_groups = note_groups(notes)
    group_index = -1
    chord_start = -1
    chord_pitches = set()
    for block in tqdm(
        range(0, len(notes), BLOCK_NOTES), desc="Analyzing note surprise", leave=False
    ):
        if cancel.is_set():
            return None
        start = max(0, block - (CONTEXT_NOTES - BLOCK_NOTES))
        stop = min(len(notes), block + BLOCK_NOTES)
        context = notes[start:stop]
        tokens = tokenizer.tokenize(to_midi_dict(context), add_dim_tok=False, add_eos_tok=False)
        positions = [
            i for i, token in enumerate(tokens) if isinstance(token, tuple) and token[0] == "piano"
        ]
        if len(positions) != len(context):
            raise RuntimeError("Aria tokenization changed the number of played notes")
        encoded = tokenizer.encode(tokens)
        position = positions[block - start]
        generator.model.setup_cache(1, max_seq_len=len(tokens), dtype=mx.float16)
        logits = generator.model(
            mx.array([encoded[:position]]), mx.arange(position), offset=0, max_kv_pos=position - 1
        )[0, -1]
        mx.eval(logits)
        for index in range(block, stop):
            if cancel.is_set():
                return None
            note = notes[index]
            distribution = pitch_probabilities(logits, generator)
            probability = float(distribution[note.pitch - 21])
            expected = int(distribution.argmax()) + 21
            surprise = 1 - probability
            if note.start > chord_start + CHORD_WINDOW:
                chord_start = note.start
                chord_pitches = set()
                group_index += 1
            change = surprise > threshold and expected != note.pitch
            collision = change and (
                expected in chord_pitches or expected in original_groups[group_index]["pitches"]
            )
            chosen = expected if change and not collision else note.pitch
            chord_pitches.add(chosen)
            corrected.append(
                note.model_copy(update={"pitch": chosen, "start": note.start - origin})
            )
            detail = {
                "index": index,
                "start": note.start - origin,
                "played": note.pitch,
                "expected": expected,
                "corrected": chosen,
                "probability": probability,
                "expected_probability": float(distribution[expected - 21]),
                "surprise": surprise,
                "changed": chosen != note.pitch,
                "chord_collision": bool(collision),
            }
            analysis.append(detail)
            on_note(detail, (index + 1) / len(notes))
            if index + 1 == stop:
                continue
            end = positions[index + 1 - start]
            # Teacher forcing uses the original note, including its timing and velocity.
            logits = generator.model(
                mx.array([encoded[position:end]]),
                mx.arange(position, end),
                offset=position,
                max_kv_pos=end - 1,
            )[0, -1]
            mx.eval(logits)
            position = end
    return corrected, analysis


def note_groups(notes):
    groups = []
    for note in sorted(notes, key=lambda n: (n.start, n.pitch)):
        if not groups or note.start > groups[-1]["start"] + CHORD_WINDOW:
            groups.append({"start": note.start, "pitches": Counter()})
        groups[-1]["pitches"][note.pitch] += 1
    return groups


def compare_performance(target, attempt, cancel=None):
    if not target or not attempt:
        raise ValueError("Scoring requires a target and a recognized attempt")
    expected, played = note_groups(target), note_groups(attempt)
    n, m = len(expected), len(played)
    width = max(32, abs(n - m) + 4)
    previous = {0: (0, 0)}
    trace = {}
    for j in range(1, min(m, width) + 1):
        previous[j] = (previous[j - 1][0] + played[j - 1]["pitches"].total(), 0)
        trace[0, j] = "extra"
    for i in tqdm(range(1, n + 1), desc="Scoring playback", leave=False):
        if cancel is not None and cancel.is_set():
            return None
        current = {}
        a = expected[i - 1]["pitches"]
        for j in range(max(0, i - width), min(m, i + width) + 1):
            cost, matched = previous.get(j, (float("inf"), 0))
            options = [((cost + a.total(), matched), "missing")]
            if j:
                b = played[j - 1]["pitches"]
                shared = (a & b).total()
                cost = max(a.total(), b.total()) - shared
                previous_cost, matched = previous.get(j - 1, (float("inf"), 0))
                options.insert(0, ((previous_cost + cost, matched - shared), "pair"))
                previous_cost, matched = current.get(j - 1, (float("inf"), 0))
                options.append(((previous_cost + b.total(), matched), "extra"))
            current[j], trace[i, j] = min(options, key=lambda item: item[0])
        previous = current
    matches = wrong = missing = extra = 0
    pairs = []
    i, j = n, m
    while i or j:
        action = trace[i, j]
        if action == "pair":
            a, b = expected[i - 1], played[j - 1]
            shared = (a["pitches"] & b["pitches"]).total()
            misses = a["pitches"].total() - shared
            additions = b["pitches"].total() - shared
            matches += shared
            wrong += min(misses, additions)
            missing += max(0, misses - additions)
            extra += max(0, additions - misses)
            if shared:
                pairs.append((a["start"], b["start"]))
            i -= 1
            j -= 1
        elif action == "missing":
            missing += expected[i - 1]["pitches"].total()
            i -= 1
        else:
            extra += played[j - 1]["pitches"].total()
            j -= 1
    pairs.reverse()
    pitch_accuracy = 2 * matches / (len(target) + len(attempt))
    intervals = [(b[0] - a[0], b[1] - a[1]) for a, b in pairwise(pairs)]
    tempo_scale = (
        median([b / a for a, b in intervals if a > 0.07 and b > 0.07]) if intervals else 1.0
    )
    errors = [abs(b / tempo_scale - a) for a, b in intervals]
    rhythm = (
        sum(exp(-max(0, error - 0.06) / 0.18) for error in errors) / len(errors) if errors else None
    )
    score = pitch_accuracy * (0.8 + 0.2 * rhythm) if rhythm is not None else pitch_accuracy
    return {
        "score": round(100 * score),
        "pitch_accuracy": round(100 * pitch_accuracy),
        "rhythm_accuracy": round(100 * rhythm) if rhythm is not None else None,
        "matched": matches,
        "wrong": wrong,
        "missing": missing,
        "extra": extra,
        "target_notes": len(target),
        "played_notes": len(attempt),
        "tempo_percent": round(100 / tempo_scale),
        "timing_error_ms": round(1000 * sum(errors) / len(errors)) if errors else None,
    }


if __name__ == "__main__":
    main()
