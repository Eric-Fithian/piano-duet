# Piano Duet score model — draft model card

**Draft for review. Publication of this checkpoint and its converted weights has not been authorized. The model licence and redistribution terms are undecided.**

## Model

This is the locally trained 119,450,938-parameter score model used by Piano Duet to turn a piano performance represented as MIDI notes into a notated score. It follows [MIDI2ScoreTransformer](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer), by Tim Beyer and Angela Dai, and uses an eight-layer encoder and eight-layer decoder. The upstream repository does not state a licence; permission for redistribution of its code or converted checkpoints is pending. The checkpoint described here is the user's retrained model, not the public upstream checkpoint.

The model was initialized from a 120M-parameter model pretrained on synthetic performances, then fine-tuned for 20,000 steps with batch size 256. The final checkpoint is a uniform weight average of two fine-tunes with different random seeds. Local testing uses an FP32 ONNX conversion; the checkpoint and converted files are not included here.

## Training data and licences

The fine-tuning mixture was 45% aligned PianoCoRe performances, 15% ASAP performances and 40% synthetic performances. The synthetic stream used 50% non-classical PDMX scores, 25% PDMX scores without that genre restriction and 25% ASAP scores. The earlier synthetic pretraining also used PDMX and ASAP scores.

- [PianoCoRe](https://huggingface.co/datasets/SyMuPe/PianoCoRe): the dataset card declares [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). It aggregates material from multiple sources, whose underlying rights need review.
- [ASAP](https://github.com/fosfrancesco/asap-dataset): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), including its non-commercial and share-alike terms.
- [PDMX](https://github.com/pnlong/PDMX): a collection of scores marked public domain on MuseScore; the [dataset release](https://zenodo.org/records/14984509) has its own licence metadata. Training selected valid scores from its `no_license_conflict` subset, but the rights of individual scores and any redistribution conditions still need review.

PianoCoRe includes material from other performance corpora, potentially including [MAESTRO](https://magenta.tensorflow.org/datasets/maestro), which is distributed under CC BY-NC-SA. The precise component sources present in this training subset have not been independently audited. The source-data licences above do not establish a licence for the checkpoint; permission and licence review must precede publication.

## Evaluation and limitations

The training project's held-out PianoCoRe test summary reports mean MUSTER error 8.46 across 83 scored performances, with six failed performances reported separately. The model is intended for piano performance-to-score conversion and can make pitch, timing, notation, voice and staff errors. Results depend on the upstream transcription and are not a guarantee of a publication-ready score.

The browser conversion is being evaluated locally. Browser score construction, real Safari and iPhone performance, and redistribution have not been validated.
