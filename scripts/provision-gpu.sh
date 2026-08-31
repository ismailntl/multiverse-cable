#!/usr/bin/env bash
# One-time provisioning of the GPU spot worker for scheduled batch generation.
#
# Creates: security group (worker port open only to this server's IP), key pair,
# and a PERSISTENT SPOT g5.xlarge (A10G 24GB) in ca-central-1 that installs the
# worker on first boot and can be stopped/started daily by scripts/batch.js.
# The instance carries an idle watchdog: if no generation happens for 45 min it
# powers itself off, so a crashed orchestrator can't burn credits.
#
# Usage: AWS_PROFILE=376129873757_AdministratorAccess bash scripts/provision-gpu.sh
set -euo pipefail

REGION="${REGION:-ca-central-1}"
ITYPE="${ITYPE:-g5.xlarge}"
NAME=ic-gpu-worker
PLATFORM_IP="${PLATFORM_IP:-$(curl -s https://checkip.amazonaws.com)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$(openssl rand -hex 24)"

aws() { command aws --region "$REGION" "$@"; }

echo "== provisioning $ITYPE spot in $REGION; worker reachable only from $PLATFORM_IP =="

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG=$(aws ec2 create-security-group --group-name $NAME --description "multiverse-cable GPU worker" \
    --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 8189 --cidr "$PLATFORM_IP/32"
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$PLATFORM_IP/32"
fi
echo "security group: $SG"

if ! aws ec2 describe-key-pairs --key-names $NAME >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name $NAME --query KeyMaterial --output text > ~/.ssh/$NAME.pem
  chmod 600 ~/.ssh/$NAME.pem
fi

AMI=$(aws ssm get-parameter \
  --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id \
  --query Parameter.Value --output text)
echo "AMI: $AMI"

USERDATA=$(cat <<EOF | base64 -w0
#!/bin/bash
set -x
mkdir -p /opt/ic && cd /opt/ic
cat > worker.py.b64 <<'PYEOF'
$(base64 -w0 "$ROOT/gpu-worker/worker.py")
PYEOF
base64 -d worker.py.b64 > worker.py
cat > requirements.txt <<'REQEOF'
$(cat "$ROOT/gpu-worker/requirements.txt")
REQEOF
apt-get update -y && apt-get install -y python3-venv python3-pip
python3 -m venv venv && ./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
cat > /etc/systemd/system/ic-worker.service <<'SVCEOF'
[Unit]
Description=multiverse-cable GPU worker
After=network.target
[Service]
Environment=WORKER_TOKEN=$TOKEN
Environment=HF_HOME=/opt/ic/hf
WorkingDirectory=/opt/ic
ExecStart=/opt/ic/venv/bin/python /opt/ic/worker.py
Restart=always
[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload && systemctl enable --now ic-worker
# Idle watchdog: power off if no generation activity for 45 min (and 30 min uptime grace)
cat > /opt/ic/watchdog.sh <<'WDEOF'
#!/bin/bash
up=\$(cut -d. -f1 /proc/uptime)
[ "\$up" -lt 1800 ] && exit 0
f=/tmp/ic-last-activity
if [ ! -f "\$f" ] || [ \$(( \$(date +%s) - \$(stat -c %Y "\$f") )) -gt 2700 ]; then
  shutdown -h now "ic idle watchdog"
fi
WDEOF
chmod +x /opt/ic/watchdog.sh
echo '*/5 * * * * root /opt/ic/watchdog.sh' > /etc/cron.d/ic-watchdog
touch /tmp/ic-last-activity
EOF
)

IID=$(aws ec2 run-instances \
  --image-id "$AMI" --instance-type "$ITYPE" --key-name $NAME \
  --security-group-ids "$SG" \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=persistent,InstanceInterruptionBehavior=stop}' \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=150,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=multiverse-cable}]" \
  --user-data "$USERDATA" \
  --query 'Instances[0].InstanceId' --output text)

echo "instance: $IID (installing worker + model on first boot, ~15-30 min)"

cat > "$ROOT/data/instance.json" <<EOF
{ "instanceId": "$IID", "region": "$REGION", "profile": "${AWS_PROFILE:-default}", "token": "$TOKEN" }
EOF
echo "wrote data/instance.json — scripts/batch.js drives it from here"
