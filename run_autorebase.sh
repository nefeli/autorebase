#!/bin/bash
docker run -d \
       --restart unless-stopped \
       -p 127.0.0.1:3000:3000 \
       -e APP_ID \
       -e WEBHOOK_SECRET \
       -e PRIVATE_KEY_PATH \
       -e DEBUG=* \
       -v /etc/timezone:/etc/timezone:ro \
       --name autorebase \
       nefelinetworks/autorebase
