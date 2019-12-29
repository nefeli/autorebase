#!/bin/bash
docker run -d \
       --restart unless-stopped \
       -p 127.0.0.1:3000:3000 \
       -e APP_ID \
       -e WEBHOOK_SECRET \
       -e PRIVATE_KEY \
       -e DEBUG=* \
       -e VIRTUAL_HOST \
       -e VIRTUAL_PORT \
       -e LETSENCRYPT_HOST \
       -e LETSENCRYPT_EMAIL \
       -v /etc/timezone:/etc/timezone:ro \
       --name autorebase \
       nefelinetworks/autorebase
