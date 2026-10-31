"""Create a synthetic desktop history and emit its API responses."""

import contextlib
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from fastapi.testclient import TestClient

from piano_duet import server
from piano_duet.notes import Note
from piano_duet.reading import assess_reading
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import STAGES

sys.path.insert(0, "tests")
from reading_recording import record_composition
from test_library import MUSICXML


def main():
    path = Path(sys.argv[1])
    engine = SimpleNamespace(transcriber=SimpleNamespace(), generator=SimpleNamespace(phrase=None), notes=[])
    server.RecordingTranscriber = lambda: SimpleNamespace(transcribe=lambda audio, cancel, progress: engine.notes)
    headers = {"X-Duet-Client": "1"}
    with contextlib.redirect_stdout(io.StringIO()):
        server.SAMPLES = server.NOTATION = path.parent
        with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=path)) as client:
            store = client.app.state.store
            for seed in range(8):
                task = record_composition(STAGES[0], seed)["score"]
                task.update(family="reading", id=f"reading-{seed}")
                groups = [[{"pitch": task["target"][i]["pitch"], "start": 1 + attack["start"], "velocity": 80, "confidence": 0.95} for i in attack["indices"]] for attack in reading_attacks(task["target"])]
                context = {"source": "microphone", "interaction": "step_by_step", "hearings": 0, "reveals": 0, "hints": 0, "reading_timing": {"interruptions": []}}
                assessment, notes = assess_reading(task, groups, context)
                store.add_task(task, f"fingerprint-{seed}")
                store.record(f"reading-attempt-{seed}", {"prompt": task, "context": context, "mode": "practice", "notes": notes}, assessment, task["id"])
                if seed == 0:
                    earlier = {key: value for key, value in task.items() if key != "reading"}
                    store.record("reading-earlier", {"prompt": earlier, "context": {**context, "interaction": "live"}, "mode": "practice", "notes": notes}, assessment)
            store.exclude("reading-attempt-1", True)
            config = {"drill": "scale", "variant": "major", "tonic": 0, "hands": "right", "octaves": 1, "practice": "even"}
            listening = {"ended": "attacks", "floor": 0.0091, "noise": 0.003, "attacks": [0.22, 0.6], "strengths": [0.03, 0.02], "seconds": 1.2}
            for index in range(3):
                task = client.post("/api/drills/next", json=config, headers=headers).json()
                engine.notes = [Note.model_validate(note) for note in task["target"]]
                params = {"mode": "drills", "session": "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", "task": task["id"], "attempt": f"5cfb60dc-a9f7-4e10-9b04-033934f96d9{index}", "listening": json.dumps(listening)}
                response = client.post("/api/respond", params=params, content=np.zeros(3200, dtype="<f4").tobytes(), headers=headers)
                assert response.status_code == 200, response.text
            song = client.post("/api/library/import?filename=idea.musicxml", content=MUSICXML.encode(), headers=headers).json()
            song_id = song["id"]
            full = client.get(f"/api/library/{song_id}").json()
            play = {"id": "acfb60dc-a9f7-4e10-9b04-033934f96d90", "attacks": [[0, True], [1, False]]}
            assert client.post(f"/api/library/{song_id}/plays", json=play, headers=headers).status_code == 200
            edit = {"bpm": full["bpm"], "meter": "3/4", "tonic": 9, "mode": "minor", "notes": full["notes"]}
            assert client.put(f"/api/library/{song_id}", json=edit, headers=headers).status_code == 200
            store.add_piece({"id": "piece-synthetic", "title": "Synthetic piece", "notes": []})
            result = {name: client.get(f"/api/{name}").json() for name in ("profile", "drills", "library", "pieces")}
            result["song"] = client.get(f"/api/library/{song_id}").json()
            result["attempt"] = client.get("/api/attempts/5cfb60dc-a9f7-4e10-9b04-033934f96d90").json()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
