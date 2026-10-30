import base64
import hashlib
import io
import json
import tarfile
from pathlib import Path

import httpx
from huggingface_hub import hf_hub_download
from tqdm import tqdm

CACHE = Path(".cache")
ARIA_REVISION = "5a1ef36c5007ee10fbe57d61d96725a7244bd2b2"
TRANSCRIPTION_REVISION = "24c14424609da2cc2c4b16d051365904327dd242"
SAMPLE_REVISION = "622c2f1c32c8cfce4158ddc3eb26e518ddef37e5"
WEIGHTS = CACHE / "models/aria/model-gen.safetensors"
QUANTIZED = CACHE / "models/aria/piano-4bit.safetensors"
TRANSCRIPTION = CACHE / "models/transcription/piano_crnn.onnx"
SAMPLES = CACHE / "samples"
NOTATION = CACHE / "notation"
VEXFLOW_INTEGRITY = (
    "rjB7TV4ygKE5Fl3W5OlG+0dHv22CFufUJdMG6oNgvcn0zp34u+sOboZsadQXnF1O3tZ3myXThaUIaLkJlpNM2Q=="
)
PITCH_NAMES = ("C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B")


def main():
    download_assets()
    from piano_duet.generation import quantize_checkpoint

    quantize_checkpoint()
    from piano_duet.score_model import setup as setup_score_model

    setup_score_model()
    print("Ready. Start with: uv run piano-duet")


def download_assets():
    download_notation()
    hf_hub_download(
        "loubb/aria-medium-base",
        "model-gen.safetensors",
        revision=ARIA_REVISION,
        local_dir=WEIGHTS.parent,
    )
    hf_hub_download(
        "stelee/piano-transcription-onnx",
        "piano_crnn.onnx",
        revision=TRANSCRIPTION_REVISION,
        local_dir=TRANSCRIPTION.parent,
    )
    SAMPLES.mkdir(parents=True, exist_ok=True)
    manifest = []
    with httpx.Client(follow_redirects=True, timeout=60) as client:
        for pitch in tqdm(range(24, 109, 3), desc="Piano samples"):
            name = f"{PITCH_NAMES[pitch % 12]}{pitch // 12 - 1}.mp3"
            path = SAMPLES / name
            if not path.exists():
                response = client.get(
                    f"https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/"
                    f"{SAMPLE_REVISION}/samples/piano/{name}"
                )
                response.raise_for_status()
                path.with_suffix(".download").write_bytes(response.content)
                path.with_suffix(".download").replace(path)
            manifest.append(
                {
                    "pitch": pitch,
                    "file": name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
    (SAMPLES / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def download_notation():
    NOTATION.mkdir(parents=True, exist_ok=True)
    response = httpx.get("https://registry.npmjs.org/vexflow/-/vexflow-5.0.0.tgz", timeout=60)
    response.raise_for_status()
    digest = base64.b64encode(hashlib.sha512(response.content).digest()).decode()
    if digest != VEXFLOW_INTEGRITY:
        raise ValueError("VexFlow package integrity does not match the pinned release")
    with tarfile.open(fileobj=io.BytesIO(response.content), mode="r:gz") as archive:
        for source, destination in (
            ("package/build/cjs/vexflow.js", "vexflow.js"),
            ("package/LICENSE", "LICENSE"),
        ):
            resource = archive.extractfile(source)
            if resource is None:
                raise ValueError(f"VexFlow package is missing {source}")
            (NOTATION / destination).write_bytes(resource.read())


def require_assets():
    for path in (QUANTIZED, TRANSCRIPTION, SAMPLES / "manifest.json", NOTATION / "vexflow.js"):
        if not path.is_file():
            raise FileNotFoundError(f"Missing {path}. Run: uv run piano-duet setup")


if __name__ == "__main__":
    main()
