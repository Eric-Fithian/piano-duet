import json
import struct
from html.parser import HTMLParser
from uuid import uuid4

import numpy as np
import pytest
from defusedxml import EntitiesForbidden
from test_practice_flow import HEADERS, client  # noqa: F401

from piano_duet.library import song_attacks, song_sections, song_stats, song_version
from piano_duet.notes import Note
from piano_duet.score_import import ScoreError, build_song, parse_score

MUSICXML = """<?xml version="1.0"?>
<score-partwise><work><work-title>Idea 10</work-title></work><part id="P1">
<measure number="0" implicit="yes">
  <attributes><divisions>2</divisions><key><fifths>-1</fifths><mode>major</mode></key>
    <time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
  <sound tempo="80"/>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><staff>1</staff></note>
  <backup><duration>2</duration></backup>
  <note><rest/><duration>2</duration><staff>2</staff></note>
</measure>
<measure number="1">
  <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff><tie type="start"/></note>
  <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note>
  <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff><tie type="stop"/></note>
  <backup><duration>8</duration></backup>
  <note><pitch><step>B</step><alter>-1</alter><octave>2</octave></pitch><duration>8</duration><staff>2</staff></note>
</measure></part></score-partwise>"""


def main():
    raise SystemExit(pytest.main([__file__]))


def track(events):
    body = b"".join(events) + b"\x00\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(body)) + body


def two_hand_midi():
    header = b"MThd" + struct.pack(">IHHH", 6, 1, 3, 480)
    tempo = track([b"\x00\xff\x51\x03\x07\xa1\x20", b"\x00\xff\x58\x04\x03\x02\x18\x08", b"\x00\xff\x59\x02\x01\x00"])
    # Running status repeats 0x90 for the second note; velocity 0 ends a note.
    right = track([b"\x00\x90\x4c\x50", b"\x83\x60\x4c\x00", b"\x00\x4f\x50", b"\x83\x60\x4f\x00"])
    left = track([b"\x00\x90\x2b\x50", b"\x87\x40\x80\x2b\x00"])
    return header + tempo + right + left


def test_midi_import_separates_hands_and_reads_tempo_meter_and_key():
    song = build_song(parse_score("idea.mid", two_hand_midi()), None, "Gibran Alcocer", "idea.mid")
    assert (song["bpm"], song["meter"], song["key"]["name"], song["bars"]) == (120, "3/4", "G major", 1)
    assert [(note["pitch"], note["staff"], note["start"]) for note in song["notes"]] == [
        (43, "bass", 0.0), (76, "treble", 0.0), (79, "treble", 0.5)]
    assert song["notes"][0]["duration"] == 1.0
    assert song["title"] == "idea"


def test_musicxml_import_keeps_staves_chords_ties_and_pickup_alignment():
    song = build_song(parse_score("idea.musicxml", MUSICXML.encode()), None, None, "idea.musicxml")
    assert (song["title"], song["bpm"], song["key"]["name"], song["bars"]) == ("Idea 10", 80, "F major", 2)
    beat = 60 / 80
    assert [(note["pitch"], note["staff"], round(note["start"] / beat, 3), round(note["duration"] / beat, 3)) for note in song["notes"]] == [
        (72, "treble", 3.0, 1.0), (46, "bass", 4.0, 4.0), (65, "treble", 4.0, 4.0), (69, "treble", 4.0, 2.0)]
    assert [len(attack) for attack in song_attacks(song["notes"])] == [1, 3]


def test_musicxml_with_a_doctype_imports_but_entity_declarations_are_refused():
    doctype = ('<?xml version="1.0"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
               '"http://www.musicxml.org/dtds/partwise.dtd">')
    with_doctype = MUSICXML.replace('<?xml version="1.0"?>', doctype, 1)
    assert parse_score("idea.musicxml", with_doctype.encode()) == parse_score("idea.musicxml", MUSICXML.encode())
    # Nested entities expand exponentially, so a small file could exhaust memory.
    bomb = ('<?xml version="1.0"?><!DOCTYPE score-partwise [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>'
            "<score-partwise>&b;</score-partwise>")
    with pytest.raises(EntitiesForbidden):
        parse_score("bomb.musicxml", bomb.encode())


def test_two_single_staff_parts_are_the_right_then_left_hand():
    two_parts = """<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part>
      <part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>"""
    notes = parse_score("hands.musicxml", two_parts.encode())["notes"]
    assert [(note["pitch"], note["staff"]) for note in notes] == [(48, "treble"), (67, "bass")]


def test_unsupported_files_fail_with_a_reason():
    with pytest.raises(ScoreError, match="MIDI"):
        parse_score("idea.pdf", b"%PDF")
    with pytest.raises(ScoreError, match="standard MIDI"):
        parse_score("idea.mid", b"nope")
    changing = MUSICXML.replace('<measure number="1">', '<measure number="1"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>')
    with pytest.raises(ScoreError, match="changes time signature"):
        build_song(parse_score("idea.xml", changing.encode()), None, None, "idea.xml")


def test_stats_use_recent_plays_and_sections_track_their_own_attacks():
    notes = [{"pitch": 60 + i % 12, "start": i * 0.5, "duration": 0.5, "velocity": 80, "staff": "treble"} for i in range(80)]
    song = {"notes": notes, "meter": "4/4", "bpm": 120, "bars": 20}
    sections = song_sections(song)
    assert [(section["label"], section["start"], section["end"]) for section in sections] == [
        ("Bars 1–8", 0, 32), ("Bars 9–16", 32, 64), ("Bars 17–20", 64, 80)]
    version = song_version(notes)
    plays = [{"created_at": 1, "attacks": [[i, False] for i in range(20)], "version": version},
             {"created_at": 2, "attacks": [[i, True] for i in range(40)], "version": version},
             {"created_at": 3, "attacks": [[i, True] for i in range(80)], "version": "other notes"}]
    stats = song_stats(song, plays)
    assert (stats["plays"], stats["best"], stats["coverage"], stats["accuracy"]) == (2, 100, 50, 67)
    assert [section["accuracy"] for section in stats["sections"]] == [62, 100, None]


def test_library_imports_lists_scores_plays_and_deletes_songs(client):  # noqa: F811
    library = client.get("/api/library").json()
    assert library["songs"] == [] and any(item["title"] == "Idea 10" for item in library["catalog"])
    response = client.post("/api/library/import?filename=idea.musicxml&artist=Gibran%20Alcocer", content=MUSICXML.encode(), headers=HEADERS)
    assert response.status_code == 200
    song = response.json()
    assert (song["title"], song["plays"], song["accuracy"]) == ("Idea 10", 0, None)
    library = client.get("/api/library").json()
    assert [item["id"] for item in library["songs"]] == [song["id"]]
    assert all(item["title"] != "Idea 10" for item in library["catalog"])
    play = {"id": str(uuid4()), "attacks": [[0, True], [1, False]]}
    stats = client.post(f"/api/library/{song['id']}/plays", json=play, headers=HEADERS).json()
    assert (stats["plays"], stats["accuracy"], stats["coverage"]) == (1, 50, 100)
    assert client.post(f"/api/library/{song['id']}/plays", json={**play, "id": str(uuid4()), "attacks": [[2, True]]}, headers=HEADERS).status_code == 400
    bad = client.post("/api/library/import?filename=idea.pdf", content=b"%PDF", headers=HEADERS)
    assert bad.status_code == 400 and "idea.pdf" in bad.json()["detail"]
    assert client.delete(f"/api/library/{song['id']}", headers=HEADERS).status_code == 200
    assert client.get(f"/api/library/{song['id']}").status_code == 404



def test_a_song_can_be_retimed_rekeyed_edited_and_reverted(client):  # noqa: F811
    song = client.post("/api/library/import?filename=idea.musicxml", content=MUSICXML.encode(), headers=HEADERS).json()
    full = client.get(f"/api/library/{song['id']}").json()
    play = {"id": str(uuid4()), "attacks": [[0, True], [1, True]]}
    assert client.post(f"/api/library/{song['id']}/plays", json=play, headers=HEADERS).json()["plays"] == 1
    # Half the tempo doubles every time; with no note added or removed, plays still describe the song.
    slower = [{**note, "start": note["start"] * 2, "duration": note["duration"] * 2} for note in full["notes"]]
    edit = {"bpm": full["bpm"] // 2, "meter": "3/4", "tonic": 9, "mode": "minor", "notes": slower}
    assert client.put(f"/api/library/{song['id']}", json=edit).status_code == 403
    edited = client.put(f"/api/library/{song['id']}", json=edit, headers=HEADERS).json()
    assert (edited["bpm"], edited["meter"], edited["key"]["name"]) == (40, "3/4", "A minor")
    assert edited["stats"]["plays"] == 1 and edited["original"]["meter"] == "4/4"
    # Removing a note changes the version: the earlier play refers to the old positions.
    fewer = client.put(f"/api/library/{song['id']}", json={**edit, "notes": slower[1:]}, headers=HEADERS).json()
    assert fewer["stats"]["plays"] == 0 and len(fewer["notes"]) == len(slower) - 1
    off_grid = [{**slower[0], "start": slower[0]["start"] + 0.01}, *slower[1:]]
    assert client.put(f"/api/library/{song['id']}", json={**edit, "notes": off_grid}, headers=HEADERS).status_code == 400
    reverted = client.post(f"/api/library/{song['id']}/revert", headers=HEADERS).json()
    assert (reverted["meter"], reverted["bpm"], len(reverted["notes"])) == ("4/4", full["bpm"], len(full["notes"]))
    # Back on the original notes, the original's play counts again.
    assert "original" not in reverted and reverted["stats"]["plays"] == 1
    assert client.post(f"/api/library/{song['id']}/revert", headers=HEADERS).status_code == 400
    assert client.delete(f"/api/library/{song['id']}").status_code == 403


if __name__ == "__main__":
    main()


class Recording:
    def __init__(self, notes):
        self.notes = notes

    def transcribe(self, audio, cancel, on_progress):
        on_progress(1)
        return self.notes


def test_youtube_import_transcribes_arranges_and_saves_a_song(client, monkeypatch):  # noqa: F811
    fetched = []

    def fetch(url, on_progress, cancel):
        on_progress(0.5)
        fetched.append(url)
        return np.zeros(44100, dtype=np.float32), {"id": "abc", "title": "A recording", "channel": "A pianist", "url": url}

    def score(notes):
        if len(notes) < 8:
            raise ScoreError("Too few piano notes were recognized to write a score")
        return {"notes": [{"pitch": note.pitch, "beat": i / 2, "length": 0.5, "velocity": 80, "staff": "treble"} for i, note in enumerate(notes)],
                "meters": [(0, "4/4")], "measures": [0.0, 4.0], "bpm": 90, "key": None, "title": None, "composer": None, "pickup": 0}

    monkeypatch.setattr("piano_duet.server.fetch_audio", fetch)
    monkeypatch.setattr("piano_duet.server.performance_to_score", score)
    recording = Recording([Note(pitch=60 + i % 12, start=i * 0.3, duration=0.3, velocity=80) for i in range(16)])
    monkeypatch.setattr("piano_duet.server.RecordingTranscriber", lambda: recording)
    response = client.post("/api/library/youtube", json={"url": "https://youtu.be/abc", "has_rights": True}, headers=HEADERS)
    events = [json.loads(line) for line in response.text.splitlines()]
    assert [event["type"] for event in events] == ["downloading", "transcribing", "arranging", "song"]
    song = events[-1]["song"]
    assert (song["title"], song["artist"], song["meter"]) == ("A recording", "A pianist", "4/4")
    assert client.get(f"/api/library/{song['id']}").json()["url"] == "https://youtu.be/abc"
    assert client.post("/api/library/youtube", json={"url": "https://example.com/v", "has_rights": True}, headers=HEADERS).json()["detail"] == "Paste a link to a single YouTube video"
    recording.notes = recording.notes[:3]
    failed = [json.loads(line) for line in client.post("/api/library/youtube", json={"url": "https://www.youtube.com/watch?v=abc", "has_rights": True}, headers=HEADERS).text.splitlines()]
    assert failed[-1] == {"type": "error", "message": "Too few piano notes were recognized to write a score"}
    assert not client.app.state.busy


def test_youtube_import_needs_the_player_to_confirm_their_rights_first(client, monkeypatch):  # noqa: F811
    fetched = []
    monkeypatch.setattr("piano_duet.server.fetch_audio", lambda *args, **kwargs: fetched.append(args))
    for payload in ({"url": "https://youtu.be/abc"}, {"url": "https://youtu.be/abc", "has_rights": False}):
        assert client.post("/api/library/youtube", json=payload, headers=HEADERS).status_code == 422
    assert not fetched


def test_a_transcription_uses_its_main_meter_and_aligns_bars_after_a_pickup():
    parsed = {"notes": [{"pitch": 60, "beat": 0.0, "length": 1.0, "velocity": 80, "staff": "treble"},
                        {"pitch": 64, "beat": 1.0, "length": 3.0, "velocity": 80, "staff": "treble"},
                        {"pitch": 67, "beat": 4.0, "length": 3.0, "velocity": 80, "staff": "treble"}],
              "meters": [(0, "1/4"), (1, "3/4")], "measures": [0, 1, 4], "bpm": 60, "key": (0, "major"), "title": None, "composer": None, "pickup": 0}
    with pytest.raises(ScoreError, match="changes time signature"):
        build_song(parsed, "t", None, "t.musicxml")
    song = build_song(parsed, "t", None, "YouTube", transcribed=True)
    assert song["meter"] == "3/4"
    assert [note["start"] for note in song["notes"]] == [2.0, 3.0, 6.0]


def test_rhythms_finer_than_the_score_can_draw_are_rounded_onto_its_grid():
    notes = [{"pitch": 60 + i, "beat": beat, "length": length, "velocity": 80, "staff": "treble"}
             for i, (beat, length) in enumerate([(0, 1 / 6), (1 / 6, 1 / 6), (1 / 3, 2 / 3), (1, 1 / 3), (4 / 3, 1 / 3), (5 / 3, 1 / 3), (2.125, 0.125)])]
    parsed = {"notes": notes, "meters": [(0, "4/4")], "bpm": 60, "key": (0, "major"), "title": None, "composer": None, "pickup": 0}
    song = build_song(parsed, "t", None, "t.xml")
    ticks = [(round(note["start"] * 12), round(note["duration"] * 12)) for note in song["notes"]]
    # Beat one (onsets at 0, 2 and 4 ticks) fits sixteenths; beat two (0, 4, 8) is a triplet; the 32nd rounds down.
    assert ticks == [(0, 3), (3, 3), (3, 9), (12, 4), (16, 4), (20, 4), (24, 3)]
    compound = build_song({**parsed, "meters": [(0, "12/8")]}, "t", None, "t.xml")
    assert all(round(note["start"] * 12) % 3 == 0 for note in compound["notes"])


def test_a_transcription_written_in_values_finer_than_the_grid_is_rewritten_at_double_tempo():
    run = [{"pitch": 60 + i % 5, "beat": 1 + i / 8, "length": 1 / 8, "velocity": 80, "staff": "treble"} for i in range(16)]
    chord = [{"pitch": pitch, "beat": 0.0, "length": 1.0, "velocity": 80, "staff": "treble"} for pitch in (72, 76)]
    parsed = {"notes": chord + run, "meters": [(0, "3/4")], "measures": [0, 3], "bpm": 38, "key": (0, "major"), "title": None, "composer": None, "pickup": 0}
    song = build_song(parsed, "t", None, "YouTube", transcribed=True)
    # Rounding 32nds onto sixteenths would sound each pair of the run together; doubling keeps every note its own onset.
    assert song["bpm"] == 76
    assert len({note["start"] for note in song["notes"]}) == 17
    assert [round(note["start"], 6) for note in song["notes"]][2:4] == [round(60 / 76 * 2, 6), round(60 / 76 * 2.25, 6)]
    # A lone ornament in a score drawn on the grid leaves the values as written.
    grace = [{"pitch": 64, "beat": 2.125, "length": 0.125, "velocity": 80, "staff": "treble"}]
    quarters = [{"pitch": 60 + i, "beat": float(i), "length": 1.0, "velocity": 80, "staff": "treble"} for i in range(60)]
    assert build_song({**parsed, "notes": quarters + grace, "bpm": 90}, "t", None, "YouTube", transcribed=True)["bpm"] == 90


def test_a_transcription_keeps_its_timing_when_its_tempo_or_meter_is_outside_what_the_score_draws():
    quarters = [{"pitch": 60 + i % 12, "beat": float(i), "length": 1.0, "velocity": 80, "staff": "treble"} for i in range(16)]
    parsed = {"notes": quarters, "meters": [(0, "4/8")], "measures": [float(b) for b in range(0, 16, 2)], "bpm": 300, "key": (0, "major"), "title": None, "composer": None, "pickup": 0}
    with pytest.raises(ScoreError, match="4/8 time is not supported"):
        build_song(parsed, "t", None, "t.musicxml")
    song = build_song(parsed, "t", None, "YouTube", transcribed=True)
    # 300 bpm is written as eighths at 150 rather than clamped, so every note still sounds when it was played.
    assert (song["meter"], song["bpm"]) == ("2/4", 150)
    assert [round(note["start"], 6) for note in song["notes"]] == [round(i * 60 / 300, 6) for i in range(16)]


GRACE_MUSICXML = """<?xml version="1.0"?>
<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>
<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
<note><grace slash="yes"/><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>
<note><pitch><step>G</step><octave>5</octave></pitch><duration>3</duration><voice>1</voice><type>half</type><dot/><staff>1</staff></note>
<backup><duration>4</duration></backup>
<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><type>whole</type><staff>2</staff></note>
</measure></part></score-partwise>"""


def test_a_grace_note_is_kept_on_the_beat_of_the_note_it_ornaments():
    parsed = parse_score("grace.musicxml", GRACE_MUSICXML.encode())
    song = build_song({**parsed, "bpm": 60}, "t", None, "YouTube", transcribed=True)
    grace = next(note for note in song["notes"] if note.get("grace"))
    main = next(note for note in song["notes"] if note["pitch"] == 79)
    # Written on the main note's grid position, so the song stays editable; playback sounds it just before.
    assert (grace["pitch"], grace["start"], grace["staff"]) == (78, main["start"], "treble")
    assert grace["duration"] > 0 and not any(note.get("grace") for note in song["notes"] if note is not grace)
    assert [note["pitch"] for note in song["notes"] if not note.get("grace")] == [48, 72, 79]


def test_mac_import_menu_contains_only_supported_actions(client):  # noqa: F811
    class ImportMenu(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_menu = False
            self.controls = []

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "details" and attrs.get("id") == "importMenu":
                self.in_menu = True
            if self.in_menu and tag in ("button", "input"):
                self.controls.append(attrs.get("id"))

        def handle_endtag(self, tag):
            if tag == "details" and self.in_menu:
                self.in_menu = False

    menu = ImportMenu()
    menu.feed(client.get("/").text)
    assert menu.controls == ["chooseScore", "libraryFile", "openYoutube"]
