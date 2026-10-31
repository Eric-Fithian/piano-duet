"""Export a locally supplied MIDI2ScoreTransformer checkpoint with decoder caches."""

import argparse
import sys
from pathlib import Path

import torch
from torch import nn

ROOT = Path('.cache/m2st')
sys.path.insert(0, str(ROOT / 'repo/midi2scoretransformer'))
from models.roformer import Roformer

SOURCE_STREAMS = ('onset', 'duration', 'pitch', 'velocity', 'pad')
DECODER_STREAMS = ('offset', 'downbeat', 'duration', 'pitch', 'accidental', 'keysignature', 'grace', 'trill',
                   'staccato', 'voice', 'stem', 'hand', 'pad')
OUTPUT_STREAMS = ('accidental', 'downbeat', 'duration', 'grace', 'hand', 'keysignature', 'offset', 'pitch',
                  'staccato', 'stem', 'trill', 'velocity', 'voice', 'pad')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, default=ROOT / 'MIDI2ScoreTF.ckpt')
    parser.add_argument('--output', type=Path, default=ROOT / 'onnx-public')
    args = parser.parse_args()
    model = Roformer.load_from_checkpoint(str(args.checkpoint), map_location='cpu').eval()
    export(model, args.output)


class ScoreEncoder(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, onset, duration, pitch, velocity, pad):
        streams = dict(zip(SOURCE_STREAMS, (onset, duration, pitch, velocity, pad), strict=True))
        return self.model.forward_enc(streams, attention_mask=pad)


class ScoreDecoder(nn.Module):
    def __init__(self, model, cached):
        super().__init__()
        self.model = model
        self.cached = cached

    def forward(self, encoder, encoder_pad, *values):
        streams = dict(zip(DECODER_STREAMS, values[:len(DECODER_STREAMS)], strict=True))
        past = values[len(DECODER_STREAMS):]
        cache = tuple(tuple(past[index:index + 4]) for index in range(0, len(past), 4)) if self.cached else None
        logits, present = self.model.forward_dec(streams, encoder_hidden_states=encoder, encoder_attention_mask=encoder_pad,
                                                  past_key_values=cache, use_cache=True)
        return tuple(logits[name] for name in OUTPUT_STREAMS) + tuple(tensor for layer in present for tensor in layer)


def cache_names(model):
    return tuple(f'{kind}_{index}' for index in range(model.dec_config.num_hidden_layers)
                 for kind in ('self_key', 'self_value', 'cross_key', 'cross_value'))


def decoder_start(model, length=1):
    values = []
    for name in DECODER_STREAMS:
        if name == 'pad':
            values.append(torch.zeros((1, length), dtype=torch.int64))
        else:
            values.append(torch.zeros((1, length, getattr(model.dec_config, f'out_{name}_vocab_size'))))
    return tuple(values)


def export(model, directory):
    directory.mkdir(parents=True, exist_ok=True)
    config = model.enc_config
    source = tuple(torch.zeros((1, 8, getattr(config, f'in_{name}_vocab_size'))) for name in SOURCE_STREAMS[:-1])
    source += (torch.ones((1, 8), dtype=torch.int64),)
    source_axes = {name: {1: 'source'} for name in SOURCE_STREAMS}
    source_axes['encoded'] = {1: 'source'}
    encoder = ScoreEncoder(model).eval()
    first, step = ScoreDecoder(model, False).eval(), ScoreDecoder(model, True).eval()
    encoded = torch.zeros((1, 8, config.hidden_size))
    encoder_pad = torch.ones((1, 8), dtype=torch.int64)
    tokens = decoder_start(model)
    caches = cache_names(model)
    input_names = ['encoder', 'encoder_pad'] + [f'in_{name}' for name in DECODER_STREAMS]
    output_names = [f'out_{name}' for name in OUTPUT_STREAMS] + [f'present_{name}' for name in caches]
    axes = {'encoder': {1: 'source'}, 'encoder_pad': {1: 'source'}}
    axes.update({f'present_{name}': {2: 'total' if name.startswith('self') else 'source'} for name in caches})
    with torch.inference_mode():
        torch.onnx.export(encoder, source, str(directory / 'encoder.onnx'), input_names=list(SOURCE_STREAMS),
                          output_names=['encoded'], dynamic_axes=source_axes, opset_version=17, dynamo=False)
        initial = first(encoded, encoder_pad, *tokens)
        torch.onnx.export(first, (encoded, encoder_pad, *tokens), str(directory / 'decoder-first.onnx'),
                          input_names=input_names, output_names=output_names, dynamic_axes=axes,
                          opset_version=17, dynamo=False)
        context_encoder = torch.zeros((1, 128, config.hidden_size))
        context_pad = torch.ones((1, 128), dtype=torch.int64)
        torch.onnx.export(first, (context_encoder, context_pad, *decoder_start(model, 64)),
                          str(directory / 'decoder-context.onnx'), input_names=input_names, output_names=output_names,
                          dynamic_axes=axes, opset_version=17, dynamo=False)
        cache_axes = {**axes, **{f'past_{name}': {2: 'past' if name.startswith('self') else 'source'} for name in caches}}
        torch.onnx.export(step, (encoded, encoder_pad, *tokens, *initial[len(OUTPUT_STREAMS):]),
                          str(directory / 'decoder-step.onnx'), input_names=input_names + [f'past_{name}' for name in caches],
                          output_names=output_names, dynamic_axes=cache_axes, opset_version=17, dynamo=False)


if __name__ == '__main__':
    main()
