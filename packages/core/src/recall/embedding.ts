import type { RecallSettings } from '@engramweave/contracts';
import { CoreError } from '../errors.js';

async function jsonRequest(endpoint: string, route: string, body: unknown, key: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
  const signals = [AbortSignal.timeout(timeout * 1000), ...(signal ? [signal] : [])];
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any(signals), redirect: 'error',
    });
    if (!response.ok) throw new CoreError('EXECUTION_FAILED', `Recall service returned HTTP ${response.status}`, 503);
    if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error();
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4 * 1024 * 1024) throw new Error(); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError('EXECUTION_FAILED', 'Recall service failed, timed out, or returned an invalid response', 503);
  }
}
export function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new CoreError('INVALID_MODEL_OUTPUT', 'Embedding vector is invalid', 422);
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw new CoreError('INVALID_MODEL_OUTPUT', 'Embedding vector has invalid length', 422);
  return value.map(v => v / norm);
}
export async function embed(settings: RecallSettings, inputs: string[], key: string, signal?: AbortSignal): Promise<number[][]> {
  if (!settings.model.trim() || !settings.endpoint) throw new CoreError('CONFIG_ERROR', 'Configure an Embedding endpoint and model', 400);
  const result = await jsonRequest(settings.endpoint, 'embeddings', { model: settings.model, input: inputs, encoding_format: 'float' }, key, settings.timeout_seconds, signal) as { data?: { index: number; embedding: unknown }[] };
  if (!Array.isArray(result?.data) || result.data.length !== inputs.length) throw new CoreError('INVALID_MODEL_OUTPUT', 'Embedding count does not match inputs', 422);
  const ordered: number[][] = Array(inputs.length); const indices = new Set<number>();
  for (const item of result.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= inputs.length || indices.has(item.index)) throw new CoreError('INVALID_MODEL_OUTPUT', 'Embedding indices are invalid', 422);
    indices.add(item.index); ordered[item.index] = normalizeVector(item.embedding);
  }
  if (ordered.some(vector => vector.length !== ordered[0]!.length)) throw new CoreError('INVALID_MODEL_OUTPUT', 'Embedding dimensions differ within the response', 422);
  return ordered;
}
export async function rerank(settings: RecallSettings, query: string, documents: string[], key: string, signal?: AbortSignal): Promise<number[]> {
  const response = await jsonRequest(settings.reranker_endpoint, 'rerank', { model: settings.reranker_model, query, documents, top_n: documents.length }, key, settings.timeout_seconds, signal) as { results?: { index: number; relevance_score: number }[] };
  if (!Array.isArray(response?.results) || response.results.length !== documents.length) throw new CoreError('INVALID_MODEL_OUTPUT', 'Reranker result count is invalid', 422);
  const scores: number[] = Array(documents.length); const indices = new Set<number>();
  for (const item of response.results) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= documents.length || indices.has(item.index) || !Number.isFinite(item.relevance_score)) throw new CoreError('INVALID_MODEL_OUTPUT', 'Reranker scores or indices are invalid', 422);
    indices.add(item.index); scores[item.index] = item.relevance_score;
  }
  return scores;
}
export const queryInput = (settings: RecallSettings, query: string) => settings.query_instruction.trim() ? `Instruct: ${settings.query_instruction}\nQuery: ${query}` : query;
