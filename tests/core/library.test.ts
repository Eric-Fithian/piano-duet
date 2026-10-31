import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { editSong, revertSong, songAttacks, songSections, songStats, songSummary, songVersion } from "../../src/core/library.ts";
import type { Song, SongPlay } from "../../src/core/library.ts";

test("song edits and listening statistics match Python", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.library import edit_song, revert_song, song_attacks, song_sections, song_stats, song_version, summary
from piano_duet.score_import import build_song, parse_score
sys.path.insert(0, 'tests')
from test_library import MUSICXML
song = {'id':'synthetic-song', 'created_at':1700000000, **build_song(parse_score('idea.musicxml', MUSICXML.encode()), None, None, 'idea.musicxml')}
notes = [{'pitch': 60+i%12, 'start': i*.5, 'duration': .5, 'velocity': 80, 'staff':'treble'} for i in range(80)]
long = {**song, 'notes':notes, 'meter':'4/4', 'bpm':120, 'bars':20}
plays = [{'created_at':1, 'attacks':[[i,False] for i in range(20)], 'version':song_version(notes)},
         {'created_at':2, 'attacks':[[i,True] for i in range(40)], 'version':song_version(notes)},
         {'created_at':3, 'attacks':[[i,True] for i in range(80)], 'version':'another version'}]
slower = [{**note, 'start':note['start']*2, 'duration':note['duration']*2} for note in song['notes']]
edited = edit_song(song, song['bpm']//2, '3/4', (9,'minor'), slower)
print(json.dumps({'song': song, 'long': long, 'plays': plays, 'version': song_version(notes), 'attacks':song_attacks(notes),
                  'sections': song_sections(long), 'stats':song_stats(long, plays), 'summary':summary(long, plays),
                  'slower':slower, 'edited':edited, 'reverted':revert_song(edited)}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { song: Song; long: Song; plays: SongPlay[]; version: string; attacks: unknown; sections: unknown; stats: unknown;
    summary: unknown; slower: Song["notes"]; edited: Song; reverted: Song } = JSON.parse(reference.stdout);
  assert.equal(await songVersion(data.long.notes), data.version);
  assert.deepEqual(songAttacks(data.long.notes), data.attacks);
  assert.deepEqual(songSections(data.long), data.sections);
  assert.deepEqual(await songStats(data.long, data.plays), data.stats);
  assert.deepEqual(await songSummary(data.long, data.plays), data.summary);
  const edited = editSong(data.song, data.song.bpm / 2, "3/4", 9, "minor", data.slower);
  assert.deepEqual(edited, data.edited);
  assert.deepEqual(revertSong(edited), data.reverted);
  assert.throws(() => revertSong(data.song), { message: "This song has not been edited" });
  const offGrid = data.slower.map((note, index) => index ? note : { ...note, start: note.start + 0.01 });
  assert.throws(() => editSong(data.song, data.song.bpm / 2, "3/4", 9, "minor", offGrid),
    { message: "Every note must start and end on the score's sixteenth or triplet grid" });
});
