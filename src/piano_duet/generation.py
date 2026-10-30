import math
import time
from collections.abc import Callable, Iterator
from threading import Event

import mlx.core as mx
from aria.config import load_model_config
from aria.inference.model_mlx import TransformerLM
from aria.model import ModelConfig
from ariautils.tokenizer import AbsTokenizer
from mlx import nn
from tqdm import tqdm

from piano_duet.assets import QUANTIZED, WEIGHTS
from piano_duet.difficulty import PerformanceLimits
from piano_duet.notes import Note, to_midi_dict
from piano_duet.phrasing import PhraseEnding, estimate_beat


def main():
    quantize_checkpoint()


def create_model() -> TransformerLM:
    return TransformerLM(ModelConfig(**load_model_config("medium")))


def quantize_checkpoint():
    if QUANTIZED.exists():
        return
    print("Converting Aria to 4-bit MLX weights for fast local inference…", flush=True)
    model = create_model()
    model.load_weights(str(WEIGHTS), strict=True)
    model.set_dtype(mx.float16)
    nn.quantize(model, group_size=64, bits=4)
    mx.eval(model.parameters())
    target = QUANTIZED.with_name("converting.safetensors")
    model.save_weights(str(target))
    target.replace(QUANTIZED)
    print(f"Saved {QUANTIZED} ({QUANTIZED.stat().st_size / 1e6:.0f} MB)", flush=True)


class PianoGenerator:
    def __init__(self):
        self.tokenizer = AbsTokenizer()
        self.model = create_model()
        nn.quantize(self.model, group_size=64, bits=4)
        self.model.load_weights(str(QUANTIZED), strict=True)
        self.model.eval()
        mx.eval(self.model.parameters())
        self.note_ids = [
            i
            for i, tok in self.tokenizer.id_to_tok.items()
            if isinstance(tok, tuple) and tok[0] == "piano" and 21 <= tok[1] <= 108 and tok[2] > 0
        ]
        self.onset_ids = [self.tokenizer.tok_to_id[t] for t in self.tokenizer.onset_tokens]
        self.duration_ids = [
            self.tokenizer.tok_to_id[t] for t in self.tokenizer.dur_tokens if t[1] > 0
        ]
        self.time_id = self.tokenizer.tok_to_id[self.tokenizer.time_tok]
        self.end_id = self.tokenizer.tok_to_id[self.tokenizer.eos_tok]
        self.dim_id = self.tokenizer.tok_to_id[self.tokenizer.dim_tok]

    def warmup(self):
        list(
            self.generate(
                [Note(pitch=60, start=0, duration=0.4, velocity=80)], seconds=0.1, max_notes=1
            )
        )

    def notes_in_scale(self, pitch_classes):
        if not pitch_classes or any(type(p) is not int or not 0 <= p < 12 for p in pitch_classes):
            raise ValueError("A pitch constraint requires pitch classes between 0 and 11")
        return [i for i in self.note_ids if self.tokenizer.id_to_tok[i][1] % 12 in pitch_classes]

    def phrase(self, rng, context=None):
        return ConstrainedPhrase(self, rng, context)

    def generate(
        self,
        notes: list[Note],
        seconds: float = 5,
        temperature: float = 0.95,
        cancel: Event | None = None,
        max_notes: int = 180,
        on_prefill: Callable[[float], None] | None = None,
        pitch_classes: tuple[int, ...] | None = None,
        tonic: int | None = None,
        on_ending: Callable[[str], None] | None = None,
        difficulty: int = 3,
    ) -> Iterator[Note]:
        def deliver(ready_notes):
            for ready_note in ready_notes:
                if cancel is not None and cancel.is_set():
                    return
                yield ready_note

        ending = PhraseEnding(seconds, estimate_beat(notes), tonic, pitch_classes)
        source = self.sample_notes(
            notes, ending, temperature, cancel, max_notes, on_prefill, pitch_classes, difficulty
        )
        try:
            for note in source:
                if cancel is not None and cancel.is_set():
                    return
                if note is None:
                    yield from deliver(ending.finish(model_ended=True))
                    break
                yield from deliver(ending.feed(note))
                if ending.done:
                    break
            if cancel is not None and cancel.is_set():
                return
            yield from deliver(ending.finish())
            if on_ending:
                on_ending(ending.reason)
        finally:
            source.close()

    def sample_notes(
        self, notes, ending, temperature, cancel, max_notes, on_prefill, pitch_classes, difficulty=3
    ) -> Iterator[Note | None]:
        if not notes:
            raise ValueError("Aria requires piano notes as a prompt")
        note_ids = self.note_ids if pitch_classes is None else self.notes_in_scale(pitch_classes)
        limits = PerformanceLimits(difficulty, ending.beat)
        note_ids = [i for i in note_ids if limits.in_range(self.tokenizer.id_to_tok[i][1])]
        pitches = {self.tokenizer.id_to_tok[i][1] for i in note_ids}
        prompt = self.tokenizer.tokenize(
            to_midi_dict(notes[-180:]),
            add_dim_tok=False,
            add_eos_tok=False,
        )
        tokens = self.tokenizer.encode(prompt)
        prompt_onset = self.tokenizer.calc_length_ms(prompt, onset=True)
        segment = prompt.count(self.tokenizer.time_tok) * self.tokenizer.abs_time_step_ms
        minimum_onset = prompt_onset + self.tokenizer.time_step_ms
        first_onset = None
        previous_onset = minimum_onset
        note_history = []
        duration_floor = max(
            limits.duration_floor, max(60, min(100, round(ending.beat * 160 / 10) * 10))
        )
        ending_cue_at = max(0.7, ending.target - max(1.2, ending.beat * 4))
        ending_cued = False
        state = "note"
        pitch = velocity = onset = None
        self.model.setup_cache(1, max_seq_len=len(tokens) + max_notes * 3 + 32, dtype=mx.float16)
        started = time.perf_counter()
        logits = self.model(
            mx.array([tokens]), mx.arange(len(tokens)), offset=0, max_kv_pos=len(tokens) - 1
        )[0, -1]
        mx.eval(logits)
        if on_prefill:
            on_prefill(time.perf_counter() - started)
        position = len(tokens)
        note_count = 0
        for _ in tqdm(range(max_notes * 3 + 24), desc="Aria response", leave=False):
            if cancel is not None and cancel.is_set():
                return
            short_loop = repetitive_short_notes(note_history)
            if state == "note":
                windows = {p: limits.windows(p, previous_onset) for p in pitches}
                playable = {
                    p
                    for p in pitches
                    if any(
                        max(start, segment)
                        <= min(
                            end,
                            segment + self.tokenizer.abs_time_step_ms - self.tokenizer.time_step_ms,
                        )
                        for start, end in windows[p]
                    )
                }
                allowed = [i for i in note_ids if self.tokenizer.id_to_tok[i][1] in playable] + [
                    self.time_id
                ]
                if note_count:
                    allowed = allowed + [self.end_id]
                if segment + self.tokenizer.abs_time_step_ms <= previous_onset:
                    allowed = [self.time_id]
                if (
                    not ending_cued
                    and first_onset is not None
                    and ((previous_onset - first_onset) / 1000 >= ending_cue_at or short_loop)
                ):
                    allowed = [self.dim_id]
            elif state == "onset":
                allowed = [
                    i
                    for i in self.onset_ids
                    if any(
                        start <= self.tokenizer.id_to_tok[i][1] + segment <= end
                        for start, end in windows[pitch]
                    )
                ]
            else:
                minimum_duration = (
                    max(duration_floor, round(ending.beat * 500)) if short_loop else duration_floor
                )
                allowed = [
                    i
                    for i in self.duration_ids
                    if self.tokenizer.id_to_tok[i][1] >= minimum_duration
                ]
            if not allowed:
                raise RuntimeError("Aria has no valid next token for the current timing")
            ids = mx.array(allowed)
            scores = logits[ids].astype(mx.float32) / temperature
            scores = mx.where(
                scores >= mx.max(scores) + mx.log(mx.array(0.035)), scores, -float("inf")
            )
            token_id = allowed[mx.random.categorical(scores).item()]
            token = self.tokenizer.id_to_tok[token_id]
            if token_id == self.end_id:
                yield None
                return
            if token_id == self.dim_id:
                ending_cued = True
            elif token_id == self.time_id:
                segment += self.tokenizer.abs_time_step_ms
                if segment > minimum_onset + (ending.horizon + 10) * 1000:
                    raise RuntimeError("Aria generated an excessively long rest")
            elif state == "note":
                _, pitch, velocity = token
                state = "onset"
            elif state == "onset":
                onset = segment + token[1]
                first_onset = onset if first_onset is None else first_onset
                if onset - first_onset >= ending.horizon * 1000:
                    return
                previous_onset = onset
                state = "duration"
            else:
                note = Note(
                    pitch=pitch,
                    velocity=velocity,
                    start=(onset - first_onset) / 1000,
                    duration=token[1] / 1000,
                )
                note_history.append(note)
                limits.record(pitch, onset)
                yield note
                state = "note"
                note_count += 1
                if note_count >= max_notes:
                    return
            logits = self.model(
                mx.array([[token_id]]), mx.array([position]), offset=position, max_kv_pos=position
            )[0, -1]
            mx.eval(logits)
            position += 1


class ConstrainedPhrase:
    """Aria writes one phrase note by note, choosing only among the pitches and durations offered.

    `context` is the music just before the phrase, {"notes": [...], "end": seconds}: Aria hears it first, and the
    phrase's onsets count from its end, so the new music continues it.
    """

    CAPACITY = 2048
    TEMPERATURE = 0.95
    # Like the duet sampler, drop options far less likely than Aria's favourite.
    CUTOFF = 0.035

    def __init__(self, generator, rng, context=None):
        self.tokenizer = generator.tokenizer
        self.model = generator.model
        self.rng = rng
        self.pitch_tokens = {}
        for token in generator.note_ids:
            self.pitch_tokens.setdefault(self.tokenizer.id_to_tok[token][1], []).append(token)
        self.model.setup_cache(1, max_seq_len=self.CAPACITY, dtype=mx.float16)
        self.position = 0
        self.pitch = None
        if context is None:
            self.pending = self.tokenizer.encode([("prefix", "instrument", "piano"), self.tokenizer.bos_tok])
            self.segment = self.onset = 0
            self.origin = 0
            return
        notes = [Note(**{field: note[field] for field in ("pitch", "start", "duration", "velocity")}) for note in context["notes"]]
        if not notes:
            raise ValueError("Context for a constrained phrase needs notes")
        prompt = self.tokenizer.tokenize(to_midi_dict(notes), add_dim_tok=False, add_eos_tok=False)
        self.pending = self.tokenizer.encode(prompt)
        # Aria's timeline starts at the context's first onset; the phrase begins where the context ends.
        first = min(note.start for note in notes)
        if context["end"] < max(note.start for note in notes):
            raise ValueError("A phrase's context must end after its last onset")
        self.origin = context["end"] - first
        self.segment = prompt.count(self.tokenizer.time_tok) * self.tokenizer.abs_time_step_ms
        self.onset = self.tokenizer.calc_length_ms(prompt, onset=True)

    def note(self, onset, pitches, durations):
        """Write a note at `onset` seconds; `pitches` and `durations` (seconds) map options to practice weights."""
        milliseconds = round((self.origin + onset) * 100) * 10
        if milliseconds < self.onset:
            raise ValueError("A constrained phrase must be written in time order")
        # Aria orders the notes of one onset from low to high.
        if self.pitch is not None and milliseconds == self.onset and min(pitches) <= self.pitch:
            raise ValueError("Notes sharing an onset must be written from low to high")
        self.onset = milliseconds
        while milliseconds >= self.segment + self.tokenizer.abs_time_step_ms:
            self.pending.append(self.tokenizer.tok_to_id[self.tokenizer.time_tok])
            self.segment += self.tokenizer.abs_time_step_ms
        if any(pitch not in self.pitch_tokens for pitch in pitches):
            raise ValueError("Constrained pitches must be piano keys")
        pitch_token = self.choose(
            {token: weight for pitch, weight in pitches.items() for token in self.pitch_tokens[pitch]}
        )
        self.pending += [pitch_token, self.tokenizer.tok_to_id[("onset", milliseconds - self.segment)]]
        options = {}
        for seconds, weight in durations.items():
            token = self.tokenizer.tok_to_id[("dur", min(self.tokenizer.max_dur_ms, round(seconds * 100) * 10))]
            if token in options:
                raise ValueError("Two offered durations map to the same Aria token")
            options[token] = (seconds, weight)
        duration_token = self.choose({token: weight for token, (_, weight) in options.items()})
        self.pending.append(duration_token)
        self.pitch = self.tokenizer.id_to_tok[pitch_token][1]
        return self.pitch, options[duration_token][0]

    def choose(self, options):
        if not options or any(not weight > 0 for weight in options.values()):
            raise ValueError("A constrained choice needs options with positive weights")
        if len(options) == 1:
            return next(iter(options))
        logits = self.advance() if self.pending else self.logits
        tokens = list(options)
        scores = logits[mx.array(tokens)].astype(mx.float32) / self.TEMPERATURE + mx.log(
            mx.array([options[token] for token in tokens], dtype=mx.float32)
        )
        scores = mx.where(scores >= mx.max(scores) + math.log(self.CUTOFF), scores, -float("inf"))
        probabilities = mx.softmax(scores).tolist()
        return self.rng.choices(tokens, weights=probabilities)[0]

    def advance(self):
        count = len(self.pending)
        if self.position + count > self.CAPACITY:
            raise RuntimeError("The constrained phrase is longer than its Aria context")
        logits = self.model(
            mx.array([self.pending]),
            mx.arange(self.position, self.position + count),
            offset=self.position,
            max_kv_pos=self.position + count - 1,
        )[0, -1]
        self.position += count
        self.pending = []
        self.logits = logits
        return logits

    def chord_chance(self, pitches):
        """Aria's probability that its next note is one of `pitches`, sounding with the note just written."""
        logits = self.advance() if self.pending else self.logits
        probabilities = mx.softmax(logits.astype(mx.float32) / self.TEMPERATURE)
        same = self.tokenizer.tok_to_id[("onset", self.onset - self.segment)]
        total = 0.0
        for pitch in pitches:
            tokens = self.pitch_tokens[pitch]
            weights = probabilities[mx.array(tokens)]
            mass = mx.sum(weights).item()
            if mass < 1e-6:
                continue
            # Try the pitch at its likeliest velocity, read Aria's onset for it, then let the next write overwrite it.
            probe = tokens[int(mx.argmax(weights).item())]
            onset = self.model(mx.array([[probe]]), mx.array([self.position]), offset=self.position, max_kv_pos=self.position)[0, -1]
            total += mass * mx.softmax(onset.astype(mx.float32) / self.TEMPERATURE)[same].item()
        return min(1.0, total)


def repetitive_short_notes(notes):
    recent = notes[-12:]
    return (
        len(recent) >= 8
        and sum(note.duration < 0.16 for note in recent) >= len(recent) * 0.75
        and len({note.pitch for note in recent}) <= 4
    )


if __name__ == "__main__":
    main()
