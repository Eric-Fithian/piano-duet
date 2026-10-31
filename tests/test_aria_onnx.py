import numpy as np
import onnx
import onnxruntime as ort
import pytest
import torch
from aria.model import ModelConfig, TransformerLM

from piano_duet.aria_onnx import CachedAria, export
from piano_duet.aria_quantize_onnx import quantize, rewrite_attention_nan_checks


def main():
    raise SystemExit(pytest.main([__file__]))


def test_cached_export_matches_torch_for_prefill_and_incremental_tokens(tmp_path):
    torch.manual_seed(7)
    config = ModelConfig(d_model=32, n_heads=4, n_layers=2, ff_mult=2, drop_p=0,
                         max_seq_len=32, grad_checkpoint=False, vocab_size=64)
    reference = TransformerLM(config).eval()
    cached = CachedAria(reference, config).eval()
    path = tmp_path / "aria.onnx"
    export(cached, path)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    tokens = torch.tensor([[3, 12, 24, 4, 7, 21]])
    cache = [np.zeros((1, config.n_heads, 0, config.d_model // config.n_heads), dtype=np.float32)
             for _ in range(config.n_layers * 2)]
    inputs = [item.name for item in session.get_inputs()]
    with torch.inference_mode():
        expected = reference(tokens).numpy()
    collected = []
    for chunk in (tokens[:, :3], tokens[:, 3:4], tokens[:, 4:]):
        result = session.run(None, dict(zip(inputs, [chunk.numpy(), *cache], strict=True)))
        collected.append(result[0])
        cache = result[1:]
    np.testing.assert_allclose(np.concatenate(collected, axis=1), expected, atol=2e-5, rtol=2e-5)
    assert all(value.shape[2] == tokens.shape[1] for value in cache)


def test_quantized_export_runs_with_cache_and_keeps_logits_close(tmp_path):
    torch.manual_seed(19)
    config = ModelConfig(d_model=32, n_heads=4, n_layers=2, ff_mult=2, drop_p=0,
                         max_seq_len=32, grad_checkpoint=False, vocab_size=64)
    reference = TransformerLM(config).eval()
    source = tmp_path / "aria.onnx"
    output = tmp_path / "quantized" / "aria.onnx"
    export(CachedAria(reference, config).eval(), source)
    quantize(source, output, 32)
    operations = [node.op_type for node in onnx.load(str(output)).graph.node]
    assert "MatMulNBits" in operations
    assert "IsNaN" not in operations
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    tokens = torch.tensor([[3, 12, 24, 4, 7, 21]])
    cache = [np.zeros((1, config.n_heads, 0, config.d_model // config.n_heads), dtype=np.float32)
             for _ in range(config.n_layers * 2)]
    inputs = [item.name for item in session.get_inputs()]
    with torch.inference_mode():
        expected = reference(tokens).numpy()
    collected = []
    for chunk in (tokens[:, :3], tokens[:, 3:]):
        result = session.run(None, dict(zip(inputs, [chunk.numpy(), *cache], strict=True)))
        collected.append(result[0])
        cache = result[1:]
    np.testing.assert_allclose(np.concatenate(collected, axis=1), expected, atol=0.2, rtol=0.15)


def test_attention_nan_rewrite_preserves_fully_masked_rows():
    x = onnx.helper.make_tensor_value_info("x", onnx.TensorProto.FLOAT, [2, 2])
    y = onnx.helper.make_tensor_value_info("y", onnx.TensorProto.FLOAT, [2, 2])
    zero = onnx.helper.make_tensor("zero", onnx.TensorProto.FLOAT, [], [0])
    nodes = [onnx.helper.make_node("Softmax", ["x"], ["probabilities"], axis=-1),
             onnx.helper.make_node("IsNaN", ["probabilities"], ["missing"], name="attention_nan"),
             onnx.helper.make_node("Where", ["missing", "zero", "probabilities"], ["y"])]
    model = onnx.helper.make_model(onnx.helper.make_graph(nodes, "attention", [x], [y], [zero]),
                                   opset_imports=[onnx.helper.make_opsetid("", 18)], ir_version=10)
    inputs = {"x": np.array([[-np.inf, -np.inf], [1, 2]], dtype=np.float32)}
    expected = ort.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"]).run(None, inputs)[0]
    rewrite_attention_nan_checks(model)
    onnx.checker.check_model(model)
    actual = ort.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"]).run(None, inputs)[0]
    np.testing.assert_array_equal(actual, expected)
    np.testing.assert_array_equal(actual[0], [0, 0])


if __name__ == "__main__":
    main()
