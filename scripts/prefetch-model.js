'use strict';
// Build-time only: downloads the quantized ONNX model once into ./models so
// the runtime image never makes a HuggingFace network call. Run inside the
// Docker build (before COPY of app source), never at container start.
const path = require('node:path');

(async () => {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.localModelPath = path.join(__dirname, '..', 'models');
  env.allowRemoteModels = true; // this script only - fetches once at build time
  console.log('Prefetching Xenova/all-MiniLM-L6-v2 (quantized)...');
  await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  console.log('Model cached to ./models');
})().catch((err) => {
  console.error('prefetch-model failed:', err);
  process.exit(1);
});
