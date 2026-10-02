FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

RUN git clone --depth 1 https://github.com/prostone4/Prometheus-Deobfuscator.git tool \
  && rm -rf tool/.git

COPY index.js patch.js ./
RUN node patch.js

USER node

CMD ["node", "index.js"]
