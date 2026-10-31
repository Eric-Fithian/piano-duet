"""Generate synthetic drill takes and their Python assessment results."""

import json

from tqdm import tqdm

from piano_duet.drills import DRILLS, assess_drill, build_task, rung_of, unique_target
from piano_duet.learning import compare_performance
from piano_duet.notes import Note

SCENARIOS = ('clean', 'drift', 'uneven', 'missed', 'extra', 'loudness')


def main():
    fixtures = []
    for drill, spec in tqdm(DRILLS.items(), desc='Synthetic drill plans'):
        config = {'drill': drill, 'variant': spec['variants'][0], 'tonic': 0, 'hands': spec['hands'][0],
                  'octaves': spec['octaves'][0], 'inversion': 0, 'practice': 'even'}
        task = build_task(config, rung_of(drill, *spec['start']))
        task['id'] = f'synthetic-{drill}'
        for scenario in SCENARIOS:
            notes = synthetic_take(task['target'], scenario)
            context = {'source': 'microphone'}
            quality = {'usable': True, 'reason': 'Synthetic input'}
            played = [Note.model_validate(note) for note in notes]
            assessment = assess_drill(task, played, context, quality)
            target = [Note.model_validate(note) for note in unique_target(task['target'])]
            comparison = compare_performance(target, played)
            fixtures.append({'drill': drill, 'scenario': scenario, 'task': task, 'notes': notes,
                             'context': context, 'quality': quality, 'assessment': assessment, 'comparison': comparison})
    print(json.dumps(fixtures))


def synthetic_take(target, scenario):
    end = max(note['start'] for note in target) or 1
    notes = []
    for index, original in enumerate(target):
        if scenario == 'missed' and index == len(target) // 2:
            continue
        start = original['start']
        if scenario == 'drift':
            start += 0.22 * start * start / end
        elif scenario == 'uneven' and index % 4 == 2:
            start += 0.15
        velocity = 45 if scenario == 'loudness' and index % 2 else 85
        notes.append({'pitch': original['pitch'], 'start': start + 0.5,
                      'duration': original['duration'], 'velocity': velocity})
    if scenario == 'extra':
        original = target[len(target) // 2]
        pitch = original['pitch'] + 1 if original['pitch'] < 108 else original['pitch'] - 1
        notes.append({'pitch': pitch, 'start': original['start'] + 0.45,
                      'duration': original['duration'], 'velocity': 85})
    return sorted(notes, key=lambda note: (note['start'], note['pitch']))


if __name__ == '__main__':
    main()
