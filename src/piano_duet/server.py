import asyncio
import hashlib
import json
import logging
import os
import socket
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event, Thread
from typing import Literal
from uuid import UUID, uuid4

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from scipy.signal import resample_poly
from starlette.middleware.trustedhost import TrustedHostMiddleware

from piano_duet.assessment import assess
from piano_duet.assets import NOTATION, SAMPLES, require_assets
from piano_duet.drills import (
    DRILLS,
    HANDS,
    PRACTICES,
    assess_drill,
    catalog,
    drill_levels,
    drill_progress,
    next_drill,
)
from piano_duet.generation import PianoGenerator
from piano_duet.key_tracking import KeyTracker
from piano_duet.learning import analyze_phrase, compare_performance
from piano_duet.library import (
    CATALOG,
    edit_song,
    revert_song,
    song_attacks,
    song_stats,
    song_version,
    summary,
)
from piano_duet.notes import Note, midi_bytes
from piano_duet.practice import next_task
from piano_duet.profile import DATABASE, LearnerStore
from piano_duet.reading import assess_reading, matches_reading
from piano_duet.reading_curriculum import measure_landings
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_rewards import score_xp
from piano_duet.reading_stages import STAGES
from piano_duet.recording_transcription import SAMPLE_RATE as RECORDING_RATE
from piano_duet.recording_transcription import RecordingTranscriber
from piano_duet.score_import import ScoreError, build_song, parse_score
from piano_duet.score_model import performance_to_score
from piano_duet.transcription import LIVE_WINDOW, NOTE_THRESHOLD, SAMPLE_RATE, PianoTranscriber
from piano_duet.youtube import check_url, fetch_audio

STATIC = Path("src/piano_duet/static")
DRILL_QUALITY = {
    "usable": True,
    "model": "Transkun 2.0",
    "reason": "Transkun 2.0 reports no onset confidence; check the heard notes if a take looks wrong",
}
logger = logging.getLogger("piano_duet")


def main(port=8765, open_browser=True, reload=False):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        occupied = probe.connect_ex(("127.0.0.1", port)) == 0
    if occupied:
        response = httpx.get(f"http://127.0.0.1:{port}/api/status", timeout=5)
        response.raise_for_status()
        if response.json().get("application") != "piano-duet":
            raise RuntimeError(f"Port {port} is already occupied by another application")
        if reload and not response.json().get("development"):
            raise RuntimeError(
                f"Port {port} is running without automatic reload. Stop it before using --reload."
            )
        print(f"Piano Duet is already running at http://127.0.0.1:{port}")
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        return
    require_assets()
    if reload:
        os.environ["PIANO_DUET_DEV_PORT"] = str(port)
        if open_browser:
            Thread(target=open_when_ready, args=(port,), daemon=True).start()
        uvicorn.run(
            "piano_duet.server:development_app",
            factory=True,
            reload=True,
            reload_dirs=["src/piano_duet"],
            host="127.0.0.1",
            port=port,
            log_level="info",
            access_log=False,
        )
        return
    uvicorn.run(
        create_app(port, open_browser),
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,
    )


def open_when_ready(port):
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                webbrowser.open(f"http://127.0.0.1:{port}")
                return
        time.sleep(0.2)


def development_app():
    return create_app(port=int(os.environ["PIANO_DUET_DEV_PORT"]), development=True)


class ExportRequest(BaseModel):
    notes: list[Note] = Field(min_length=1)


class PracticeRequest(BaseModel):
    focus: Literal["guided", "technique", "reading", "theory", "ear", "repertoire"] = "guided"
    piece: UUID | None = None
    step_by_step: bool = False
    after: UUID | None = None
    stage: int | None = Field(None, ge=1, le=len(STAGES))


class AidRequest(BaseModel):
    kind: Literal["reveals", "hearings", "hints"]


class TakeListening(BaseModel):
    """What the browser's live attack counter heard during a drill take, kept to explain how the take ended."""

    ended: Literal["attacks", "quiet", "limit", "space"]
    floor: float = Field(ge=0)
    noise: float = Field(ge=0)
    attacks: list[float] = Field(max_length=600)
    strengths: list[float] = Field(max_length=600)
    seconds: float = Field(ge=0)


class DrillRequest(BaseModel):
    drill: Literal[tuple(DRILLS)] | None = None
    variant: str | None = None
    tonic: int | None = Field(None, ge=0, le=11)
    hands: Literal[tuple(HANDS)] | None = None
    octaves: int | None = Field(None, ge=1, le=4)
    inversion: int = Field(0, ge=0, le=2)
    practice: Literal[tuple(PRACTICES)] = "even"
    rung: int | None = Field(None, ge=0)
    avoid: list[Literal[tuple(DRILLS)]] = Field(default_factory=list)
    focus: Literal[tuple(DRILLS)] | None = None

    @model_validator(mode="after")
    def complete(self):
        chosen = [self.variant, self.tonic, self.hands, self.octaves]
        if self.drill is None and (any(value is not None for value in chosen) or self.rung is not None):
            raise ValueError("Choosing a drill for you takes no other settings")
        if self.drill is not None and (self.avoid or self.focus):
            raise ValueError("Only a drill chosen for you can avoid or focus on drills")
        if self.drill is not None and any(value is None for value in chosen):
            raise ValueError("A chosen drill needs its variant, key, hands, and octaves")
        return self


class ExcludeRequest(BaseModel):
    excluded: bool


class PieceRequest(BaseModel):
    attempt: UUID
    title: str = Field(min_length=1, max_length=80)


class ReadingNote(BaseModel):
    pitch: int = Field(ge=21, le=108)
    start: float = Field(ge=0, allow_inf_nan=False)
    velocity: int = Field(ge=1, le=127)
    confidence: float = Field(ge=0.1, le=1, allow_inf_nan=False)


class YoutubeRequest(BaseModel):
    url: str = Field(min_length=1, max_length=500)
    # The player must confirm they may transcribe the recording; nothing is downloaded otherwise.
    has_rights: Literal[True]


class SongNote(BaseModel):
    pitch: int = Field(ge=21, le=108)
    start: float = Field(ge=0, allow_inf_nan=False)
    duration: float = Field(gt=0, allow_inf_nan=False)
    velocity: int = Field(ge=1, le=127)
    staff: Literal["treble", "bass"]
    voice: Literal[0, 1]
    grace: bool = False


class SongEditRequest(BaseModel):
    bpm: int = Field(ge=30, le=240)
    meter: str
    tonic: int = Field(ge=0, le=11)
    mode: Literal["major", "minor"]
    notes: list[SongNote] = Field(min_length=1)


class SongPlayRequest(BaseModel):
    id: UUID
    attacks: list[tuple[int, bool]] = Field(min_length=1)


class ReadingRequest(BaseModel):
    task: UUID
    attempt: UUID
    groups: list[list[ReadingNote]] = Field(min_length=1)
    interruptions: list[int]
    threshold: float = Field(ge=0.1, le=0.99)

    @model_validator(mode="after")
    def chronological(self):
        if self.interruptions != sorted(set(self.interruptions)) or any(
            index < 0 or index > len(self.groups) for index in self.interruptions
        ):
            raise ValueError("Recording interruptions must be ordered attack boundaries")
        previous = -1
        for group in self.groups:
            if not group:
                raise ValueError("Reading attacks cannot be empty")
            start = min(note.start for note in group)
            if start < previous:
                raise ValueError("Reading attacks must be chronological")
            previous = start
        return self


class DuetEngine:
    def __init__(self):
        self.transcriber = PianoTranscriber()
        self.generator = PianoGenerator()
        self.transcriber.warmup()
        self.generator.warmup()
        self.history = []
        self.session = None
        self.key_tracker = KeyTracker()
        self.lesson = None

    def learn(self, audio, session, lesson_id, stage, surprise, threshold, emit, cancel):
        if stage == "repeat" and (
            self.lesson is None
            or self.lesson["session"] != session
            or self.lesson["id"] != lesson_id
        ):
            raise ValueError(
                "This learning target is no longer available. Start a new learning round."
            )
        if stage == "idea":
            self.lesson = None
        started = time.perf_counter()
        notes = self.transcriber.transcribe(
            audio,
            threshold,
            cancel=cancel,
            on_progress=lambda progress: emit({"type": "transcribing", "progress": progress}),
        )
        if cancel.is_set():
            return
        transcription_ms = round((time.perf_counter() - started) * 1000)
        key = KeyTracker().observe(notes) if stage == "idea" and notes else None
        if stage == "repeat":
            key = self.lesson["key"]
        emit(
            {
                "type": "heard",
                "notes": [n.model_dump() for n in notes],
                "key": key,
                "transcription_ms": transcription_ms,
                "stage": stage,
            }
        )
        if not notes:
            emit({"type": "done", "notes": 0, "stage": stage, "empty": True})
            return
        if stage == "repeat":
            result = compare_performance(self.lesson["notes"], notes, cancel)
            if result is None or cancel.is_set():
                return
            self.lesson = None
            emit({"type": "score", **result})
            emit(
                {
                    "type": "done",
                    "notes": 0,
                    "stage": "complete",
                    "total_ms": round((time.perf_counter() - started) * 1000),
                }
            )
            return
        result = analyze_phrase(
            self.generator,
            notes,
            surprise,
            cancel,
            lambda detail, progress: emit({"type": "analyzing", "progress": progress}),
        )
        if result is None or cancel.is_set():
            return
        corrected, analysis = result
        self.lesson = {"session": session, "id": lesson_id, "notes": corrected, "key": key}
        emit(
            {
                "type": "lesson",
                "id": lesson_id,
                "notes": [n.model_dump() for n in corrected],
                "analysis": analysis,
                "threshold": surprise,
            }
        )
        first_note_ms = round((time.perf_counter() - started) * 1000)
        for note in corrected:
            if cancel.is_set():
                return
            emit({"type": "note", "note": note.model_dump()})
        emit(
            {
                "type": "done",
                "notes": len(corrected),
                "stage": "repeat",
                "first_note_ms": first_note_ms,
                "transcription_ms": transcription_ms,
                "total_ms": round((time.perf_counter() - started) * 1000),
            }
        )

    def respond(self, audio, session, seconds, temperature, threshold, emit, cancel, difficulty=3):
        started = time.perf_counter()
        notes = self.transcriber.transcribe(
            audio,
            threshold,
            cancel=cancel,
            on_progress=lambda progress: emit({"type": "transcribing", "progress": progress}),
        )
        transcription_time = time.perf_counter() - started
        if self.session != session:
            self.history = []
            self.session = session
            self.key_tracker = KeyTracker()
        key = self.key_tracker.observe(notes) if notes else None
        emit(
            {
                "type": "heard",
                "notes": [n.model_dump() for n in notes],
                "transcription_ms": round(transcription_time * 1000),
                "key": key,
            }
        )
        if not notes or cancel.is_set():
            emit({"type": "done", "notes": 0, "total_ms": round(transcription_time * 1000)})
            return
        shift = max((n.start + n.duration for n in self.history), default=-0.2) + 0.2
        first = notes[0].start
        played = [n.model_copy(update={"start": n.start - first + shift}) for n in notes]
        prompt = (self.history + played)[-180:]
        origin = prompt[0].start
        prompt = [n.model_copy(update={"start": n.start - origin}) for n in prompt]
        reply = []
        first_note_ms = None
        for note in self.generator.generate(
            prompt,
            seconds,
            temperature,
            cancel,
            pitch_classes=tuple(key["pitch_classes"]),
            tonic=key["tonic"],
            difficulty=difficulty,
        ):
            if note.pitch % 12 not in key["pitch_classes"]:
                raise RuntimeError("Aria generated a note outside the constrained key")
            if first_note_ms is None:
                first_note_ms = round((time.perf_counter() - started) * 1000)
            reply.append(note)
            emit({"type": "note", "note": note.model_dump()})
        if cancel.is_set():
            return
        if not reply:
            raise RuntimeError("Aria returned no notes for the recognized piano phrase")
        response_start = max(n.start + n.duration for n in prompt) + 0.2
        history = prompt + [n.model_copy(update={"start": n.start + response_start}) for n in reply]
        history = history[-180:]
        origin = history[0].start
        self.history = [n.model_copy(update={"start": n.start - origin}) for n in history]
        elapsed = time.perf_counter() - started
        emit(
            {
                "type": "done",
                "notes": len(reply),
                "first_note_ms": first_note_ms,
                "transcription_ms": round(transcription_time * 1000),
                "total_ms": round(elapsed * 1000),
            }
        )


def create_app(
    port=8765,
    open_browser=False,
    engine_factory=DuetEngine,
    profile_path=DATABASE,
    development=False,
):
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="piano-inference")
    generation = uuid4().hex

    def revision():
        fingerprint = hashlib.sha256(generation.encode())
        for path in sorted(STATIC.rglob("*")):
            if path.is_file() and path.suffix in {".html", ".css", ".mjs", ".js"}:
                stat = path.stat()
                fingerprint.update(f"{path}:{stat.st_mtime_ns}:{stat.st_size}".encode())
        return fingerprint.hexdigest()

    @asynccontextmanager
    async def lifespan(app):
        app.state.store = LearnerStore(profile_path)
        print("Loading local piano models and warming up the GPU…", flush=True)
        app.state.engine = await asyncio.get_running_loop().run_in_executor(
            executor, engine_factory
        )
        app.state.busy = False
        app.state.reading_busy = False
        app.state.recording = None
        print(f"Piano Duet ready at http://127.0.0.1:{port}", flush=True)
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        yield
        executor.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"]
    )

    @app.middleware("http")
    async def local_only(request, call_next):
        # Every request that changes something must come from this app's own page.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if request.headers.get("x-duet-client") != "1":
                return JSONResponse({"detail": "Missing local app request header"}, status_code=403)
            if origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse(
                    {"detail": "Cross-origin requests are disabled"}, status_code=403
                )
        response = await call_next(request)
        if development and (
            request.url.path == "/" or request.url.path.startswith(("/static/", "/__dev/"))
        ):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; "
            "font-src 'self' data:; "
            "frame-ancestors 'none'; base-uri 'none'"
        )
        return response

    @app.get("/")
    async def index():
        if development:
            script = (
                f'<script type="module" src="/static/reload.mjs?revision={revision()}"></script>'
            )
            return HTMLResponse(
                (STATIC / "index.html").read_text().replace("</head>", f"{script}</head>")
            )
        return FileResponse(STATIC / "index.html")

    if development:

        @app.get("/__dev/events")
        async def development_events():
            async def snapshot():
                yield f"retry: 500\ndata: {revision()}\n\n"
                # Finite streams let Uvicorn finish shutdown; EventSource reconnects automatically.
                await asyncio.sleep(1)

            return StreamingResponse(snapshot(), media_type="text/event-stream")

    @app.get("/api/status")
    async def status():
        return {
            "application": "piano-duet",
            "development": development,
            "ready": True,
            "busy": app.state.busy,
            "model": "Aria · 650M · MLX 4-bit",
            "sample_rate": SAMPLE_RATE,
        }

    @app.get("/api/profile")
    async def profile():
        return await asyncio.to_thread(app.state.store.profile)

    @app.get("/api/profile/export")
    async def export_profile():
        return JSONResponse(
            {
                "format": 1,
                "attempts": await asyncio.to_thread(app.state.store.attempts),
                "pieces": app.state.store.pieces(),
            },
            headers={"Content-Disposition": 'attachment; filename="piano-learning-history.json"'},
        )

    @app.get("/api/attempts/{attempt_id}")
    async def attempt_detail(attempt_id: UUID):
        rows = await asyncio.to_thread(app.state.store.attempts)
        found = [row for row in rows if row["id"] == str(attempt_id)]
        if not found:
            raise HTTPException(404, "Unknown performance")
        attempt = found[0]
        if attempt["prompt"]["family"] == "reading":
            assessment = attempt["assessment"]
            assessment["fluency"] = measure_landings(
                assessment.get("fluency", []), assessment["observations"], attempt["context"]
            )
        return attempt

    @app.post("/api/attempts/{attempt_id}/exclude")
    async def exclude_attempt(attempt_id: UUID, payload: ExcludeRequest):
        rows = await asyncio.to_thread(app.state.store.attempts)
        if not any(row["id"] == str(attempt_id) for row in rows):
            raise HTTPException(404, "Unknown performance")
        await asyncio.to_thread(app.state.store.exclude, str(attempt_id), payload.excluded)
        return await asyncio.to_thread(app.state.store.profile)

    @app.exception_handler(ScoreError)
    async def score_error(request: Request, error: ScoreError):
        filename = request.query_params.get("filename")
        return JSONResponse({"detail": f"Could not import {filename}: {error}" if filename else str(error)}, status_code=400)

    @app.get("/api/library")
    async def library():
        store = app.state.store
        songs = [summary(song, store.plays(song["id"])) for song in store.songs()]
        imported = {song["title"].casefold() for song in songs}
        return {"songs": songs, "catalog": [item for item in CATALOG if item["title"].casefold() not in imported]}

    @app.post("/api/library/import")
    async def import_song(request: Request, filename: str = Query(min_length=1, max_length=200),
                          title: str | None = Query(None, max_length=120), artist: str | None = Query(None, max_length=120)):
        data = await request.body()
        if not data or len(data) > 8_000_000:
            raise HTTPException(400, "Import a score file under 8 MB")
        song = build_song(parse_score(filename, data), title, artist, filename)
        stored = app.state.store.add_song({"id": str(uuid4()), **song})
        return summary(stored, [])

    @app.post("/api/library/youtube")
    async def import_youtube(payload: YoutubeRequest):
        check_url(payload.url)
        if app.state.busy or app.state.reading_busy:
            raise HTTPException(409, "The piano is processing another performance")
        app.state.busy = True
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        cancel = Event()

        def emit(event):
            loop.call_soon_threadsafe(queue.put_nowait, event)

        def perform():
            audio, video = fetch_audio(payload.url, lambda progress: emit({"type": "downloading", "progress": progress}), cancel)
            if app.state.recording is None:
                app.state.recording = RecordingTranscriber()
            notes = app.state.recording.transcribe(
                audio, cancel, lambda progress: emit({"type": "transcribing", "progress": progress})
            )
            if cancel.is_set():
                return
            emit({"type": "arranging", "notes": len(notes)})
            song = build_song(performance_to_score(notes), video["title"], video["channel"], "YouTube", transcribed=True)
            stored = app.state.store.add_song({"id": str(uuid4()), **song, "url": video["url"]})
            emit({"type": "song", "song": summary(stored, [])})

        future = executor.submit(perform)

        def finished(job):
            error = job.exception()
            if error is not None:
                if not isinstance(error, ScoreError):
                    logger.error("YouTube import failed", exc_info=(type(error), error, error.__traceback__))
                emit({"type": "error", "message": str(error)})
            loop.call_soon_threadsafe(setattr, app.state, "busy", False)
            emit(None)

        future.add_done_callback(finished)

        async def stream():
            try:
                while (event := await queue.get()) is not None:
                    yield json.dumps(event) + "\n"
            finally:
                cancel.set()

        return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})

    @app.get("/api/library/{song_id}")
    async def library_song(song_id: UUID):
        song = app.state.store.song(str(song_id))
        if not song:
            raise HTTPException(404, "Unknown song")
        return {**song, "stats": song_stats(song, app.state.store.plays(song["id"]))}

    @app.put("/api/library/{song_id}")
    async def update_song(song_id: UUID, payload: SongEditRequest):
        song = app.state.store.song(str(song_id))
        if not song:
            raise HTTPException(404, "Unknown song")
        try:
            edited = edit_song(song, payload.bpm, payload.meter, (payload.tonic, payload.mode),
                               [note.model_dump() for note in payload.notes])
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        app.state.store.update_song(edited)
        return {**edited, "stats": song_stats(edited, app.state.store.plays(edited["id"]))}

    @app.post("/api/library/{song_id}/revert")
    async def revert(song_id: UUID):
        song = app.state.store.song(str(song_id))
        if not song:
            raise HTTPException(404, "Unknown song")
        try:
            reverted = revert_song(song)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        app.state.store.update_song(reverted)
        return {**reverted, "stats": song_stats(reverted, app.state.store.plays(reverted["id"]))}

    @app.delete("/api/library/{song_id}")
    async def delete_song(song_id: UUID):
        if not app.state.store.song(str(song_id)):
            raise HTTPException(404, "Unknown song")
        app.state.store.delete_song(str(song_id))
        return {"deleted": str(song_id)}

    @app.post("/api/library/{song_id}/plays")
    async def save_play(song_id: UUID, payload: SongPlayRequest):
        song = app.state.store.song(str(song_id))
        if not song:
            raise HTTPException(404, "Unknown song")
        total = len(song_attacks(song["notes"]))
        indices = [index for index, _ in payload.attacks]
        if len(set(indices)) != len(indices) or not all(0 <= index < total for index in indices):
            raise HTTPException(400, "Each played attack must be a distinct position in the song")
        app.state.store.add_play(str(payload.id), song["id"], {"attacks": payload.attacks, "version": song_version(song["notes"])})
        return song_stats(song, app.state.store.plays(song["id"]))

    @app.get("/api/pieces")
    async def pieces():
        return app.state.store.pieces()

    @app.post("/api/pieces")
    async def save_piece(payload: PieceRequest):
        if not payload.title.strip():
            raise HTTPException(400, "Give the piece a name")
        rows = await asyncio.to_thread(app.state.store.attempts)
        attempt = next((row for row in rows if row["id"] == str(payload.attempt)), None)
        if not attempt or not attempt["notes"]:
            raise HTTPException(404, "No recognized performance to save")
        notes = [Note.model_validate(n) for n in attempt["notes"]]
        origin = min(n.start for n in notes)
        piece = {
            "id": str(uuid4()),
            "title": payload.title.strip(),
            "challenge": 1,
            "notes": [n.model_copy(update={"start": n.start - origin}).model_dump() for n in notes],
            "key": KeyTracker().observe(notes),
            "bpm": None,
        }
        app.state.store.add_piece(piece)
        return piece

    @app.post("/api/practice/next")
    async def practice_next(payload: PracticeRequest):
        if app.state.busy:
            raise HTTPException(409, "Finish the current performance first")
        if payload.step_by_step and payload.focus != "reading":
            raise HTTPException(400, "Step-by-step practice requires the reading focus")
        if payload.after:
            preceding = app.state.store.task(str(payload.after))
            if not preceding:
                raise HTTPException(404, "Unknown preceding reading score")
            if (
                not payload.step_by_step
                or payload.focus != "reading"
                or preceding["family"] != "reading"
                or preceding["context"].get("interaction") != "step_by_step"
            ):
                raise HTTPException(
                    400, "A preview requires a preceding step-by-step reading score"
                )
        if payload.piece and not any(
            p["id"] == str(payload.piece) for p in app.state.store.pieces()
        ):
            raise HTTPException(404, "Unknown practice piece")
        if payload.stage is not None:
            if payload.focus != "reading":
                raise HTTPException(400, "Only reading practice can replay a stage")
            path = app.state.store.profile()["reading"]["curriculum"]["path"]
            if path[payload.stage - 1]["status"] == "Ahead":
                raise HTTPException(409, f"Stage {payload.stage} is still locked")
        return await asyncio.get_running_loop().run_in_executor(
            executor,
            next_task,
            app.state.store,
            payload.focus,
            None,
            str(payload.piece) if payload.piece else None,
            payload.step_by_step,
            str(payload.after) if payload.after else None,
            app.state.engine.generator.phrase,
            payload.stage,
        )

    @app.get("/api/drills")
    async def drills():
        progress, streak = drill_progress(app.state.store.attempts())
        return {"catalog": catalog(), "progress": progress, "levels": drill_levels(progress), "streak_days": streak}

    @app.post("/api/drills/next")
    async def drills_next(payload: DrillRequest):
        if app.state.busy:
            raise HTTPException(409, "Finish the current performance first")
        try:
            return next_drill(app.state.store, payload.model_dump())
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/practice/{task_id}/aid")
    async def practice_aid(task_id: UUID, payload: AidRequest):
        if app.state.busy:
            raise HTTPException(409, "Finish the current performance first")
        task = app.state.store.task(str(task_id))
        if not task or task["completed"]:
            raise HTTPException(409, "Choose an unfinished exercise first")
        return app.state.store.aid(str(task_id), payload.kind)

    @app.post("/api/export")
    async def export(payload: ExportRequest):
        return Response(
            midi_bytes(payload.notes),
            media_type="audio/midi",
            headers={"Content-Disposition": 'attachment; filename="piano-duet.mid"'},
        )

    @app.post("/api/reading/listen")
    async def listen_reading(
        request: Request, threshold: float = Query(NOTE_THRESHOLD, ge=0.1, le=0.99)
    ):
        if app.state.busy or app.state.reading_busy:
            raise HTTPException(409, "The piano is processing another performance")
        data = await request.body()
        if len(data) != LIVE_WINDOW * 4:
            raise HTTPException(
                400, "Live reading expects two seconds of mono float32 PCM at 16 kHz"
            )
        audio = np.frombuffer(data, dtype="<f4").copy()
        if not np.isfinite(audio).all():
            raise HTTPException(400, "The microphone supplied non-finite audio")
        peak = float(np.max(np.abs(audio)))
        if peak > 1:
            audio /= peak
        if app.state.busy or app.state.reading_busy:
            raise HTTPException(409, "The piano is processing another performance")
        app.state.reading_busy = True
        started = time.perf_counter()
        try:
            notes = await asyncio.get_running_loop().run_in_executor(
                executor, app.state.engine.transcriber.listen, audio, threshold
            )
            return {"notes": notes, "inference_ms": round((time.perf_counter() - started) * 1000)}
        finally:
            app.state.reading_busy = False

    @app.post("/api/reading/complete")
    async def complete_reading(payload: ReadingRequest):
        task = app.state.store.task(str(payload.task))
        if not task or task["family"] != "reading" or task["completed"]:
            raise HTTPException(409, "Choose an unfinished reading score")
        if app.state.store.has_attempt(str(payload.attempt)):
            raise HTTPException(409, "This reading has already been saved")
        groups = [[note.model_dump() for note in group] for group in payload.groups]
        attacks = reading_attacks(task["target"])
        cursor = 0
        for group in groups:
            if cursor >= len(attacks):
                raise HTTPException(400, "The reading contains notes after the score was completed")
            if matches_reading(
                [note["pitch"] for note in group],
                [task["target"][index]["pitch"] for index in attacks[cursor]["indices"]],
            ):
                cursor += 1
        if cursor != len(attacks):
            raise HTTPException(400, "Finish every note in the score before saving the reading")
        context = {
            **task["context"],
            "family": "reading",
            "source": "microphone",
            "interaction": "step_by_step",
            "note_threshold": payload.threshold,
            "reading_timing": {"interruptions": payload.interruptions},
        }
        assessment, notes = assess_reading(task, groups, context)
        app.state.store.record(
            str(payload.attempt),
            {
                "mode": "practice",
                "prompt": task,
                "context": context,
                "notes": notes,
                "reading_attacks": groups,
            },
            assessment,
            str(payload.task),
        )
        return {
            "id": str(payload.attempt),
            "assessment": assessment,
            "xp": score_xp(task, assessment, context),
        }

    @app.post("/api/respond")
    async def respond(
        request: Request,
        session: UUID,
        seconds: float = Query(5, ge=2, le=12),
        temperature: float = Query(0.95, ge=0.5, le=1.3),
        threshold: float = Query(NOTE_THRESHOLD, ge=0.1, le=0.99),
        difficulty: int = Query(3, ge=1, le=5),
        mode: Literal["duet", "learning", "practice", "drills"] = "duet",
        stage: Literal["idea", "repeat"] = "idea",
        lesson: UUID | None = None,
        surprise: float = Query(0.98, ge=0, le=1),
        task: UUID | None = None,
        attempt: UUID | None = None,
        source: Literal["microphone", "demo"] = "microphone",
        listening: str | None = Query(None, max_length=20000),
    ):
        if listening is not None and mode != "drills":
            raise HTTPException(400, "Only drill takes carry what the live attack counter heard")
        # Only the app's own page sends this, so a malformed summary is a bug and fails loudly.
        heard_live = TakeListening.model_validate_json(listening).model_dump() if listening else None
        if mode == "learning" and lesson is None:
            raise HTTPException(400, "Learning requests require a round identifier")
        exercise = mode in ("practice", "drills")
        if task is not None and not exercise:
            raise HTTPException(400, "An exercise target can only be used in practice or drills")
        if app.state.busy:
            raise HTTPException(409, "The previous response is still finishing. Please retry.")
        practice_task = app.state.store.task(str(task)) if task else None
        if exercise and (not practice_task or practice_task["completed"]):
            raise HTTPException(409, "Choose an unfinished exercise before playing")
        if exercise and (mode == "drills") != ("drill" in practice_task):
            raise HTTPException(400, "Drills are played in drill mode, and only drills are")
        if (
            mode == "practice"
            and practice_task["family"] == "ear"
            and not practice_task["context"]["hearings"]
        ):
            raise HTTPException(400, "Hear the melody before playing it back")
        attempt_id = str(attempt or uuid4())
        if app.state.store.has_attempt(attempt_id):
            raise HTTPException(409, "This performance has already been saved")
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
        if len(data) < SAMPLE_RATE // 10 * 4 or len(data) % 4:
            raise HTTPException(400, "Expected mono float32 PCM at 16 kHz")
        audio = np.frombuffer(data, dtype="<f4").copy()
        if not np.isfinite(audio).all():
            raise HTTPException(
                400,
                "The microphone supplied non-finite audio samples. Re-enable the microphone and try again.",
            )
        # Web Audio floats can exceed full scale; one gain for the phrase preserves dynamics.
        peak = float(np.max(np.abs(audio)))
        audio_context = {
            "seconds": len(audio) / SAMPLE_RATE,
            "peak": peak,
            "rms": round(float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))), 6),
            "note_threshold": threshold,
            **({"listening": heard_live} if heard_live else {}),
        }
        if peak > 1:
            audio /= peak
        # Recheck after reading the body: another request could have entered during the await.
        if app.state.busy:
            raise HTTPException(409, "The previous response is still finishing. Please retry.")
        if exercise:
            practice_task = app.state.store.task(str(task))
            if practice_task["completed"]:
                raise HTTPException(
                    409, "This exercise was completed while the audio was being received"
                )
        app.state.busy = True
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        cancel = Event()

        def emit(event):
            loop.call_soon_threadsafe(queue.put_nowait, event)

        def perform():
            engine = app.state.engine
            prompt = practice_task or {
                "title": "Duet phrase" if mode == "duet" else "Your musical idea",
                "target": [],
                "family": "creating",
                "challenge": 1,
            }
            if mode == "learning" and stage == "repeat":
                pending = engine.lesson
                if pending and pending["id"] == str(lesson) and pending["session"] == str(session):
                    prompt = {
                        "title": "Play back the variation",
                        "family": "imitation",
                        "challenge": 1,
                        "target": [n.model_dump() for n in pending["notes"]],
                        "key": pending["key"],
                    }
            context = {
                "notation_visible": False,
                "hearings": 0,
                "reveals": 0,
                "hints": 0,
                "familiar": False,
                **prompt.get("context", {}),
                "source": source,
                "family": prompt["family"],
                "audio": audio_context,
                "session": str(session),
            }
            saved_assessment = None
            recognition = {}

            def observed(event):
                nonlocal saved_assessment
                if event["type"] == "heard" and not cancel.is_set():
                    # Drill takes set their own quality; only other takes read the live model's.
                    if "quality" not in recognition:
                        recognition["quality"] = engine.transcriber.last_quality
                    if mode == "duet":
                        prompt["preceding_music"] = [n.model_dump() for n in engine.history]
                        context["reply_settings"] = {
                            "difficulty": difficulty,
                            "temperature": temperature,
                            "seconds": seconds,
                        }
                    if mode == "learning":
                        context["surprise_threshold"] = surprise
                    notes = [Note.model_validate(n) for n in event["notes"]]
                    context["estimated_key"] = (
                        (KeyTracker().observe(notes) if notes else None)
                        if exercise
                        else event.get("key")
                    )
                    saved_assessment = (assess_drill if mode == "drills" else assess)(
                        prompt, notes, context, recognition["quality"]
                    )
                    inputs = {
                        "mode": mode,
                        "prompt": prompt,
                        "notes": event["notes"],
                        "context": context,
                        "recognition": recognition["quality"],
                    }
                    app.state.store.record(
                        attempt_id,
                        inputs,
                        saved_assessment,
                        str(task) if exercise else None,
                    )
                    emit({"type": "attempt", "id": attempt_id, "assessment": saved_assessment})
                emit(event)

            if exercise:
                started = time.perf_counter()

                def progress(value):
                    emit({"type": "transcribing", "progress": value})

                if mode == "drills":
                    # Whole drill takes go to Transkun 2.0: on microphone-band (16 kHz) benchmark audio
                    # it found 99% of chord notes, against 83-85% for the live model at its 0.80 threshold.
                    if app.state.recording is None:
                        app.state.recording = RecordingTranscriber()
                    notes = app.state.recording.transcribe(
                        resample_poly(audio, RECORDING_RATE, SAMPLE_RATE).astype(np.float32), cancel, progress
                    )
                    recognition["quality"] = DRILL_QUALITY
                else:
                    notes = engine.transcriber.transcribe(audio, threshold, cancel=cancel, on_progress=progress)
                if cancel.is_set():
                    return
                observed(
                    {
                        "type": "heard",
                        "notes": [n.model_dump() for n in notes],
                        "key": practice_task["key"],
                        "transcription_ms": round((time.perf_counter() - started) * 1000),
                    }
                )
                emit({"type": "assessment", "id": attempt_id, "assessment": saved_assessment})
                emit(
                    {
                        "type": "done",
                        "notes": 0,
                        "stage": "complete" if notes else "practice",
                        "empty": not notes,
                    }
                )
            elif mode == "learning":
                engine.learn(
                    audio, str(session), str(lesson), stage, surprise, threshold, observed, cancel
                )
            else:
                engine.respond(
                    audio,
                    str(session),
                    seconds,
                    temperature,
                    threshold,
                    observed,
                    cancel,
                    difficulty,
                )

        future = executor.submit(perform)

        def finished(job):
            error = job.exception()
            if error is not None:
                logger.error(
                    "Piano inference failed", exc_info=(type(error), error, error.__traceback__)
                )
                emit({"type": "error", "message": str(error)})
            loop.call_soon_threadsafe(setattr, app.state, "busy", False)
            emit(None)

        future.add_done_callback(finished)

        async def stream():
            try:
                while (event := await queue.get()) is not None:
                    yield json.dumps(event) + "\n"
            finally:
                cancel.set()

        return StreamingResponse(
            stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"}
        )

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    app.mount("/samples", StaticFiles(directory=SAMPLES), name="samples")
    app.mount("/notation-assets", StaticFiles(directory=NOTATION), name="notation-assets")
    return app
