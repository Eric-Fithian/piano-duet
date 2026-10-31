"""Split the full Kong graph at recurrent inputs for local browser measurements."""

from pathlib import Path

import onnx


def main():
    source = Path('.cache/models/transcription/piano_crnn.onnx')
    model = onnx.load(str(source))
    names = ['reg_onset', 'reg_offset', 'frame', 'velocity', 'pedal_offset', 'pedal_frame']
    inferred = onnx.shape_inference.infer_shapes(onnx.utils.Extractor(model).extract_model([model.graph.input[0].name], names))
    producers = {output: node for node in inferred.graph.node for output in node.output}
    initializers = {item.name for item in inferred.graph.initializer}
    recurrent_values = set()
    for node in inferred.graph.node:
        if node.op_type == 'GRU' or any(name in recurrent_values for name in node.input):
            recurrent_values.update(node.output)
    boundaries = sorted({name for node in inferred.graph.node
                         if any(output in recurrent_values for output in node.output)
                         for name in node.input if name and name not in recurrent_values
                         and name not in initializers and name in producers
                         and producers[name].op_type != 'Constant'})
    if not boundaries:
        raise ValueError('The full graph has no recurrent boundaries')
    convolution = onnx.utils.Extractor(inferred).extract_model([inferred.graph.input[0].name], boundaries)
    recurrent = onnx.utils.Extractor(inferred).extract_model(boundaries, names)
    onnx.checker.check_model(convolution)
    onnx.checker.check_model(recurrent)
    onnx.save(convolution, '.cache/browser-inference/phrase-convolution.onnx')
    onnx.save(recurrent, '.cache/browser-inference/phrase-recurrent.onnx')
    print(f'{len(boundaries)} recurrent boundaries')


if __name__ == '__main__':
    main()
