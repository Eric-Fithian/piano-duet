---
license: cc-by-nc-sa-4.0
pipeline_tag: other
tags:
  - music
  - music-transcription
  - onnx
---

# Piano Duet score model

The converted model weights are licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); the full legal text is in [LICENSE](LICENSE). When sharing or adapting the weights, attribute them as: **Score model by Eric Fithian**. The licence requires attribution, restricts use to non-commercial purposes and requires adaptations to be shared alike.

## Model

This is the 119,450,938-parameter score model trained by Eric Fithian for Piano Duet to turn a piano performance represented as MIDI notes into a notated score. It follows [MIDI2ScoreTransformer](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer), by Tim Beyer and Angela Dai, and uses an eight-layer encoder and eight-layer decoder. The upstream architecture repository does not state a licence. This repository contains Eric Fithian's retrained model, converted to ONNX; it does not contain the public upstream checkpoint or the other retrained checkpoints.

The model was initialized from a 120M-parameter model pretrained on synthetic performances, then fine-tuned for 20,000 steps with batch size 256. The final checkpoint is a uniform weight average of two fine-tunes with different random seeds. The four FP32 ONNX graphs provide an encoder, the first decoder step, a 64-token context decoder, and a cached decoder step. Their inputs, cache and generation logic are implemented in the Piano Duet repository.

## Training data and licences

The fine-tuning mixture was 45% aligned PianoCoRe performances, 15% ASAP performances and 40% synthetic performances. The synthetic stream used 50% non-classical PDMX scores, 25% PDMX scores without that genre restriction and 25% ASAP scores. The earlier synthetic pretraining also used PDMX and ASAP scores.

- [PianoCoRe](https://huggingface.co/datasets/SyMuPe/PianoCoRe): the dataset card declares [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). It aggregates material from multiple sources, whose underlying rights need review.
- [ASAP](https://github.com/fosfrancesco/asap-dataset): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), including its non-commercial and share-alike terms.
- [PDMX](https://github.com/pnlong/PDMX): a collection of scores marked public domain on MuseScore; the [dataset release](https://zenodo.org/records/14984509) has its own licence metadata. Training selected valid scores from its `no_license_conflict` subset, but the rights of individual scores and any redistribution conditions still need review.

PianoCoRe includes material from other performance corpora, potentially including [MAESTRO](https://magenta.tensorflow.org/datasets/maestro), which is distributed under CC BY-NC-SA. The precise component sources present in this training subset have not been independently audited. Source-data licences and the model licence are separate; the upstream architecture repository has no stated licence.

## Evaluation and limitations

The training project's held-out PianoCoRe test summary reports mean MUSTER error 8.46 across 83 scored performances, with six failed performances reported separately. The model is intended for piano performance-to-score conversion and can make pitch, timing, notation, voice and staff errors. Results depend on the upstream transcription and are not a guarantee of a publication-ready score.

On a three-minute, 960-note piano fixture, the ONNX conversion matched all greedy output tokens from the Python checkpoint. Browser transcription followed by the converted model and browser MusicXML writing produced the same 898 notes, key, meter and 57 bars as the Python reference. MUSTER's aligned combined error was 0.130% and aligned pitch F1 was 0.9967, equal to four Python onset-jitter runs of ±0.02 ms; MUSTER reported a small nonzero error even for identical scores. This is one recording. Real Safari and iPhone performance and broader score parity remain unmeasured.
