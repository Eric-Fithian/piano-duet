"""Export Transkun's feature and interval-attribute networks for local inference."""

import argparse
import math
from importlib.resources import files
from pathlib import Path

import moduleconf
import torch
from torch import nn

OUTPUT = Path('.cache/models/recording-transcription/onnx-fp32')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    pretrained = files('transkun') / 'pretrained'
    config = moduleconf.parseFromFile(str(pretrained / '2.0.conf'))
    model = config['Model'].module.TransKun(conf=config['Model'].config).eval()
    checkpoint = torch.load(str(pretrained / '2.0.pt'), map_location='cpu', weights_only=False)
    model.load_state_dict(checkpoint['state_dict'])
    model.backbone.useGradientCheckpoint = False
    export(model, args.output)


class Fourier(torch.autograd.Function):
    @staticmethod
    def forward(ctx, value):
        return torch.view_as_real(torch.fft.rfft(value, norm='ortho'))

    @staticmethod
    def symbolic(graph, value):
        axes = graph.op('Constant', value_t=torch.tensor([-1], dtype=torch.long))
        complex_input = graph.op('Unsqueeze', value, axes)
        spectrum = graph.op('DFT', complex_input, axis_i=-2, inverse_i=0, onesided_i=1)
        scale = graph.op('Constant', value_t=torch.tensor(1 / 64, dtype=torch.float32))
        return graph.op('Mul', spectrum, scale)


class RecordingFeatures(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.backbone = model.backbone
        self.scorer = model.scorer
        self.spectrum = model.framewiseFeatureExtractor
        self.register_buffer('pitches', torch.tensor(model.targetMIDIPitch))
        if model.windowSize != 4096 or self.scorer.size != 256 or self.scorer.expansionFactor != 1:
            raise ValueError('This export expects the Transkun 2.0 architecture')

    def forward(self, frames):
        frames = (frames - frames.mean((1, 2, 3), keepdim=True)) / (frames.std((1, 2, 3), keepdim=True) + 1e-8)
        extractor = self.spectrum.spectrogramExtractor
        windows = torch.cat((extractor.win.unsqueeze(0), extractor.winGen.get().t()), dim=0)
        spectrum = Fourier.apply(frames.unsqueeze(-2) * windows)
        power = spectrum.square().sum(-1).transpose(-1, -2).mean(dim=-4, keepdim=True)
        mel = (power.transpose(-1, -2) @ self.spectrum.freq2mels).transpose(-1, -2)
        mel = ((mel + self.spectrum.eps).log() - math.log(self.spectrum.eps)) / -math.log(self.spectrum.eps)
        mel = mel.contiguous().view(frames.shape[0], -1, 229, 6)
        context = self.backbone(mel, self.pitches)
        query, key, diagonal = self.scorer.map(context).split([256, 256, 1], dim=-1)
        query = query / 16
        positions = torch.arange(context.shape[2], device=context.device)
        distance = (positions[:, None] - positions[None, :]).abs()
        identity = torch.eye(context.shape[2], device=context.device)
        score = (torch.matmul(query, key.transpose(-1, -2)) * distance + identity * diagonal).permute(2, 3, 0, 1)
        skip = torch.zeros_like(diagonal[:, :, 1:, 0]).permute(2, 0, 1)
        return context, score, skip


class RecordingAttributes(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.velocity = model.velocityPredictor
        self.timing = model.refinedOFPredictor

    def forward(self, start, end):
        values = torch.cat((start, end, start * end), dim=-1)
        return self.velocity(values), self.timing(values)


def export(model, output):
    output.mkdir(parents=True, exist_ok=True)
    features = RecordingFeatures(model).eval()
    attributes = RecordingAttributes(model).eval()
    frames = torch.zeros((1, 1, 45, 4096), dtype=torch.float32)
    endpoints = torch.zeros((3, 256), dtype=torch.float32)
    with torch.inference_mode():
        torch.onnx.export(features, (frames,), str(output / 'features.onnx'), input_names=['frames'],
                          output_names=['context', 'score', 'skip'],
                          dynamic_axes={'frames': {2: 'frames'}, 'context': {2: 'frames'},
                                        'score': {0: 'frames', 1: 'frames'}, 'skip': {0: 'steps'}},
                          opset_version=17, dynamo=False)
        torch.onnx.export(attributes, (endpoints, endpoints), str(output / 'attributes.onnx'),
                          input_names=['start', 'end'], output_names=['velocity', 'timing'],
                          dynamic_axes={name: {0: 'intervals'} for name in ('start', 'end', 'velocity', 'timing')},
                          opset_version=17, dynamo=False)


if __name__ == '__main__':
    main()
