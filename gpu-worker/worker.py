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
ALL_CANDIDATES = [
    ("Lightricks/LTX-2.3-fp8", "LTXPipeline", 8, 24),
    ("Lightricks/LTX-2.3", "LTXPipeline", 8, 40),
    ("Lightricks/LTX-2.5-Diffusers", "LTXPipeline", 8, 40),
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
            pipe_cls = getattr(diffusers, pipe_cls_name, None)
            if pipe_cls is None:
                errors.append(f"{repo}: diffusers has no {pipe_cls_name}")
                continue
            print(f"[worker] trying {repo} ({pipe_cls_name})", flush=True)
            pipe = pipe_cls.from_pretrained(repo, torch_dtype=torch.bfloat16)
            # A 13B model in bf16 fits in 22GB but leaves nothing for
            # activations, so it loads fine and then OOMs mid-generation.
            # Below ~40GB, offload layers to CPU instead of pinning all weights.
            total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
            if total_gb < FULL_GPU_MIN_GB:
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
            _loaded.update({"model": repo, "steps": steps, "error": None})
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

    from diffusers.utils import export_to_video

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        path = tmp.name
    try:
        export_to_video(frames, path, fps=FPS)
        with open(path, "rb") as f:
            data = f.read()
    finally:
        os.unlink(path)

    touch_activity()
    return Response(content=data, media_type="video/mp4")


if __name__ == "__main__":
    import uvicorn

    if os.environ.get("PRELOAD", "1") == "1":
        try:
            get_pipe()
        except Exception:  # noqa: BLE001 - serve /health so we can see why
            traceback.print_exc()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8189")))
