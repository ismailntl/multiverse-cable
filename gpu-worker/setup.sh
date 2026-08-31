#!/usr/bin/env bash
# Run ON the GPU instance (Ubuntu Deep Learning AMI recommended — comes with
# NVIDIA drivers + CUDA preinstalled). Installs the worker and runs it on :8189.
#
# Example instance launch (adjust profile/region/key/sg to your account):
#   aws ec2 run-instances \
#     --image-id <deep-learning-ami-gpu-pytorch-ubuntu22> \
#     --instance-type g6e.xlarge \
#     --key-name <your-key> \
#     --security-group-ids <sg-allowing-8189-from-your-server> \
#     --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200}'
#
# Then on the box:  bash setup.sh   (first generation downloads model weights)
set -euo pipefail

cd "$(dirname "$0")"

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "Starting worker on :8189 (set WORKER_TOKEN for auth, MODEL_ID to swap models)"
exec python worker.py
