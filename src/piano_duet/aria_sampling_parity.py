"""Compare masked sampling distributions against the full-precision Aria model."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from aria.config import load_model_config
from aria.model import ModelConfig, TransformerLM
from safetensors.torch import load_file
from tqdm import tqdm

from piano_duet.aria_onnx import CachedAria
from piano_duet.aria_quantize_onnx import QUANTIZED
from piano_duet.aria_sampling_fixture import OUTPUT
from piano_duet.assets import WEIGHTS

RESULT = Path(".cache/models/aria/onnx-int4-block64/sampling-parity.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=QUANTIZED)
    parser.add_argument("--output", type=Path, default=RESULT)
    args = parser.parse_args()
    fixture = json.loads(OUTPUT.read_text())
    config = ModelConfig(**load_model_config("medium"))
    with torch.device("meta"):
        original = TransformerLM(config)
    original.load_state_dict(load_file(WEIGHTS), strict=True, assign=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = CachedAria(original.eval().to(device), config).eval().to(device)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"])
    names = [item.name for item in session.get_inputs()]
    results = []
    for case in tqdm(fixture["cases"], desc="Comparing sampling distributions"):
        tokens = np.array([case["tokens"]], dtype=np.int64)
        cache = [np.zeros((1, config.n_heads, 0, config.d_model // config.n_heads), dtype=np.float32)
                 for _ in range(config.n_layers * 2)]
        with torch.inference_mode():
            tensors = [torch.from_numpy(item).to(device) for item in [tokens, *cache]]
            reference = model(*tensors)[0][0, -1].cpu().numpy()
        converted = session.run(["logits"], dict(zip(names, [tokens, *cache], strict=True)))[0][0, -1]
        allowed = np.array(case["allowed"])
        weights = np.array(case["weights"])
        baseline = distribution(reference[allowed], weights)
        mlx = distribution(np.array(case["mlx_logits"])[allowed], weights)
        onnx = distribution(converted[allowed], weights)
        k = int(min(10, np.count_nonzero(baseline), np.count_nonzero(mlx), np.count_nonzero(onnx)))
        mlx_kl, mlx_overlap = compare(baseline, mlx, k)
        onnx_kl, onnx_overlap = compare(baseline, onnx, k)
        results.append({"context": case["context"], "prefix_tokens": len(case["tokens"]),
                        "choices": len(allowed), "k": k, "mlx_kl": mlx_kl, "onnx_kl": onnx_kl,
                        "mlx_top_k_overlap": mlx_overlap, "onnx_top_k_overlap": onnx_overlap})
    if len(results) < 50:
        raise ValueError("Sampling parity needs at least 50 contexts")
    summary = {name: summarize(results, name) for name in ("mlx", "onnx")}
    # KL is in nats after the app's min-p cutoff, with 1e-12 smoothing for removed tokens.
    limits = {"mean_kl": 1.1 * summary["mlx"]["mean_kl"], "p95_kl": 1.1 * summary["mlx"]["p95_kl"]}
    passed = all(summary["onnx"][metric] <= summary["mlx"][metric]
                 and summary["onnx"][metric] <= limits[metric] for metric in limits)
    args.output.write_text(json.dumps({"device": device, "summary": summary, "limits": limits, "passed": passed,
                                       "results": results, "workloads": fixture["workloads"]}, indent=2) + "\n")
    print(json.dumps({"summary": summary, "limits": limits, "passed": passed}, indent=2))
    if not passed:
        raise AssertionError("ONNX sampling distributions did not meet the aggregate parity limits")


def distribution(logits, weights):
    scores = logits.astype(np.float64) / 0.95 + np.log(weights)
    scores -= np.max(scores)
    values = np.where(scores >= math.log(0.035), np.exp(scores), 0)
    return values / values.sum()


def compare(reference, candidate, k):
    # Min-p can remove different tokens; smoothing makes the KL penalty finite and reproducible.
    epsilon = 1e-12
    p = np.maximum(reference, epsilon)
    q = np.maximum(candidate, epsilon)
    p /= p.sum()
    q /= q.sum()
    kl = float(np.sum(p * np.log(p / q)))
    baseline = set(np.argsort(reference)[-k:])
    actual = set(np.argsort(candidate)[-k:])
    return kl, len(baseline & actual) / k


def summarize(results, name):
    values = sorted(row[f"{name}_kl"] for row in results)
    return {"mean_kl": float(np.mean(values)), "p95_kl": values[math.ceil(0.95 * len(values)) - 1],
            "mean_top_k_overlap": float(np.mean([row[f"{name}_top_k_overlap"] for row in results]))}


if __name__ == "__main__":
    main()
