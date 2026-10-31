"""Quantize the exported Aria ONNX model to four-bit blockwise weights."""

import argparse
import logging
from pathlib import Path

import onnx
from onnxruntime.quantization.matmul_nbits_quantizer import (
    DefaultWeightOnlyQuantConfig,
    MatMulNBitsQuantizer,
)

from piano_duet.aria_onnx import OUTPUT

QUANTIZED = Path(".cache/models/aria/onnx-int4-block64/model.onnx")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=OUTPUT)
    parser.add_argument("--output", type=Path, default=QUANTIZED)
    parser.add_argument("--block-size", type=int, default=64)
    args = parser.parse_args()
    quantize(args.input, args.output, args.block_size)


def quantize(source, output, block_size):
    output.parent.mkdir(parents=True, exist_ok=True)
    logging.getLogger("onnxruntime.quantization.matmul_nbits_quantizer").setLevel(logging.WARNING)
    config = DefaultWeightOnlyQuantConfig(block_size=block_size, is_symmetric=False, op_types_to_quantize=("MatMul",))
    quantizer = MatMulNBitsQuantizer(str(source), algo_config=config)
    quantizer.process()
    quantizer.model.save_model_to_file(str(output), use_external_data_format=True)
    model = onnx.load(str(output), load_external_data=False)
    rewrite_attention_nan_checks(model)
    onnx.save(model, str(output))


def rewrite_attention_nan_checks(model):
    softmax_outputs = {name for node in model.graph.node if node.op_type == "Softmax" for name in node.output}
    existing = {name for node in model.graph.node for name in node.output}
    existing.update(item.name for item in model.graph.input)
    existing.update(item.name for item in model.graph.initializer)
    nodes = []
    rewritten = 0
    for node in model.graph.node:
        if node.op_type != "IsNaN":
            nodes.append(node)
            continue
        if len(node.input) != 1 or len(node.output) != 1 or node.input[0] not in softmax_outputs:
            raise ValueError("Unexpected Aria NaN check outside an attention softmax")
        equal = node.output[0] + "_self_equal"
        if equal in existing:
            raise ValueError("Aria NaN rewrite would duplicate a graph value")
        nodes.append(onnx.helper.make_node("Equal", [node.input[0], node.input[0]], [equal], name=node.name + "_self_equal"))
        nodes.append(onnx.helper.make_node("Not", [equal], list(node.output), name=node.name + "_not"))
        rewritten += 1
    if not rewritten:
        raise ValueError("The Aria graph has no attention NaN checks")
    del model.graph.node[:]
    model.graph.node.extend(nodes)


if __name__ == "__main__":
    main()
