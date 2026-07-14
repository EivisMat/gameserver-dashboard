#!/bin/bash
# /opt/dashboard/wg-helper.sh
# Privileged WireGuard operations, run via sudo by the dashboard user
set -euo pipefail

case "${1:-}" in
  generate-keys)
    PRIV=$(wg genkey)
    PUB=$(echo "$PRIV" | wg pubkey)
    PSK=$(wg genpsk)
    echo "$PRIV"
    echo "$PUB"
    echo "$PSK"
    ;;
  add-peer)
    # Args: public_key preshared_key allowed_ip
    wg set wg0 peer "$2" preshared-key <(echo "$3") allowed-ips "$4/32"
    # Persist to conf
    cat >> /etc/wireguard/wg0.conf <<PEER

[Peer]
PublicKey = $2
PresharedKey = $3
AllowedIPs = $4/32
PEER
    ;;
  remove-peer)
    # Args: public_key
    wg set wg0 peer "$2" remove
    # Remove from conf file
    python3 -c "
import re, sys
conf = open('/etc/wireguard/wg0.conf').read()
pattern = r'\n\[Peer\]\s*\n[^\[]*?PublicKey\s*=\s*' + re.escape(sys.argv[1]) + r'[^\[]*'
conf = re.sub(pattern, '', conf, flags=re.DOTALL)
open('/etc/wireguard/wg0.conf', 'w').write(conf)
" "$2"
    ;;
  get-server-pubkey)
    cat /etc/wireguard/server_public.key
    ;;
  list-peers)
    wg show wg0 dump
    ;;
  *)
    echo "Unknown command: ${1:-}" >&2
    exit 1
    ;;
esac
