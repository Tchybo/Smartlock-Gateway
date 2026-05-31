FROM nodered/node-red:4.0-debian

# Native build tooling pro kompilaci sqlite3 ze source
# (precompiled binárka vyžaduje GLIBC 2.38, ale debian-12 má jen 2.36 na ARM64)
# + sqlite3 CLI pro Init schema flow (.read na schema.sql) a debugging
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 build-essential sqlite3 \
    && rm -rf /var/lib/apt/lists/*

USER node-red

# Pre-install Node-RED modulů. sqlite3 forcujeme build from source,
# aby se zkompiloval proti GLIBC dostupné v tomto image.
RUN npm install --no-audit --no-fund --omit=dev \
       node-red-node-serialport \
    && npm install --build-from-source --no-audit --no-fund --omit=dev \
       node-red-node-sqlite
