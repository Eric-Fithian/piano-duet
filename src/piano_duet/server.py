import asyncio
import json
import logging
import socket
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event
from typing import Literal
from uuid import UUID

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from piano_duet.assets import NOTATION, SAMPLES, require_assets
from piano_duet.generation import PianoGenerator
from piano_duet.key_tracking import KeyTracker
from piano_duet.learning import analyze_phrase, compare_performance
from piano_duet.notes import Note, midi_bytes
from piano_duet.transcription import SAMPLE_RATE, PianoTranscriber

STATIC = Path("src/piano_duet/static")
logger = logging.getLogger("piano_duet")


def main(port=8765, open_browser=True):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        occupied = probe.connect_ex(("127.0.0.1", port)) == 0
    if occupied:
        response = httpx.get(f"http://127.0.0.1:{port}/api/status", timeout=5)
        response.raise_for_status()
        if response.json().get("application") != "piano-duet":
            raise RuntimeError(f"Port {port} is already occupied by another application")
        print(f"Piano Duet is already running at http://127.0.0.1:{port}")
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        return
    require_assets()
    uvicorn.run(
        create_app(port, open_browser),
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,
    )


class ExportRequest(BaseModel):
    notes: list[Note] = Field(min_length=1)


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


def create_app(port=8765, open_browser=False, engine_factory=DuetEngine):
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="piano-inference")

    @asynccontextmanager
    async def lifespan(app):
        print("Loading local piano models and warming up the GPU…", flush=True)
        app.state.engine = await asyncio.get_running_loop().run_in_executor(
            executor, engine_factory
        )
        app.state.busy = False
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
        if request.method == "POST":
            origin = request.headers.get("origin")
            if request.headers.get("x-duet-client") != "1":
                return JSONResponse({"detail": "Missing local app request header"}, status_code=403)
            if origin and origin != str(request.base_url).rstrip("/"):
                return JSONResponse(
                    {"detail": "Cross-origin requests are disabled"}, status_code=403
                )
        response = await call_next(request)
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
        return FileResponse(STATIC / "index.html")

    @app.get("/api/status")
    async def status():
        return {
            "application": "piano-duet",
            "ready": True,
            "busy": app.state.busy,
            "model": "Aria · 650M · MLX 4-bit",
            "sample_rate": SAMPLE_RATE,
        }

    @app.post("/api/export")
    async def export(payload: ExportRequest):
        return Response(
            midi_bytes(payload.notes),
            media_type="audio/midi",
            headers={"Content-Disposition": 'attachment; filename="piano-duet.mid"'},
        )

    @app.post("/api/respond")
    async def respond(
        request: Request,
        session: UUID,
        seconds: float = Query(5, ge=2, le=12),
        temperature: float = Query(0.95, ge=0.5, le=1.3),
        threshold: float = Query(0.75, ge=0.1, le=0.9),
        difficulty: int = Query(3, ge=1, le=5),
        mode: Literal["duet", "learning"] = "duet",
        stage: Literal["idea", "repeat"] = "idea",
        lesson: UUID | None = None,
        surprise: float = Query(0.98, ge=0, le=1),
    ):
        if mode == "learning" and lesson is None:
            raise HTTPException(400, "Learning requests require a round identifier")
        if app.state.busy:
            raise HTTPException(409, "The previous response is still finishing. Please retry.")
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
        if peak > 1:
            audio /= peak
        # Recheck after reading the body: another request could have entered during the await.
        if app.state.busy:
            raise HTTPException(409, "The previous response is still finishing. Please retry.")
        app.state.busy = True
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        cancel = Event()

        def emit(event):
            loop.call_soon_threadsafe(queue.put_nowait, event)

        if mode == "learning":
            future = executor.submit(
                app.state.engine.learn,
                audio,
                str(session),
                str(lesson),
                stage,
                surprise,
                threshold,
                emit,
                cancel,
            )
        else:
            future = executor.submit(
                app.state.engine.respond,
                audio,
                str(session),
                seconds,
                temperature,
                threshold,
                emit,
                cancel,
                difficulty,
            )

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
