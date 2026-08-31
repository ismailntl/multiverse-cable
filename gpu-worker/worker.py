"""
Multiverse Cable — self-hosted GPU generation worker.

Serves one endpoint the platform's `local` backend calls:

    POST /generate  {"prompt": "...", "duration_sec": 6, "token": "..."}
    -> 200 video/mp4 (blocks until the clip is rendered)
    GET  /health    -> which model actually loaded, and whether CUDA is live

Model selection is deliberately defensive: the LTX family moves fast and the
exact repo/pipeline pairing changes between releases, so we try a list of
candidates at startup and keep the first that loads. Set MODEL_ID to pin one.
Distilled/fp8 checkpoints come first — they sample in ~8 steps, which is what
makes bulk generation affordable.
"""

import os
import tempfile
import threading
import traceback

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

WIDTH = int(os.environ.get("WIDTH", "1280"))
HEIGHT = int(os.environ.get("HEIGHT", "704"))
FPS = int(os.environ.get("FPS", "24"))
AUTH_TOKEN = os.environ.get("WORKER_TOKEN", "")
# GPUs smaller than this get CPU offload rather than fully-resident weights
FULL_GPU_MIN_GB = float(os.environ.get("FULL_GPU_MIN_GB", "40"))

# Reduces fragmentation-driven OOM on tight cards
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# (repo id, diffusers pipeline class name, inference steps, min GPU GB)
# The 13B checkpoints need ~26GB in bf16. Module-level CPU offload can't help:
# offload swaps whole modules, and a single 13B transformer must be resident
# for its forward pass. So a 24GB card gets the small model, not a slow one.
# LTX-2.5 carries an audio_vae and generates a synchronized audio track, which
# is why it leads the list: the older 0.9.x checkpoints are silent. "auto" uses
# diffusers' DiffusionPipeline so we don't have to guess the pipeline class as
# the family evolves.
ALL_CANDIDATES = [
    ("Lightricks/LTX-2.5-Diffusers", "auto", 8, 40),
    ("Lightricks/LTX-2.3", "auto", 8, 40),
    ("Lightricks/LTX-2", "auto", 8, 40),
    ("Lightricks/LTX-Video-0.9.8-13B-distilled", "LTXPipeline", 8, 40),
    ("Lightricks/LTX-Video-0.9.5", "LTXPipeline", 40, 16),
    ("Lightricks/LTX-Video", "LTXPipeline", 40, 16),
]


def candidates_for_gpu():
    gb = torch.cuda.get_device_properties(0).total_memory / 1e9 if torch.cuda.is_available() else 0
    picks = [(r, p, s) for (r, p, s, need) in ALL_CANDIDATES if gb >= need]
    print(f"[worker] {gb:.0f}GB GPU -> {len(picks)} candidate model(s)", flush=True)
    if os.environ.get("MODEL_ID"):
        picks.insert(0, (os.environ["MODEL_ID"], os.environ.get("PIPELINE", "LTXPipeline"),
                         int(os.environ.get("STEPS", "8"))))
    return picks

app = FastAPI(title="multiverse-cable-gpu-worker")
_lock = threading.Lock()  # one generation at a time; the GPU is the queue
_pipe = None
_loaded = {"model": None, "steps": None, "error": None}


def get_pipe():
    global _pipe
    if _pipe is not None:
        return _pipe
    import diffusers

    errors = []
    for repo, pipe_cls_name, steps in candidates_for_gpu():
        try:
            if pipe_cls_name == "auto":
                pipe_cls = diffusers.DiffusionPipeline
            else:
                pipe_cls = getattr(diffusers, pipe_cls_name, None)
            if pipe_cls is None:
                errors.append(f"{repo}: diffusers has no {pipe_cls_name}")
                continue
            print(f"[worker] trying {repo} ({pipe_cls_name})", flush=True)
            kwargs = {"torch_dtype": torch.bfloat16, "low_cpu_mem_usage": True}
            if os.environ.get("HF_TOKEN"):
                kwargs["token"] = os.environ["HF_TOKEN"]
            # A 19B model is ~38GB in bf16 — larger than this box's RAM, so
            # materialising it on the CPU before .to("cuda") gets the process
            # OOM-killed. device_map streams each shard straight to the GPU.
            device_map = os.environ.get("DEVICE_MAP", "cuda" if torch.cuda.is_available() else "")
            if device_map:
                kwargs["device_map"] = device_map
            pipe = pipe_cls.from_pretrained(repo, **kwargs)
            # A 13B model in bf16 fits in 22GB but leaves nothing for
            # activations, so it loads fine and then OOMs mid-generation.
            # Below ~40GB, offload layers to CPU instead of pinning all weights.
            total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
            if device_map:
                pass  # accelerate already placed the weights
            elif total_gb < FULL_GPU_MIN_GB:
                print(f"[worker] {total_gb:.0f}GB GPU -> model CPU offload", flush=True)
                pipe.enable_model_cpu_offload()
            else:
                try:
                    pipe.to("cuda")
                except torch.cuda.OutOfMemoryError:
                    print(f"[worker] {repo} OOM on .to(cuda), using CPU offload", flush=True)
                    pipe.enable_model_cpu_offload()
            if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
                pipe.vae.enable_tiling()
            _pipe = pipe
            _loaded.update({"model": repo, "steps": steps, "error": None,
                            "has_audio_vae": hasattr(pipe, "audio_vae") or hasattr(pipe, "vae_audio")})
            print(f"[worker] loaded {repo}", flush=True)
            return _pipe
        except Exception as e:  # noqa: BLE001 - try the next candidate
            msg = f"{repo}: {type(e).__name__}: {e}"
            print(f"[worker] FAILED {msg}", flush=True)
            traceback.print_exc()
            errors.append(msg)

    _loaded["error"] = " | ".join(errors)
    raise RuntimeError(f"no model could be loaded: {_loaded['error']}")


class GenRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    duration_sec: int = Field(default=6, ge=2, le=30)
    token: str = ""


def _mux_audio(video_path, audio_array, sample_rate=None):
    """Write the generated audio beside the video and mux them into one mp4."""
    import subprocess

    import numpy as np

    try:
        import soundfile as sf
    except ImportError:
        print("[worker] soundfile missing, shipping video without audio", flush=True)
        return video_path

    arr = audio_array
    if hasattr(arr, "detach"):
        arr = arr.detach().float().cpu().numpy()
    arr = np.asarray(arr)
    if arr.ndim > 2:
        arr = arr.squeeze()
    if arr.ndim == 2 and arr.shape[0] < arr.shape[1]:
        arr = arr.T  # (channels, samples) -> (samples, channels)

    sr = int(sample_rate or os.environ.get("AUDIO_SR", "48000"))
    wav = video_path.replace(".mp4", ".wav")
    out = video_path.replace(".mp4", "-av.mp4")
    try:
        sf.write(wav, arr, sr)
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-i", wav,
             "-c:v", "copy", "-c:a", "aac", "-shortest", out],
            check=True, capture_output=True, timeout=180,
        )
        os.unlink(video_path)
        os.unlink(wav)
        return out
    except Exception as e:  # noqa: BLE001 - never fail a clip over its audio
        print(f"[worker] audio mux failed ({e}); shipping video only", flush=True)
        for f in (wav, out):
            try:
                os.unlink(f)
            except OSError:
                pass
        return video_path


def touch_activity():
    # The instance's idle watchdog powers the box off when this file goes
    # stale, so a crashed orchestrator can't leave the GPU burning credits.
    try:
        with open("/tmp/mc-last-activity", "w") as f:
            f.write("1")
    except OSError:
        pass


@app.get("/health")
def health():
    return {
        "ok": _pipe is not None,
        "loaded": _loaded,
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


@app.post("/warmup")
def warmup():
    touch_activity()
    with _lock:
        get_pipe()
    return {"ok": True, "loaded": _loaded}


@app.post("/generate")
def generate(req: GenRequest):
    if AUTH_TOKEN and req.token != AUTH_TOKEN:
        raise HTTPException(401, "bad token")
    touch_activity()

    with _lock:
        pipe = get_pipe()
        steps = _loaded["steps"] or 8
        # LTX wants num_frames ≡ 1 (mod 8)
        num_frames = max(9, (req.duration_sec * FPS // 8) * 8 + 1)
        try:
            result = pipe(
                prompt=req.prompt,
                # House rule: nothing involving minors can ever be generated —
                # belt-and-suspenders on top of the prompt-level guardrails.
                negative_prompt=(
                    "child, children, kid, kids, toddler, baby, infant, teenager, "
                    "teen, minor, young person, school, student, "
                    "worst quality, blurry, jittery, distorted, watermark, text overlay, "
                    "nude, nsfw, gore"
                ),
                width=WIDTH,
                height=HEIGHT,
                num_frames=num_frames,
                num_inference_steps=steps,
            )
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            raise HTTPException(500, f"generation failed: {type(e).__name__}: {e}")
        frames = result.frames[0]
        # LTX-2.x returns a synchronized audio track alongside the frames
        audio = getattr(result, "audio", None)
        if audio is not None and not isinstance(audio, (list, tuple)):
            audio = [audio]

    from diffusers.utils import export_to_video

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        path = tmp.name
    try:
        export_to_video(frames, path, fps=FPS)
        if audio:
            path = _mux_audio(path, audio[0])
        with open(path, "rb") as f:
            data = f.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    touch_activity()
    return Response(content=data, media_type="video/mp4")


if __name__ == "__main__":
    import uvicorn

    if os.environ.get("PRELOAD", "1") == "1":
        def _warm():
            try:
                get_pipe()
            except Exception:  # noqa: BLE001 - /health reports the reason
                traceback.print_exc()

        threading.Thread(target=_warm, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8189")))
