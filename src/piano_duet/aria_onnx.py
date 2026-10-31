"""Export Aria with explicit, growing key/value caches for browser inference."""

import argparse
from pathlib import Path

import torch
from aria.config import load_model_config
from aria.model import ModelConfig, TransformerLM
from safetensors.torch import load_file
from torch import nn
from torch.nn import functional as F

from piano_duet.assets import WEIGHTS

OUTPUT = Path(".cache/models/aria/onnx-fp32/model.onnx")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    config = ModelConfig(**load_model_config("medium"))
    with torch.device("meta"):
        model = TransformerLM(config)
    model.load_state_dict(load_file(WEIGHTS), strict=True, assign=True)
    export(CachedAria(model.eval(), config), args.output)


class CachedAria(nn.Module):
    def __init__(self, model, config):
        super().__init__()
        self.model = model
        self.heads = config.n_heads
        self.head_dim = config.d_model // config.n_heads
        self.layers = config.n_layers
        frequency = 1.0 / (500000 ** (torch.arange(0, self.head_dim, 2).float() / self.head_dim))
        self.register_buffer("frequency", frequency)

    def forward(self, tokens, *past):
        sequence = tokens.shape[1]
        past_length = past[0].shape[2]
        positions = torch.arange(past_length, past_length + sequence, device=tokens.device)
        angles = positions[:, None] * self.frequency[None, :]
        cosine, sine = angles.cos()[None, None], angles.sin()[None, None]
        mask = torch.arange(past_length + sequence, device=tokens.device)[None, :] <= positions[:, None]
        x = self.model.model.tok_embeddings(tokens)
        caches = []
        for index, layer in enumerate(self.model.model.encode_layers):
            normalized = layer.norm1(x)
            query, key, value = layer.mixed_qkv(normalized).chunk(3, dim=-1)
            query, key, value = (
                tensor.reshape(tokens.shape[0], sequence, self.heads, self.head_dim).transpose(1, 2)
                for tensor in (query, key, value)
            )
            query = rotate(query, cosine, sine)
            key = rotate(key, cosine, sine)
            key = torch.cat((past[2 * index], key), dim=2)
            value = torch.cat((past[2 * index + 1], value), dim=2)
            caches.extend((key, value))
            attention = F.scaled_dot_product_attention(query, key, value, attn_mask=mask)
            x = x + layer.att_proj_linear(attention.transpose(1, 2).reshape(tokens.shape[0], sequence, -1))
            normalized = layer.norm2(x)
            x = x + layer.ff_down_proj(F.silu(layer.ff_gate_proj(normalized)) * layer.ff_up_proj(normalized))
        return (self.model.lm_head(self.model.model.out_layer_norm(x)), *caches)


def rotate(value, cosine, sine):
    first, second = value.chunk(2, dim=-1)
    return torch.cat((first * cosine - second * sine, second * cosine + first * sine), dim=-1)


def export(model, output):
    tokens = torch.tensor([[1, 2, 3]], dtype=torch.long)
    cache = tuple(torch.zeros((1, model.heads, 2, model.head_dim)) for _ in range(model.layers * 2))
    inputs = ["tokens"] + [f"past_{kind}_{index}" for index in range(model.layers) for kind in ("key", "value")]
    outputs = ["logits"] + [f"present_{kind}_{index}" for index in range(model.layers) for kind in ("key", "value")]
    axes = {"tokens": {1: "sequence"}, "logits": {1: "sequence"}}
    axes.update({name: {2: "past_sequence"} for name in inputs[1:]})
    axes.update({name: {2: "total_sequence"} for name in outputs[1:]})
    output.parent.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode():
        torch.onnx.export(model, (tokens, *cache), str(output), input_names=inputs, output_names=outputs,
                          dynamic_axes=axes, opset_version=17, dynamo=False, external_data=True)


if __name__ == "__main__":
    main()
