#!/usr/bin/env bash
# Show the GPU fleet's state, public IPs, and worker health.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
eval "$(python3 -c "
import json
d=json.load(open('$ROOT/data/instance.json'))
print(f'REGION={d[\"region\"]}')
print(f'PROFILE={d[\"profile\"]}')
print('IIDS=\"' + ' '.join(d.get('instanceIds') or [d['instanceId']]) + '\"')
")"
export AWS_PROFILE="$PROFILE"

aws ec2 describe-instances --region "$REGION" --instance-ids $IIDS \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,PublicIpAddress]' --output text |
while read -r id type state ip; do
  printf '%s  %-12s %-10s %-15s ' "$id" "$type" "$state" "${ip:-–}"
  if [ "$state" = "running" ] && [ -n "$ip" ] && [ "$ip" != "None" ]; then
    h=$(curl -s --max-time 5 "http://$ip:8189/health" 2>/dev/null)
    if [ -n "$h" ]; then
      python3 -c "
import json,sys
d=json.loads('''$h''')
l=d.get('loaded') or {}
print('worker:', 'READY' if d.get('ok') else 'loading', '| model:', l.get('model') or '—', '| gpu:', d.get('gpu') or '—')
print('   error:', (l.get('error') or '')[:200]) if l.get('error') else None
" 2>/dev/null || echo "worker: (bad health payload)"
    else
      echo "worker: not answering yet (installing deps / downloading weights)"
    fi
  else
    echo
  fi
done
