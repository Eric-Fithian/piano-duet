"""Compare local score outputs with the Python model's onset-jitter sensitivity."""

import argparse
import json
import math
import random
import runpy
import subprocess
import sys
from bisect import bisect_right
from collections import Counter
from pathlib import Path

ROOT = Path('.cache/m2st')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--checkpoint', type=Path, default=ROOT / 'MIDI2ScoreTF.ckpt')
    parser.add_argument('--fixture', type=Path, default=ROOT / 'score-fixture.json')
    parser.add_argument('--browser-tokens', type=Path, default=ROOT / 'browser-score-tokens.json')
    parser.add_argument('--notes', type=Path, default=ROOT / 'recording-notes.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'score-sensitivity')
    args = parser.parse_args()
    if args.worker:
        write_scores(args)
        return
    from piano_duet.notes import Note, midi_bytes
    from piano_duet.score_import import parse_musicxml

    args.output.mkdir(parents=True, exist_ok=True)
    notes = json.loads(args.notes.read_text())
    for seed in range(4):
        rng = random.Random(seed)
        perturbed = []
        for note in notes:
            start = max(0, note['start'] + rng.choice((-0.00002, 0.00002)))
            duration = note['start'] + note['duration'] - start
            perturbed.append(Note(**{**note, 'start': start, 'duration': duration}))
        (args.output / f'jitter-{seed}.mid').write_bytes(midi_bytes(perturbed))
    subprocess.run([str(ROOT / 'venv/bin/python'), '-I', str(Path(__file__)), '--worker', '--checkpoint', str(args.checkpoint),
                    '--fixture', str(args.fixture), '--browser-tokens', str(args.browser_tokens), '--output', str(args.output)], check=True)
    scores = {name: parse_musicxml((args.output / f'{name}.musicxml').read_bytes())
              for name in ('reference', 'browser', *(f'jitter-{seed}' for seed in range(4)))}
    reference = scores['reference']
    comparisons = {name: compare_scores(reference, score, name, args.output) for name, score in scores.items() if name != 'reference'}
    jitter = [comparisons[f'jitter-{seed}']['muster']['NewMeanER'] for seed in range(4)]
    jitter_f1 = [comparisons[f'jitter-{seed}']['aligned_pitch_f1'] for seed in range(4)]
    ceiling = max(jitter)
    passed = comparisons['browser']['muster']['NewMeanER'] <= ceiling and comparisons['browser']['aligned_pitch_f1'] >= min(jitter_f1)
    for field in ('key_equal', 'meters_equal', 'bars_equal'):
        passed = passed and comparisons['browser'][field]
    result = {'jitter_seconds': 0.00002, 'jitter_runs': 4, 'reference_notes': len(reference['notes']),
              'jitter_muster_new_mean_error_range': [min(jitter), ceiling], 'browser_within_jitter_spread': passed,
              'jitter_aligned_pitch_f1_range': [min(jitter_f1), max(jitter_f1)],
              'comparisons': comparisons, 'detokenizer': 'Python reference for both outputs'}
    (args.output / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    if not passed:
        raise AssertionError('Browser score agreement is outside Python onset-jitter sensitivity')


def write_scores(args):
    import torch

    sys.path.insert(0, '.cache/m2st/repo/midi2scoretransformer')
    namespace = runpy.run_path('src/piano_duet/midi_to_score.py')
    model = namespace['Roformer'].load_from_checkpoint(str(args.checkpoint), map_location='cpu').eval()
    torch.set_num_threads(4)
    reference = json.loads(args.fixture.read_text())['expected']
    browser = json.loads(args.browser_tokens.read_text())
    write_score(namespace, token_tensors(reference, model), args.output / 'reference.musicxml')
    write_score(namespace, token_tensors(browser, model), args.output / 'browser.musicxml')
    for seed in range(4):
        source = namespace['MultistreamTokenizer'].tokenize_midi(str(args.output / f'jitter-{seed}.mid'))
        torch.manual_seed(0)
        result = namespace['infer'](model, source, 'cpu')
        write_score(namespace, result, args.output / f'jitter-{seed}.musicxml')


def token_tensors(values, model):
    import torch
    from torch.nn import functional

    pad = torch.tensor(values['pad'], dtype=torch.int64)
    output = {'pad': pad.unsqueeze(-1).float()}
    for name, indexes in values.items():
        if name == 'pad':
            continue
        size = getattr(model.dec_config, f'out_{name}_vocab_size')
        output[name] = functional.one_hot(torch.tensor(indexes, dtype=torch.int64), size).float() * pad.unsqueeze(-1)
    return output


def write_score(namespace, tokens, path):
    fixed = namespace['match_key_to_spelling'](tokens)
    score = namespace['MultistreamTokenizer'].detokenize_mxl(fixed)
    namespace['postprocess_score'](score, inPlace=True).write('musicxml', fp=str(path), makeNotation=False)


def compare_scores(reference, actual, name, directory):
    def rows(score):
        return Counter((note['pitch'], round(note['beat'], 4), round(note['length'], 4), note['staff'],
                        bisect_right(score['measures'], note['beat'] + 1e-7) - 1) for note in score['notes'])

    left, right = rows(reference), rows(actual)
    matches = sum((left & right).values())
    total_reference, total_actual = sum(left.values()), sum(right.values())
    precision = matches / total_actual if total_actual else 0
    recall = matches / total_reference if total_reference else 0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
    command = ['.cache/muster/venv/bin/python', '-c',
               'from muster import muster; import json,sys; print(json.dumps(muster(sys.argv[1], sys.argv[2])))',
               str(directory / f'{name}.musicxml'), str(directory / 'reference.musicxml')]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    muster = json.loads(result.stdout)
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in muster.values()):
        raise ValueError(f'MUSTER returned invalid metrics for {name}: {muster}')
    pitch_recall = 1 - (muster['PitchER'] + muster['MissRate']) / 100
    pitch_precision = pitch_recall * (1 - muster['ExtraRate'] / 100) / (1 - muster['MissRate'] / 100)
    pitch_f1 = 2 * pitch_precision * pitch_recall / (pitch_precision + pitch_recall)
    return {'notes': total_actual, 'matched_at_absolute_beats': matches, 'absolute_beat_precision': precision,
            'absolute_beat_recall': recall, 'absolute_beat_f1': f1, 'aligned_pitch_f1': pitch_f1,
            'muster': muster, 'global_shift': global_shift(left, right, reference, actual),
            'key_equal': reference['key'] == actual['key'], 'meters_equal': reference['meters'] == actual['meters'],
            'bars_equal': len(reference['measures']) == len(actual['measures']), 'bars': len(actual['measures'])}


def global_shift(left, right, reference, actual):
    if not left or len(reference['notes']) != len(actual['notes']):
        return None
    first = next(iter(left))
    target = Counter((pitch, beat, length, staff) for (pitch, beat, length, staff, _), count in right.items() for _ in range(count))
    for candidate in right:
        if (candidate[0], candidate[2], candidate[3]) != (first[0], first[2], first[3]):
            continue
        shift = round(candidate[1] - first[1], 4)
        shifted = Counter((pitch, round(beat + shift, 4), length, staff)
                          for (pitch, beat, length, staff, _), count in left.items() for _ in range(count))
        if shifted == target:
            bars_match = [round(beat + shift, 4) for beat in reference['measures']] == [round(beat, 4) for beat in actual['measures']]
            return {'beats': shift, 'notes_only_shift': True, 'measure_boundaries_shifted_equally': bars_match}
    return None


if __name__ == '__main__':
    main()
