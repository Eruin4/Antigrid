#!/bin/sh
set -eu
cd /home/eruin/project/antigrid
umask 077
mkdir -p .runtime/tls
if [ -e .runtime/tls/server.key ] || [ -e .runtime/tls/server.crt ]; then
  echo 'Existing LAN certificate found; leaving it unchanged.'
  exit 0
fi
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout .runtime/tls/server.key -out .runtime/tls/server.crt \
  -subj '/CN=Antigrid LAN relay' \
  -addext 'subjectAltName=IP:192.168.0.3' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth'
openssl verify -CAfile .runtime/tls/server.crt -verify_ip 192.168.0.3 .runtime/tls/server.crt
