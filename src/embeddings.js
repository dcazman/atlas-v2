'use strict';
// Local, in-process embedding module for Atlas hybrid search.
// Uses @huggingface/transformers (transformers.js) with a quantized ONNX
// model baked into the Docker image at build time - no runtime download,
// no external egress. Model files live in /app/models (see Dockerfile).
//
// Design ref: shared Atlas entity "Atlas RAG / Semantic Search (Design)".

const path = require('node:path');

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIM = 384;

let pipelinePromise = null;

function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // No network calls - model must already exist at localModelPath.
      env.allowRemoteModels = false;
      env.localModelPath = path.join(__dirname, '..', 'models');
      env.backends.onnx.numThreads = 1;
      return pipeline('feature-extraction', MODEL_NAME, { quantized: true });
    })().catch((err) => {
      pipelinePromise = null; // allow retry on next call
      throw err;
    });
  }
  return pipelinePromise;
}

// Returns a Float32Array of length MODEL_DIM, mean-pooled and L2-normalized
// (so cosine similarity reduces to a plain dot product).
async function embed(text) {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Float32Array.from(output.data);
}

function toBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBuffer(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

module.exports = { embed, toBuffer, fromBuffer, dot, MODEL_NAME, MODEL_DIM };
