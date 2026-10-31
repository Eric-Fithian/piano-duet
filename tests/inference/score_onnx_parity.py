"""Compare the locally converted score model with its Python checkpoint."""

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

MODULE = Path('src/piano_duet/score_onnx.py')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, default=Path('.cache/m2st/MIDI2ScoreTF.ckpt'))
    parser.add_argument('--onnx', type=Path, default=Path('.cache/m2st/onnx-public'))
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('score_onnx', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    torch.set_num_threads(4)
    model = module.Roformer.load_from_checkpoint(str(args.checkpoint), map_location='cpu').eval()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    sessions = {name: ort.InferenceSession(str(args.onnx / f'{name}.onnx'), options, providers=['CPUExecutionProvider'])
                for name in ('encoder', 'decoder-first', 'decoder-context', 'decoder-step')}
    generator = torch.Generator().manual_seed(719)
    initial = module.ScoreDecoder(model, False).eval()
    stepper = module.ScoreDecoder(model, True).eval()
    caches = module.cache_names(model)
    names = ['encoder', 'encoder_pad'] + [f'in_{name}' for name in module.DECODER_STREAMS]
    results = []
    for length in (8, 13, 35, 83, 512):
        source = make_source(model, generator, length)
        encoder = module.ScoreEncoder(model).eval()
        with torch.inference_mode():
            encoded = encoder(*source)
        onnx_encoded = sessions['encoder'].run(None, dict(zip(module.SOURCE_STREAMS,
                                                               [item.numpy() for item in source], strict=True)))[0]
        encoder_error = float(np.max(np.abs(encoded.numpy() - onnx_encoded)))
        reference_cache = None
        actual_cache = None
        max_logits = max_cache = 0.0
        for position in range(8):
            tokens = make_decoder(model, module.DECODER_STREAMS, generator, position > 0)
            decoder = initial if position == 0 else stepper
            with torch.inference_mode():
                reference = decoder(encoded, source[-1], *tokens, *(reference_cache or ()))
            feed = dict(zip(names, [onnx_encoded, source[-1].numpy(), *(item.numpy() for item in tokens)], strict=True))
            if actual_cache is not None:
                feed.update({f'past_{name}': value for name, value in zip(caches, actual_cache, strict=True)})
            session = sessions['decoder-first' if position == 0 else 'decoder-step']
            required = {item.name for item in session.get_inputs()}
            actual = session.run(None, {name: value for name, value in feed.items() if name in required})
            error = [float(np.max(np.abs(expected.numpy() - observed))) for expected, observed in zip(reference, actual, strict=True)]
            max_logits = max(max_logits, *error[:len(module.OUTPUT_STREAMS)])
            max_cache = max(max_cache, *error[len(module.OUTPUT_STREAMS):])
            reference_cache = reference[len(module.OUTPUT_STREAMS):]
            actual_cache = actual[len(module.OUTPUT_STREAMS):]
        if max(encoder_error, max_logits, max_cache) > 0.0001:
            raise AssertionError(f'Score ONNX parity failed at source length {length}')
        results.append({'source_notes': length, 'steps': 8, 'encoder_max': encoder_error,
                        'logits_max': max_logits, 'cache_max': max_cache})
    for length in (65, 128, 512):
        source = make_source(model, generator, length)
        with torch.inference_mode():
            encoded = module.ScoreEncoder(model).eval()(*source)
        tokens = make_decoder(model, module.DECODER_STREAMS, generator, True, 64)
        with torch.inference_mode():
            reference = initial(encoded, source[-1], *tokens)
        feed = dict(zip(names, [encoded.numpy(), source[-1].numpy(), *(item.numpy() for item in tokens)], strict=True))
        session = sessions['decoder-context']
        required = {item.name for item in session.get_inputs()}
        actual = session.run(None, {name: value for name, value in feed.items() if name in required})
        errors = [float(np.max(np.abs(expected.numpy() - observed))) for expected, observed in zip(reference, actual, strict=True)]
        if max(errors) > 0.0001:
            raise AssertionError(f'Score ONNX context parity failed at source length {length}')
        results.append({'source_notes': length, 'context_tokens': 64, 'logits_max': max(errors[:len(module.OUTPUT_STREAMS)]),
                        'cache_max': max(errors[len(module.OUTPUT_STREAMS):])})
    print(json.dumps(results, indent=2))


def make_source(model, generator, length):
    config = model.enc_config
    values = []
    for name in ('onset', 'duration', 'pitch', 'velocity'):
        size = getattr(config, f'in_{name}_vocab_size')
        indices = torch.randint(size, (1, length), generator=generator)
        values.append(torch.nn.functional.one_hot(indices, size).float())
    values.append(torch.ones((1, length), dtype=torch.int64))
    return tuple(values)


def make_decoder(model, names, generator, valid, length=1):
    values = []
    for name in names:
        if name == 'pad':
            values.append(torch.full((1, length), int(valid), dtype=torch.int64))
        else:
            size = getattr(model.dec_config, f'out_{name}_vocab_size')
            if valid:
                indices = torch.randint(size, (1, length), generator=generator)
                values.append(torch.nn.functional.one_hot(indices, size).float())
            else:
                values.append(torch.zeros((1, length, size)))
    return tuple(values)


if __name__ == '__main__':
    main()
