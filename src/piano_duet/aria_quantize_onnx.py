"""Quantize the exported Aria ONNX model to four-bit blockwise weights."""

import argparse
import logging
from pathlib import Path

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


if __name__ == "__main__":
    main()
