"""Check published model files against saved reference choices and outputs."""

import json
from importlib.resources import files
from pathlib import Path

import moduleconf
import numpy as np
import onnx
import onnxruntime as ort
import torch
from tqdm import tqdm
from transkun.Util import makeFrame

from piano_duet.aria_sampling_parity import compare, distribution, summarize

ROOT = Path('.cache/ci-models')
FIXTURES = Path('tests/fixtures')


def main():
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    print(json.dumps({'aria': aria_parity(options), 'live_transcription': live_parity(options),
                      'recording_transcription': recording_parity(options)}, indent=2))


def aria_parity(options):
    model = ROOT / 'aria/model.onnx'
    session = ort.InferenceSession(str(model), options, providers=['CPUExecutionProvider'])
    names = [item.name for item in session.get_inputs()]
    fixture = json.loads((FIXTURES / 'aria-sampling.json').read_text())
    if len(fixture['cases']) < 50:
        raise ValueError('At least 50 masked choices are required')
    results = []
    for case in tqdm(fixture['cases'], desc='Aria masked parity'):
        tokens = np.array([case['tokens']], dtype=np.int64)
        cache = [np.zeros((1, 24, 0, 64), dtype=np.float32) for _ in range(32)]
        logits = session.run(['logits'], dict(zip(names, [tokens, *cache], strict=True)))[0][0, -1]
        weights = np.asarray(case['weights'])
        reference = distribution(np.asarray(case['fp32_logits']), weights)
        mlx = distribution(np.asarray(case['mlx_logits']), weights)
        actual = distribution(logits[np.asarray(case['allowed'])], weights)
        k = int(min(10, np.count_nonzero(reference), np.count_nonzero(mlx), np.count_nonzero(actual)))
        mlx_kl, mlx_overlap = compare(reference, mlx, k)
        onnx_kl, onnx_overlap = compare(reference, actual, k)
        results.append({'mlx_kl': mlx_kl, 'onnx_kl': onnx_kl,
                        'mlx_top_k_overlap': mlx_overlap, 'onnx_top_k_overlap': onnx_overlap})
    summary = {name: summarize(results, name) for name in ('mlx', 'onnx')}
    limits = {metric: 1.1 * summary['mlx'][metric] for metric in ('mean_kl', 'p95_kl')}
    if not all(summary['onnx'][metric] <= summary['mlx'][metric] and summary['onnx'][metric] <= limits[metric]
               for metric in limits):
        raise AssertionError(f'Aria masked parity failed: {summary}')
    return {'contexts': len(results), 'summary': summary, 'limits': limits}


def live_parity(options):
    folder = ROOT / 'live-transcription'
    graph = ort.InferenceSession(str(folder / 'graph.onnx'), options, providers=['CPUExecutionProvider'])
    convolution = ort.InferenceSession(str(folder / 'convolution.onnx'), options, providers=['CPUExecutionProvider'])
    recurrent = ort.InferenceSession(str(folder / 'recurrent.onnx'), options, providers=['CPUExecutionProvider'])
    fixture = np.load(FIXTURES / 'live-transcription.npz')
    audio = fixture['audio'][None]
    original = onnx.load(str(ROOT / 'live-reference/piano_crnn.onnx'))
    dimension = original.graph.input[0].type.tensor_type.shape.dim[1]
    if dimension.dim_value != 160000:
        raise ValueError('Unexpected original transcription window')
    dimension.ClearField('dim_value')
    dimension.dim_param = 'samples'
    reference = ort.InferenceSession(original.SerializeToString(), options, providers=['CPUExecutionProvider'])
    names = ['reg_onset', 'frame', 'velocity']
    expected = reference.run(names, {reference.get_inputs()[0].name: audio})
    full = graph.run(names, {graph.get_inputs()[0].name: audio})
    intermediate = convolution.run(None, {convolution.get_inputs()[0].name: audio})
    split = recurrent.run(names, dict(zip([item.name for item in convolution.get_outputs()], intermediate, strict=True)))
    errors = {}
    for name, original_output, complete, partitioned in zip(names, expected, full, split, strict=True):
        np.testing.assert_allclose(complete, original_output, atol=0.00005, rtol=0.00005)
        np.testing.assert_allclose(partitioned, original_output, atol=0.00005, rtol=0.00005)
        errors[name] = {'full_max': float(np.max(np.abs(complete - original_output))),
                        'split_max': float(np.max(np.abs(partitioned - original_output))),
                        'fixture_max': float(np.max(np.abs(original_output - fixture[name])))}
    return errors


def recording_parity(options):
    torch.set_num_threads(4)
    pretrained = files('transkun') / 'pretrained'
    config = moduleconf.parseFromFile(str(pretrained / '2.0.conf'))
    model = config['Model'].module.TransKun(conf=config['Model'].config).eval()
    checkpoint = torch.load(str(pretrained / '2.0.pt'), map_location='cpu', weights_only=False)
    model.load_state_dict(checkpoint['state_dict'])
    model.backbone.useGradientCheckpoint = False
    rate = 44100
    time = np.arange(2 * rate, dtype=np.float32) / rate
    audio = np.zeros_like(time)
    for onset, frequency in ((0.25, 261.625565), (0.75, 311.126984), (1.25, 369.994423)):
        local = time - onset
        mask = (local >= 0) & (local < 0.5)
        for harmonic in range(1, 7):
            audio[mask] += (0.2 / harmonic * np.sin(2 * np.pi * frequency * harmonic * local[mask])
                            * np.exp(-local[mask] * (3 + harmonic)))
    frames = makeFrame(torch.from_numpy(audio[None]), model.hopSize, model.windowSize).unsqueeze(0)
    with torch.inference_mode():
        reference, context = model.processFramesBatch(frames)
    graph = ort.InferenceSession(str(ROOT / 'recording-transcription/features.onnx'), options, providers=['CPUExecutionProvider'])
    actual_context, score, skip = graph.run(None, {'frames': frames.numpy()})
    np.testing.assert_allclose(actual_context, context.numpy(), atol=0.005, rtol=0.005)
    decoded = type(reference)(torch.from_numpy(score).flatten(-2), torch.from_numpy(skip).flatten(-2))
    expected = reference.decode(forcedStartPos=[0] * 90)
    actual = decoded.decode(forcedStartPos=[0] * 90)
    if expected != actual:
        raise AssertionError('Published Transkun interval paths differ from the reference')
    count = sum(map(len, expected))
    if not count:
        raise AssertionError('Synthetic piano fixture produced no Transkun intervals')
    with torch.inference_mode():
        start, end, _, _ = model.fetchIntervalFeaturesBatch(context, [expected])
        features = torch.cat((start, end, start * end), dim=-1)
        velocity, timing = model.velocityPredictor(features).numpy(), model.refinedOFPredictor(features).numpy()
    attributes = ort.InferenceSession(str(ROOT / 'recording-transcription/attributes.onnx'), options, providers=['CPUExecutionProvider'])
    actual_velocity, actual_timing = attributes.run(None, {'start': start.numpy(), 'end': end.numpy()})
    np.testing.assert_allclose(actual_velocity, velocity, atol=0.0001, rtol=0.0001)
    np.testing.assert_allclose(actual_timing, timing, atol=0.0001, rtol=0.0001)
    return {'intervals': count, 'matching_tracks': len(expected), 'context_max': float(np.max(np.abs(actual_context - context.numpy()))),
            'velocity_max': float(np.max(np.abs(actual_velocity - velocity))), 'timing_max': float(np.max(np.abs(actual_timing - timing)))}


if __name__ == '__main__':
    main()
