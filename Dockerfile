FROM node:22-slim

WORKDIR /app

# onnxruntime-node's prebuilt native binary needs real glibc (not just a
# musl compat shim - gcompat on Alpine got past the missing .so but then
# failed with unresolved fortify symbols like __vsnprintf_chk). Debian slim
# gives it what it actually needs. (Discovered during RAG build - obs
# 1304/1306, shared.)

COPY package*.json ./
RUN npm install --omit=dev

# Bake the embedding model into the image at build time (RAG design, obs
# 1304/1306, shared) - no runtime HuggingFace download, no boot-time egress.
COPY scripts/prefetch-model.js ./scripts/prefetch-model.js
RUN node scripts/prefetch-model.js

COPY src ./src
COPY skills.json ./skills.json

ENV PORT=7784
EXPOSE 7784

VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
