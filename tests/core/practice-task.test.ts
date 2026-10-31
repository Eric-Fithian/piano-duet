import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generatePracticeTask } from "../../src/core/practice-task.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("practice tasks replay Python choices across focuses, levels and repairs", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import copy, json, sys
from unittest.mock import patch
sys.path.insert(0, 'tests')
from piano_duet.practice import next_task
from piano_duet.profile import build_profile
from piano_duet.key_tracking import MusicalKey
from reading_recording import RecordingRandom
class Store:
    def __init__(self, profile, pieces, attempts):
        self.p, self.pieces_, self.attempts_ = profile, pieces, attempts
    def profile(self): return self.p
    def pieces(self): return self.pieces_
    def attempts(self): return self.attempts_
    def add_task(self, task, fingerprint=None): pass
key = MusicalKey(0, 'major').to_dict()
piece = {'id':'piece', 'title':'Study', 'key':key, 'challenge':1, 'bpm':60, 'notes':[{'pitch':60,'start':0,'duration':1,'velocity':76}]}
cases = []
for focus in ('technique', 'theory', 'ear', 'repertoire'):
  for level in range(5):
    for seed in range(3):
      profile = build_profile([], now=1000000)
      for skill in profile['skills']:
        skill['level'] = level
        skill['attempts'] = 2 if focus == 'theory' and seed == 1 and skill['id'] == 'theory.chords' else 0
      attempts = [{'prompt':{'piece_id':'piece'}, 'notes':[{'pitch':60}], 'excluded':False}] if focus == 'repertoire' and seed == 1 else []
      events = []
      with patch('piano_duet.practice.uuid4', return_value='task'):
        task = next_task(Store(copy.deepcopy(profile), [piece], attempts), focus, RecordingRandom(seed, events))
      cases.append({'profile':profile, 'focus':focus, 'pieces':[piece], 'attempts':attempts, 'events':events, 'task':task})
profile = build_profile([], now=1000000)
last = {'created_at': 999999, 'context': {'family':'theory','hearings':0,'reveals':0,'hints':0}, 'assessment': {'score':{'score':50}, 'evidence':[{'skill':'theory.chords','facet':'all','value':0.5}], 'observations':[{'expected':60},{'expected':64},{'expected':67}]}, 'key':key, 'shape':'chord', 'excluded':False}
profile['practice_recent'] = [last]
events = []
with patch('piano_duet.practice.uuid4', return_value='task'):
  task = next_task(Store(copy.deepcopy(profile), [piece], []), 'guided', RecordingRandom(0, events))
cases.append({'profile':profile,'focus':'guided','pieces':[piece],'attempts':[],'events':events,'task':task})
profile = build_profile([], now=1000000)
for skill in profile['skills']:
  if skill['id'] == 'technique.chords':
    skill['conditions'] = [{'id':'chord:60,64,67', 'accuracy':45, 'attempts':2}]
last = {'created_at':999999, 'context':{'family':'repertoire','hearings':0,'reveals':0,'hints':0},
        'assessment':{'score':{'score':60}, 'evidence':[{'skill':'technique.chords','facet':'all','value':0.4},
          {'skill':'technique.chords','facet':'chord:60,64,67','value':0.4}], 'observations':[]},
        'key':key, 'shape':'melody', 'excluded':False}
profile['practice_recent'] = [last]
profile['recent'] = [last]
events = []
with patch('piano_duet.practice.uuid4', return_value='task'):
  task = next_task(Store(copy.deepcopy(profile), [piece], []), 'guided', RecordingRandom(0, events))
cases.append({'profile':profile,'focus':'guided','pieces':[piece],'attempts':[],'events':events,'task':task})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 30_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { profile: Parameters<typeof generatePracticeTask>[0]; focus: Parameters<typeof generatePracticeTask>[1];
    pieces: Parameters<typeof generatePracticeTask>[5]; attempts: Parameters<typeof generatePracticeTask>[6]; events: ReplayEvent[];
    task: ReturnType<typeof generatePracticeTask> }[] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 62);
  for (const [index, item] of cases.entries()) {
    const replay = new ReadingReplay(item.events);
    const task = generatePracticeTask(item.profile, item.focus, "task", replay, 1000000, item.pieces, item.attempts);
    assert.deepEqual(task, item.task, `case ${index}: ${item.focus}`);
    replay.finish();
  }
});
