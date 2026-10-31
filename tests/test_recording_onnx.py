from importlib.resources import files

import moduleconf
import numpy as np
import onnxruntime as ort
import pytest
import torch
from transkun.Util import makeFrame

from piano_duet.recording_onnx import RecordingAttributes, export


def main():
    raise SystemExit(pytest.main([__file__]))


def test_transkun_export_matches_feature_and_interval_heads(tmp_path):
    torch.set_num_threads(4)
    pretrained = files('transkun') / 'pretrained'
    config = moduleconf.parseFromFile(str(pretrained / '2.0.conf'))
    model = config['Model'].module.TransKun(conf=config['Model'].config).eval()
    checkpoint = torch.load(str(pretrained / '2.0.pt'), map_location='cpu', weights_only=False)
    model.load_state_dict(checkpoint['state_dict'])
    model.backbone.useGradientCheckpoint = False
    export(model, tmp_path)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    features = ort.InferenceSession(str(tmp_path / 'features.onnx'), options, providers=['CPUExecutionProvider'])
    attributes = ort.InferenceSession(str(tmp_path / 'attributes.onnx'), options, providers=['CPUExecutionProvider'])
    generator = torch.Generator().manual_seed(1904)
    for sample_count in (24000, 44100):
        samples = torch.randn((1, sample_count), generator=generator)
        frames = makeFrame(samples, model.hopSize, model.windowSize).unsqueeze(0)
        with torch.inference_mode():
            reference, context = model.processFramesBatch(frames)
        actual_context, score, skip = features.run(None, {'frames': frames.numpy()})
        np.testing.assert_allclose(actual_context, context.numpy(), atol=0.001, rtol=0.001)
        np.testing.assert_allclose(score.squeeze(2), reference.score.numpy(), atol=0.05, rtol=0.001)
        np.testing.assert_allclose(skip.squeeze(1), reference.noiseScore.numpy(), atol=1e-7)
        decoded = type(reference)(torch.from_numpy(score).flatten(-2), torch.from_numpy(skip).flatten(-2))
        assert decoded.decode(forcedStartPos=[0] * 90) == reference.decode(forcedStartPos=[0] * 90)
    start = torch.randn((7, 256), generator=generator)
    end = torch.randn((7, 256), generator=generator)
    with torch.inference_mode():
        expected_velocity, expected_timing = RecordingAttributes(model).eval()(start, end)
    actual_velocity, actual_timing = attributes.run(None, {'start': start.numpy(), 'end': end.numpy()})
    np.testing.assert_allclose(actual_velocity, expected_velocity.numpy(), atol=2e-5, rtol=2e-5)
    np.testing.assert_allclose(actual_timing, expected_timing.numpy(), atol=2e-5, rtol=2e-5)


if __name__ == '__main__':
    main()
