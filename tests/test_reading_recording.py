import json

from reading_recording import record_composition

from piano_duet.reading_stages import STAGES


def main():
    import pytest

    raise SystemExit(pytest.main([__file__]))


def test_record_composition_covers_every_stage_and_seeded_context():
    for stage in STAGES:
        for seed in (0, 7):
            context = None if seed == 0 else {
                "notes": [{"pitch": 60, "start": 0, "duration": 0.5, "velocity": 76}],
                "end": 0.5,
            }
            recording = record_composition(stage, seed, context)
            events = recording["events"]
            assert any(event["type"] == "random" and event["draws"] for event in events)
            assert any(event["type"] == "note" and event["random"] for event in events)
            assert all(event["context"] == context for event in events if event["type"] == "phrase")
            assert json.loads(json.dumps(recording))["score"] == recording["score"]
            assert recording == record_composition(stage, seed, context)


if __name__ == "__main__":
    main()
