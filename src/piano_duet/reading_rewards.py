from itertools import groupby

LEVEL_BASE = 400
LEVEL_STEP = 100
STAGE_CLEAR_BASE = 300
STAGE_CLEAR_STEP = 100


def main():
    breakdown = score_xp(
        {"reading": {"stage_number": 6, "introduce": None, "rhythm_required": True}},
        {"score": {"first_try": 12, "total": 12}, "rhythm": {"accuracy": 90}, "observations": []},
        {"hearings": 0, "reveals": 0, "hints": 0},
    )
    print(breakdown, level_progress(breakdown["total"]))


def note_value(stage_number):
    return 10 + 2 * (stage_number - 1)


def longest_streak(observations):
    # Attempts saved before chord grouping have one observation per attack.
    by_group = [
        all(row["matched"] for row in rows)
        for _, rows in groupby(observations, key=lambda row: row.get("group", row["index"]))
    ]
    best = run = 0
    for clean in by_group:
        run = run + 1 if clean else 0
        best = max(best, run)
    return best


def score_xp(prompt, assessment, context):
    # Attempts saved before the staged curriculum were foundation white-key reading.
    reading = prompt.get("reading", {})
    value = note_value(reading.get("stage_number", 1))
    if reading.get("introduce") is not None:
        items = [{"id": "introduction", "label": "New note", "xp": 3 * value}]
        return {"items": items, "total": items[0]["xp"]}
    score = assessment["score"]
    first_try, total = score["first_try"], score["total"]
    notes_xp = first_try * value
    items = [
        {"id": "first_try", "label": "First-try notes", "count": first_try, "xp": notes_xp},
        {"id": "recovered", "label": "Recovered notes", "count": total - first_try, "xp": (total - first_try) * (value // 4)},
    ]
    streak = longest_streak(assessment["observations"])
    if streak >= 4:
        items.append({"id": "streak", "label": "Best streak", "count": streak, "xp": streak * (value // 2)})
    rhythm = assessment.get("rhythm", {}).get("accuracy")
    if reading.get("rhythm_required") and rhythm is not None:
        items.append({"id": "rhythm", "label": "On the beat", "count": rhythm, "xp": round(notes_xp * rhythm / 200)})
    if total and first_try == total:
        items.append({"id": "perfect", "label": "Perfect read", "xp": round(notes_xp / 2)})
    items = [item for item in items if item["xp"] > 0]
    subtotal = sum(item["xp"] for item in items)
    if any(context[name] for name in ("hearings", "reveals", "hints")):
        items.append({"id": "assisted", "label": "Assisted", "xp": -(subtotal // 2)})
    return {"items": items, "total": sum(item["xp"] for item in items)}


def stage_clear_xp(stage_number):
    return STAGE_CLEAR_BASE + STAGE_CLEAR_STEP * (stage_number - 1)


def level_progress(xp):
    level, floor = 1, 0
    while xp >= floor + LEVEL_BASE + LEVEL_STEP * (level - 1):
        floor += LEVEL_BASE + LEVEL_STEP * (level - 1)
        level += 1
    return {
        "xp": xp,
        "level": level,
        "into": xp - floor,
        "needed": LEVEL_BASE + LEVEL_STEP * (level - 1),
    }


if __name__ == "__main__":
    main()
