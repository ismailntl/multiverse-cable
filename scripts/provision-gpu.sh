#!/usr/bin/env bash
# Provision a GPU worker fleet for Multiverse Cable.
#
# Defaults to us-east-1 g6e.xlarge (L40S 48GB) ON-DEMAND, because it has a
# default VPC, real G-instance quota, and the headroom to run the larger LTX
# checkpoints. Spot is cheaper but this account has ZERO G-spot quota in
# us-east-1/us-east-2; ca-central-1 has spot quota but only g5 (A10G 24GB) and
# no default VPC. Override with REGION / ITYPE / MARKET / COUNT.
#
# Each instance self-installs the worker on first boot and carries an idle
# watchdog that powers the box off after 45 idle minutes, so a crashed
# orchestrator can't quietly burn credits.
#
# Usage:
#   AWS_PROFILE=376129873757_AdministratorAccess bash scripts/provision-gpu.sh
#   COUNT=4 bash scripts/provision-gpu.sh        # 4-GPU fleet
#   MARKET=spot REGION=ca-central-1 ITYPE=g5.xlarge bash scripts/provision-gpu.sh
set -euo pipefail

REGION="${REGION:-us-east-1}"
DISK_GB="${DISK_GB:-300}"
HF_TOKEN="${HF_TOKEN:-}"                    # required for gated repos (LTX-2.5)
MODEL_ID="${MODEL_ID:-}"                    # pin a repo; empty = worker autodetects
PIPELINE="${PIPELINE:-auto}"
STEPS="${STEPS:-8}"                         # distilled checkpoints sample in ~8
AI_TARGET="${AI_TARGET:-}"                  # terminate once library hits this
PLATFORM_URL="${PLATFORM_URL:-https://multiversecable.com}"   # LTX-2 weights + HF cache; 300 was too tight for LTX-2.5
ITYPE="${ITYPE:-g6e.xlarge}"
COUNT="${COUNT:-1}"
MARKET="${MARKET:-on-demand}"
NAME=mc-gpu-worker
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_IP="${PLATFORM_IP:-$(curl -s https://checkip.amazonaws.com)}"

aws() { command aws --region "$REGION" "$@"; }

echo "== $COUNT x $ITYPE ($MARKET) in $REGION; worker reachable only from $PLATFORM_IP =="

# Reuse a token across the fleet so one env var authenticates every worker
if [ -f "$ROOT/data/instance.json" ]; then
  TOKEN=$(python3 -c "import json;print(json.load(open('$ROOT/data/instance.json'))['token'])" 2>/dev/null || openssl rand -hex 24)
else
  TOKEN="$(openssl rand -hex 24)"
fi

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" = "None" ] && { echo "ERROR: no default VPC in $REGION"; exit 1; }

# Not every AZ offers every GPU type, and the ones that do run out of capacity —
# collect every candidate public subnet and try them in turn at launch time.
SUBNETS=""
for AZ in $(aws ec2 describe-instance-type-offerings --location-type availability-zone \
    --filters Name=instance-type,Values="$ITYPE" --query 'InstanceTypeOfferings[].Location' --output text); do
  S=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$AZ \
    Name=map-public-ip-on-launch,Values=true --query 'Subnets[0].SubnetId' --output text)
  [ -n "$S" ] && [ "$S" != "None" ] && SUBNETS="$SUBNETS $S:$AZ"
done
[ -z "$SUBNETS" ] && { echo "ERROR: no public subnet in an AZ offering $ITYPE"; exit 1; }
echo "vpc=$VPC candidate subnets:$SUBNETS"

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG=$(aws ec2 create-security-group --group-name $NAME --description "multiverse-cable GPU worker" \
    --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 8189 --cidr "$PLATFORM_IP/32" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22   --cidr "$PLATFORM_IP/32" >/dev/null
fi
echo "sg=$SG"

if ! aws ec2 describe-key-pairs --key-names $NAME >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name $NAME --query KeyMaterial --output text > ~/.ssh/$NAME.pem
  chmod 600 ~/.ssh/$NAME.pem
fi

AMI=$(aws ssm get-parameter \
  --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id \
  --query Parameter.Value --output text)
echo "ami=$AMI"

WORKER_B64=$(gzip -9 -c "$ROOT/gpu-worker/worker.py" | base64 -w0)
REQS=$(cat "$ROOT/gpu-worker/requirements.txt")

USERDATA=$(base64 -w0 <<EOF
#!/bin/bash
exec > /var/log/mc-setup.log 2>&1
set -x
mkdir -p /opt/mc && cd /opt/mc
echo "$WORKER_B64" | base64 -d | gunzip > worker.py
cat > requirements.txt <<'REQEOF'
$REQS
REQEOF
apt-get update -y && apt-get install -y python3-venv python3-pip
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
cat > /etc/systemd/system/mc-worker.service <<'SVCEOF'
[Unit]
Description=multiverse-cable GPU worker
After=network.target
[Service]
Environment=WORKER_TOKEN=$TOKEN
Environment=HF_HOME=/opt/mc/hf
Environment=PRELOAD=1
Environment=HF_TOKEN=$HF_TOKEN
Environment=MODEL_ID=$MODEL_ID
Environment=PIPELINE=$PIPELINE
Environment=STEPS=$STEPS
WorkingDirectory=/opt/mc
ExecStart=/opt/mc/venv/bin/python /opt/mc/worker.py
Restart=always
RestartSec=20
[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload && systemctl enable --now mc-worker
cat > /opt/mc/watchdog.sh <<'WDEOF'
#!/bin/bash
up=\$(cut -d. -f1 /proc/uptime)
[ "\$up" -lt 7200 ] && exit 0
f=/tmp/mc-last-activity
if [ ! -f "\$f" ] || [ \$(( \$(date +%s) - \$(stat -c %Y "\$f") )) -gt 2700 ]; then
  shutdown -h now "mc idle watchdog"
fi
WDEOF
chmod +x /opt/mc/watchdog.sh
cat > /opt/mc/target-watchdog.sh <<'TWEOF'
#!/bin/bash
# Terminate once the library reaches AI_TARGET. Spend then tracks clips
# produced rather than wall-clock, and survives the operator's session ending.
[ -z "\$AI_TARGET" ] && exit 0
n=\$(curl -fsS --max-time 20 "\$PLATFORM_URL/api/state" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["aiClips"])' 2>/dev/null)
case "\$n" in ''|*[!0-9]*) exit 0 ;; esac   # unreachable/garbled: never terminate on a bad read
if [ "\$n" -ge "\$AI_TARGET" ]; then
  logger -t mc "target \$n/\$AI_TARGET reached - terminating"
  shutdown -h now "mc target reached"
fi
TWEOF
chmod +x /opt/mc/target-watchdog.sh
cat > /etc/default/mc-target <<'DEFEOF'
AI_TARGET=$AI_TARGET
PLATFORM_URL=$PLATFORM_URL
DEFEOF
echo '*/5 * * * * root . /etc/default/mc-target && /opt/mc/target-watchdog.sh' > /etc/cron.d/mc-target
echo '*/5 * * * * root /opt/mc/watchdog.sh' > /etc/cron.d/mc-watchdog
touch /tmp/mc-last-activity
EOF
)

UD_BYTES=$(printf %s "$USERDATA" | wc -c)
if [ "$UD_BYTES" -gt 25600 ]; then
  echo "ERROR: user-data is $UD_BYTES bytes, over EC2's 25600 limit" >&2
  exit 1
fi
echo "user-data: $UD_BYTES/25600 bytes"

MARKET_ARGS=()
if [ "$MARKET" = "spot" ]; then
  MARKET_ARGS=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=persistent,InstanceInterruptionBehavior=stop}')
fi

IIDS=""
for PAIR in $SUBNETS; do
  SUBNET="${PAIR%%:*}"; AZ="${PAIR##*:}"
  echo "-- trying $AZ ($SUBNET)"
  if IIDS=$(aws ec2 run-instances \
      --image-id "$AMI" --instance-type "$ITYPE" --key-name $NAME --count "$COUNT" \
      --security-group-ids "$SG" --subnet-id "$SUBNET" \
      "${MARKET_ARGS[@]}" \
      --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$DISK_GB,VolumeType=gp3,DeleteOnTermination=true}" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=multiverse-cable}]" \
      --instance-initiated-shutdown-behavior terminate \
      --user-data "$USERDATA" \
      --query 'Instances[].InstanceId' --output text 2>/tmp/mc-launch-err); then
    echo "launched in $AZ"
    break
  fi
  tail -1 /tmp/mc-launch-err
  IIDS=""
done
[ -z "$IIDS" ] && { echo "ERROR: launch failed in every AZ; last error above"; exit 1; }

echo "instances: $IIDS"

python3 - "$REGION" "${AWS_PROFILE:-default}" "$TOKEN" $IIDS <<'PY' > "$ROOT/data/instance.json"
import json, sys
region, profile, token, *ids = sys.argv[1:]
json.dump({"region": region, "profile": profile, "token": token,
           "instanceIds": ids, "instanceId": ids[0]}, sys.stdout, indent=2)
PY

echo "wrote data/instance.json"

# The platform discovers GPUs through data/worker.json (see lib/generate.js).
# Without this the box boots, loads the model and sits there unused while
# billing by the hour, which is the expensive kind of silent failure.
echo "-- waiting for public IP"
aws ec2 wait instance-running --instance-ids $IIDS
WIP=$(aws ec2 describe-instances --instance-ids $IIDS \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
python3 - "$WIP" "$TOKEN" $IIDS <<'PY' > "$ROOT/data/worker.json"
import json, sys
ip, token, *ids = sys.argv[1:]
json.dump({"workers": [{"url": f"http://{ip}:8189", "token": token, "instanceId": i}
                       for i in ids]}, sys.stdout, indent=2)
PY
echo "wrote data/worker.json -> http://$WIP:8189"
echo "first boot installs torch/diffusers and downloads model weights (~20-40 min)."
echo "watch: bash scripts/gpu-status.sh"
