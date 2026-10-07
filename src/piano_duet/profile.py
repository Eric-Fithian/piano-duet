import json
import sqlite3
import time
from collections import defaultdict
from contextlib import closing
from pathlib import Path

DATABASE = Path(".local/learner.sqlite3")
ASSESSMENT_VERSION = 1
SKILLS = {
    "technique.accuracy": ("Technique", "Note accuracy"),
    "technique.evenness": ("Technique", "Even timing"),
    "technique.tempo": ("Technique", "Controlled speed"),
    "technique.dynamics": ("Technique", "Even loudness"),
    "technique.scales": ("Technique", "Scale execution"),
    "technique.chords": ("Technique", "Chord execution"),
    "reading.pitch": ("Reading", "Reading pitches"),
    "reading.rhythm": ("Reading", "Reading rhythm"),
    "theory.scales": ("Theory", "Building scales"),
    "theory.chords": ("Theory", "Building chords"),
    "ear.pitch": ("Ear", "Playing back pitches by ear"),
    "ear.rhythm": ("Ear", "Playing back rhythm by ear"),
    "repertoire.recall": ("Repertoire", "Playing from memory"),
    "creating.exploration": ("Creating", "Musical exploration"),
}
FAMILIES = ("Technique", "Reading", "Theory", "Ear", "Repertoire", "Creating")


def main():
    print(json.dumps(LearnerStore().profile(), indent=2))


def summarize_evidence(rows):
    recent = rows[-12:]
    if not recent:
        return {
            "level": None,
            "accuracy": None,
            "attempts": 0,
            "confidence": "Untested",
            "last_practiced": None,
            "challenge": 1,
        }
    weight = sum(row["weight"] for row in recent)
    accuracy = sum(row["value"] * row["weight"] for row in recent) / weight
    level = 0
    for challenge in range(1, 6):
        qualifying = [row for row in recent if row["challenge"] >= challenge]
        if sum(row["value"] >= 0.85 for row in qualifying) >= 3:
            total = sum(row["weight"] for row in qualifying)
            success = sum(row["value"] * row["weight"] for row in qualifying) / total
            if success >= 0.85:
                level = challenge
    return {
        "level": level,
        "accuracy": round(100 * accuracy),
        "attempts": len(rows),
        "confidence": "Developing" if len(recent) < 6 else "Repeated evidence",
        "last_practiced": rows[-1]["at"],
        "challenge": max(row["challenge"] for row in recent),
    }


def build_profile(attempts, now=None):
    now = time.time() if now is None else now
    skills = defaultdict(list)
    facets = defaultdict(lambda: defaultdict(list))
    user_attempts = [a for a in attempts if a["context"]["source"] == "microphone"]
    included = [a for a in user_attempts if not a["excluded"]]
    for attempt in included:
        for evidence in attempt["assessment"]["evidence"]:
            item = {**evidence, "at": attempt["created_at"], "attempt_id": attempt["id"]}
            if evidence["facet"] == "all":
                skills[evidence["skill"]].append(item)
            else:
                facets[evidence["skill"]][evidence["facet"]].append(item)
    catalog = []
    for skill, (family, label) in SKILLS.items():
        conditions = [
            {"id": facet, "label": rows[-1]["label"], **summarize_evidence(rows)}
            for facet, rows in facets[skill].items()
        ]
        conditions.sort(key=lambda item: (item["accuracy"], item["attempts"], item["label"]))
        catalog.append(
            {
                "id": skill,
                "family": family,
                "label": label,
                **summarize_evidence(skills[skill]),
                "conditions": conditions,
                "coverage": {
                    "keys": sum(row["id"].startswith("key:") for row in conditions),
                    "pitches": sum(row["id"].startswith("pitch:") for row in conditions),
                },
            }
        )
    return {
        "assessment_version": ASSESSMENT_VERSION,
        "attempts": len(user_attempts),
        "included_attempts": len(included),
        "notes": sum(len(a["notes"]) for a in included),
        "days": len({time.strftime("%Y-%m-%d", time.localtime(a["created_at"])) for a in included}),
        "skills": catalog,
        "families": list(FAMILIES),
        "creative_phrases": sum(
            a["mode"] in ("duet", "learning") and not a["prompt"]["target"]
            for a in included
            if a["notes"]
        ),
        "recent": [attempt_summary(a) for a in reversed(user_attempts[-20:])],
        "practice_recent": [
            attempt_summary(a)
            for a in reversed([a for a in included if a["mode"] == "practice"][-20:])
        ],
        "generated_at": now,
    }


def attempt_summary(attempt):
    return {key: attempt[key] for key in ("id", "created_at", "mode", "excluded")} | {
        "title": attempt["prompt"]["title"],
        "shape": attempt["prompt"].get("shape"),
        "key": attempt["prompt"].get("key"),
        "note_count": len(attempt["notes"]),
        "assessment": attempt["assessment"],
        "context": attempt["context"],
    }


class LearnerStore:
    def __init__(self, path=DATABASE):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS metadata (version INTEGER NOT NULL)")
            versions = db.execute("SELECT version FROM metadata").fetchall()
            if not versions:
                db.execute("INSERT INTO metadata VALUES (1)")
            elif versions != [(1,)]:
                raise RuntimeError(
                    "Unsupported learner database version; your history was not changed"
                )
            db.execute("""CREATE TABLE IF NOT EXISTS attempts (
                id TEXT PRIMARY KEY, created_at REAL NOT NULL, inputs TEXT NOT NULL,
                assessment TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0)""")
            db.execute("""CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, created_at REAL NOT NULL, task TEXT NOT NULL,
                fingerprint TEXT, completed INTEGER NOT NULL DEFAULT 0)""")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS unseen_reading ON tasks(fingerprint)")
            db.execute("""CREATE TABLE IF NOT EXISTS pieces (
                id TEXT PRIMARY KEY, piece TEXT NOT NULL)""")

    def attempts(self):
        with closing(sqlite3.connect(self.path)) as db:
            rows = db.execute(
                "SELECT id, created_at, inputs, assessment, excluded FROM attempts ORDER BY created_at, rowid"
            ).fetchall()
        return [
            {
                "id": id_,
                "created_at": at,
                **json.loads(inputs),
                "assessment": json.loads(assessment),
                "excluded": bool(excluded),
            }
            for id_, at, inputs, assessment, excluded in rows
        ]

    def profile(self):
        return build_profile(self.attempts())

    def has_attempt(self, id_):
        with closing(sqlite3.connect(self.path)) as db:
            return db.execute("SELECT 1 FROM attempts WHERE id=?", (id_,)).fetchone() is not None

    def record(self, id_, inputs, assessment, task_id=None):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM attempts WHERE id=?", (id_,)).fetchone():
                raise ValueError("This performance has already been saved")
            if task_id and inputs["notes"]:
                changed = db.execute(
                    "UPDATE tasks SET completed=1 WHERE id=? AND completed=0", (task_id,)
                )
                if changed.rowcount != 1:
                    raise ValueError(
                        "This exercise has already been completed; choose the next exercise"
                    )
            db.execute(
                "INSERT INTO attempts VALUES (?, ?, ?, ?, 0)",
                (id_, time.time(), json.dumps(inputs), json.dumps(assessment)),
            )

    def exclude(self, id_, excluded):
        with closing(sqlite3.connect(self.path)) as db, db:
            changed = db.execute("UPDATE attempts SET excluded=? WHERE id=?", (excluded, id_))
            if changed.rowcount != 1:
                raise ValueError("Unknown performance")

    def add_task(self, task, fingerprint=None):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(
                "INSERT INTO tasks VALUES (?, ?, ?, ?, 0)",
                (task["id"], time.time(), json.dumps(task), fingerprint),
            )

    def task(self, id_):
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute("SELECT task, completed FROM tasks WHERE id=?", (id_,)).fetchone()
        return {**json.loads(row[0]), "completed": bool(row[1])} if row else None

    def aid(self, id_, kind):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT task, completed FROM tasks WHERE id=?", (id_,)).fetchone()
            if not row or row[1]:
                raise ValueError("Choose an unfinished exercise first")
            task = json.loads(row[0])
            task["context"][kind] += 1
            db.execute("UPDATE tasks SET task=? WHERE id=?", (json.dumps(task), id_))
        return task

    def reading_fingerprints(self):
        with closing(sqlite3.connect(self.path)) as db:
            return {
                row[0]
                for row in db.execute("SELECT fingerprint FROM tasks WHERE fingerprint IS NOT NULL")
            }

    def pieces(self):
        with closing(sqlite3.connect(self.path)) as db:
            return [
                json.loads(row[0]) for row in db.execute("SELECT piece FROM pieces ORDER BY rowid")
            ]

    def add_piece(self, piece):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT INTO pieces VALUES (?, ?)", (piece["id"], json.dumps(piece)))


if __name__ == "__main__":
    main()
