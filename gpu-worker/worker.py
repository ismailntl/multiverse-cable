"""
Multiverse Cable — self-hosted GPU generation worker.

Runs on an AWS GPU instance (g6e.xlarge / L40S 48GB recommended) and serves
one endpoint the platform's `local` backend calls:

    POST /generate  {"prompt": "...", "duration_sec": 6}
    -> 200 video/mp4 (blocks until the clip is rendered)

Default model is LTX-Video (Lightricks) via diffusers — the fastest open-weight
text-to-video family, which is what makes near-continuous generation on a
single GPU affordable. Swap MODEL_ID to a newer LTX release (e.g. LTX-2.x) or
a Wan 2.x pipeline for higher fidelity at lower throughput; check the
Lightricks/LTX-Video repo for the current recommended checkpoint and pipeline
class before upgrading.
"""

import io
import os
import tempfile
import threading

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("MODEL_ID", "Lightricks/LTX-Video")
WIDTH = int(os.environ.get("WIDTH", "1216"))
HEIGHT = int(os.environ.get("HEIGHT", "704"))
FPS = int(os.environ.get("FPS", "24"))
STEPS = int(os.environ.get("STEPS", "40"))
AUTH_TOKEN = os.environ.get("WORKER_TOKEN", "")  # optional shared secret

app = FastAPI(title="multiverse-cable-gpu-worker")
_lock = threading.Lock()  # one generation at a time; the GPU is the queue
_pipe = None


def get_pipe():
    global _pipe
    if _pipe is None:
        from diffusers import LTXPipeline

        pipe = LTXPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
        pipe.to("cuda")
        _pipe = pipe
    return _pipe


class GenRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    duration_sec: int = Field(default=6, ge=2, le=15)
    token: str = ""


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "cuda": torch.cuda.is_available()}


def touch_activity():
    # The instance's idle watchdog (see setup) powers the box off when this
    # file goes stale, so a crashed orchestrator can't leave the GPU burning.
    try:
        with open("/tmp/ic-last-activity", "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


@app.post("/generate")
def generate(req: GenRequest):
    if AUTH_TOKEN and req.token != AUTH_TOKEN:
        raise HTTPException(401, "bad token")
    touch_activity()

    # LTX wants num_frames ≡ 1 (mod 8) + 1
    num_frames = req.duration_sec * FPS
    num_frames = (num_frames // 8) * 8 + 1

    with _lock:
        pipe = get_pipe()
        result = pipe(
            prompt=req.prompt,
            # House rule: nothing involving minors can ever be generated —
            # belt-and-suspenders on top of prompt-level guardrails.
            negative_prompt=(
                "child, children, kid, kids, toddler, baby, infant, teenager, "
                "teen, minor, young person, school, student, "
                "worst quality, blurry, jittery, distorted, watermark, text overlay, "
                "nude, nsfw, gore"
            ),
            width=WIDTH,
            height=HEIGHT,
            num_frames=num_frames,
            num_inference_steps=STEPS,
        )
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

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8189")))
