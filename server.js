import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const keys = new Map(); // session-only process memory
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(root, "public")));

const providers = [
  { id: "gemini", name: "Google Gemini", envName: "GEMINI_API_KEY", docs: "https://ai.google.dev/gemini-api/docs" },
  { id: "groq", name: "Groq", envName: "GROQ_API_KEY", docs: "https://console.groq.com/docs" },
  { id: "openrouter", name: "OpenRouter", envName: "OPENROUTER_API_KEY", docs: "https://openrouter.ai/models" },
  { id: "openai", name: "OpenAI", envName: "OPENAI_API_KEY", docs: "https://platform.openai.com/docs" },
  { id: "huggingface", name: "Hugging Face Inference", envName: "HF_TOKEN", docs: "https://huggingface.co/docs/inference-providers" },
  { id: "cohere", name: "Cohere", envName: "COHERE_API_KEY", docs: "https://docs.cohere.com" }
];

// Free-only text models. Groq entries are taken from its documented Free Plan limits;
// OpenAI is intentionally excluded because API models are metered/billed and ChatGPT Free
// does not include API usage. Live catalogs below add only routes explicitly marked free.
const groqFreeSpecs = [
  { provider: "groq", name: "GPT OSS 20B (Groq Free Plan)", id: "openai/gpt-oss-20b", task: "Text-to-text", access: "Groq Free Plan limits listed: 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day (account/model limits may vary).", note: "Free-plan candidate from Groq's published rate-limit table; requires a Groq API key and current model access." },
  { provider: "groq", name: "GPT OSS 120B (Groq Free Plan)", id: "openai/gpt-oss-120b", task: "Text-to-text", access: "Groq Free Plan limits listed: 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day (account/model limits may vary).", note: "Free-plan candidate from Groq's published rate-limit table; requires a Groq API key and current model access." },
  { provider: "groq", name: "Qwen 3.8 27B (Groq Free Plan)", id: "qwen/qwen3.8-27b", task: "Text-to-text", access: "Groq Free Plan limits listed: 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day (account/model limits may vary).", note: "Free-plan candidate from Groq's published rate-limit table; requires a Groq API key and current model access." }
];
const baseModels = [
  { provider: "gemini", name: "Gemini 3.5 Flash-Lite", id: "gemini-3.5-flash-lite", task: "Text-to-text + vision input", access: "Google AI Studio free-tier quota applies; limits vary by model and region.", note: "Use only if this exact ID appears in your Google AI Studio model list; availability can vary by account." },
  { provider: "gemini", name: "Gemini 3.5 Flash", id: "gemini-3.5-flash", task: "Text-to-text + vision input", access: "Google AI Studio free-tier quota applies; limits vary by model and region.", note: "Use only if this exact ID appears in your Google AI Studio model list; availability can vary by account." },
  { provider: "gemini", name: "Gemini 3.1 Flash-Lite", id: "gemini-3.1-flash-lite", task: "Text-to-text + vision input", access: "Google AI Studio free-tier quota applies; limits vary by model and region.", note: "Use only if this exact ID appears in your Google AI Studio model list; availability can vary by account." },
  { provider: "openrouter", name: "OpenRouter Free Auto Router", id: "openrouter/free", task: "Text-to-text", access: "Free-only router; eligible models, capacity and rate limits can change.", note: "Routes to an eligible free model; no paid route is requested by this model ID." },
  ...groqFreeSpecs
];
const liveFreeIds = { openrouter: new Set(["openrouter/free"]), huggingface: new Set(), groq: new Set(groqFreeSpecs.map(m => m.id)), gemini: new Set() };
const imageModels = [
  { provider: "huggingface", name: "Stable Diffusion XL (HF Inference candidate)", id: "stabilityai/stable-diffusion-xl-base-1.0", task: "Text-to-image", access: "Limited HF monthly credits; availability varies", note: "Uses Hugging Face Inference; the account/model must have a compatible inference provider." },
  { provider: "huggingface", name: "FLUX.1 Schnell (HF Inference candidate)", id: "black-forest-labs/FLUX.1-schnell", task: "Text-to-image", access: "Limited HF monthly credits; availability varies", note: "Some models may be gated or unavailable through serverless inference." }
];

app.get("/api/health", (_q, r) => r.json({ ok: true, node: process.version, providersConfigured: keys.size }));
app.get("/api/providers", (_q, r) => r.json(providers.map(p => ({ ...p, connected: keys.has(p.id), keySource: keys.has(p.id) ? "Session memory" : "Not connected" }))));
app.put("/api/keys/:id", (q, r) => {
  const p = providers.find(x => x.id === q.params.id);
  if (!p) return r.status(404).json({ error: "Unknown provider." });
  const key = String(q.body?.key || "").trim();
  if (!key) return r.status(400).json({ error: "Enter an API key first." });
  keys.set(p.id, key);
  r.json({ ok: true, message: `${p.name} key stored in server memory until restart.` });
});
app.delete("/api/keys/:id", (q, r) => {
  if (!providers.some(p => p.id === q.params.id)) return r.status(404).json({ error: "Unknown provider." });
  keys.delete(q.params.id);
  r.json({ ok: true, message: "Key removed from server memory." });
});

async function fetchOpenRouterFreeModels() {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return [];
    const data = await response.json();
    const found = (data.data || []).filter(m => {
      const p = m.pricing || {};
      const outputs = m.architecture?.output_modalities || [];
      return !outputs.includes("image") && (String(m.id || "").endsWith(":free") || (Number(p.prompt) === 0 && Number(p.completion) === 0));
    }).map(m => ({ provider: "openrouter", name: `${m.name || m.id} (free route)`, id: m.id, task: "Text-to-text", access: "OpenRouter catalog reports zero token pricing / free route; limits and capacity apply.", note: "Discovered from OpenRouter's live model catalog. Free route availability can change." }));
    liveFreeIds.openrouter = new Set(["openrouter/free", ...found.map(m => m.id)]);
    return found;
  } catch { return []; }
}
async function fetchGroqFreeModels(token) {
  if (!token) return groqFreeSpecs;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return groqFreeSpecs;
    const data = await response.json();
    const supported = new Set((data.data || []).map(m => m.id));
    return groqFreeSpecs.filter(m => supported.has(m.id));
  } catch { return groqFreeSpecs; }
}
async function fetchHuggingFaceFreeModels(token) {
  if (!token) { liveFreeIds.huggingface = new Set(); return []; }
  const out = [];
  // Also accept other routes only if the authenticated router explicitly marks them free/zero-priced.
  try {
    const response = await fetch("https://router.huggingface.co/v1/models", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const data = await response.json();
      for (const m of (data.data || [])) {
        if (!(m.architecture?.output_modalities || ["text"]).includes("text")) continue;
        for (const provider of (m.providers || [])) {
          const pricing = provider.pricing || {};
          const zeroPrice = Number(pricing.input) === 0 && Number(pricing.output) === 0;
          if (provider.status && provider.status !== "live") continue;
          if (provider.is_free !== true && !zeroPrice) continue;
          const providerId = String(provider.provider || "").trim();
          if (!providerId || !m.id) continue;
          out.push({ provider: "huggingface", name: `${m.id} — ${providerId} (free route)`, id: `${m.id}:${providerId}`, providerRoute: providerId, task: "Text-to-text", access: "Hugging Face router explicitly marks this provider route free/zero-priced; quotas apply.", note: `Live catalog route: ${providerId}.` });
        }
      }
    }
  } catch {}
  liveFreeIds.huggingface = new Set(out.map(m => m.id));
  return [...new Map(out.map(m => [`${m.id}:${m.providerRoute||"auto"}`, m])).values()];
}
async function fetchGeminiFreeModels(token) {
  if (!token) { liveFreeIds.gemini = new Set(); return []; }
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': token }, signal: AbortSignal.timeout(10000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return [];
    const supported = new Set((data.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => String(m.name || "").replace(/^models\//, "")));
    // The Hub/API does not expose per-account free quota for every Gemini model. Only show
    // these known free-tier candidates if the user's own key confirms the exact model exists.
    const candidates = baseModels.filter(m => m.provider === "gemini" && supported.has(m.id));
    liveFreeIds.gemini = new Set(candidates.map(m => m.id));
    return candidates.map(m => ({ ...m, access: "Model exists for this API key. Confirm the current AI Studio free-tier quota for your account; free access is not guaranteed." }));
  } catch { liveFreeIds.gemini = new Set(); return []; }
}
app.get("/api/models", async (q, r) => {
  const [liveFree, hfFree, groqFree, geminiFree] = await Promise.all([
    fetchOpenRouterFreeModels(),
    fetchHuggingFaceFreeModels(keys.get("huggingface")),
    fetchGroqFreeModels(keys.get("groq")),
    fetchGeminiFreeModels(keys.get("gemini"))
  ]);
  liveFreeIds.groq = new Set(groqFree.map(m => m.id));
  const all = [...geminiFree, ...groqFree, ...liveFree, ...hfFree];
  const unique = [...new Map(all.map(m => [`${m.provider}:${m.id}`, m])).values()];
  r.json({ models: unique.filter(m => !q.query.provider || q.query.provider === "all" || m.provider === q.query.provider), refreshed: new Date().toISOString(), notice: "Free-only catalog: Groq documented Free Plan candidates, Google free-tier candidates, and live OpenRouter/Hugging Face routes explicitly marked free. OpenAI API models are excluded because API usage is metered; ChatGPT Free does not include API usage." });
});
app.get("/api/image-models", (_q, r) => r.json({ models: imageModels, notice: "No provider guarantees unlimited free image generation. Hugging Face may provide limited monthly credits; generation can fail if the model/provider is unavailable." }));

async function parseResponse(response) {
  const raw = await response.text();
  try { return { data: JSON.parse(raw), raw }; } catch { return { data: { raw: raw.slice(0, 1000) }, raw }; }
}
async function callModel(id, model, message, key, maxTokens = 800) {
  let url, headers = { "Content-Type": "application/json" }, body;
  if (id === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = key;
    body = { contents: [{ role: "user", parts: [{ text: message }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 } };
  } else if (["groq", "openrouter", "openai", "huggingface"].includes(id)) {
    url = { groq: "https://api.groq.com/openai/v1/chat/completions", openrouter: "https://openrouter.ai/api/v1/chat/completions", openai: "https://api.openai.com/v1/chat/completions", huggingface: "https://router.huggingface.co/v1/chat/completions" }[id];
    headers.Authorization = `Bearer ${key}`;
    if (id === "openrouter") { headers["HTTP-Referer"] = "http://localhost:3000"; headers["X-Title"] = "AEON Local Model Tester"; }
    body = { model, messages: [{ role: "user", content: message }], max_tokens: maxTokens, temperature: 0.3 };
  } else if (id === "cohere") {
    url = "https://api.cohere.com/v2/chat"; headers.Authorization = `Bearer ${key}`;
    body = { model, messages: [{ role: "user", content: message }], max_tokens: maxTokens, temperature: 0.3 };
  } else throw new Error("Unknown provider.");
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const { data } = await parseResponse(response);
  if (!response.ok) throw Object.assign(new Error(String(data?.error?.message || data?.message || data?.detail || data?.raw || `HTTP ${response.status}`).slice(0, 900)), { status: response.status });
  const answer = id === "gemini" ? (data?.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("") : id === "cohere" ? (data?.message?.content || []).map(x => x.text || "").join("") : (data?.choices?.[0]?.message?.content || "");
  if (!answer.trim()) throw new Error("Provider returned no readable text. Check model ID and task compatibility.");
  return { answer, model: data?.model || model, usage: data?.usage || data?.usageMetadata || null };
}
function hint(e, provider, model) {
  const s = String(e.message).toLowerCase();
  if (provider === "gemini" && (model.includes("2.5-flash-lite") || s.includes("no longer available to new users"))) return "This Gemini model is restricted for new users. Select gemini-3.5-flash-lite in the model list and retry.";
  if ((s.includes("401") || s.includes("unauthorized") || s.includes("invalid api key"))) return "Check that the API key is correct and active.";
  if (s.includes("429") || s.includes("quota") || s.includes("billing") || s.includes("rate limit")) return "Quota/rate limit reached. Try another free model or wait for the quota reset.";
  if (provider === "groq" && (s.includes("model") && (s.includes("not found") || s.includes("decommissioned") || s.includes("unsupported")))) return "This Groq model may have been retired or may not be enabled for your account. Refresh the catalog; only current Free Plan candidates are listed.";
  if (provider === "openai") return "OpenAI API usage is billed separately from ChatGPT Free; no OpenAI model is enabled in free-only mode.";
  if (provider === "openrouter" && (s.includes("unavailable for free") || s.includes("no endpoints") || s.includes("no provider"))) return "That model is not currently free/available. Refresh the catalog and select a model marked free, or use openrouter/free.";
  if (provider === "huggingface" && (s.includes("not supported by any provider") || s.includes("no provider") || s.includes("model_not_supported"))) return "This Hugging Face model has no compatible inference provider for your account. Open API Keys, save your Hugging Face token, then refresh the Models catalog and choose a route marked currently free. The selected route includes its provider suffix.";
  if (s.includes("model") && (s.includes("not found") || s.includes("unsupported") || s.includes("does not exist") || s.includes("deprecated"))) return "Model ID may be outdated or unsupported. Refresh the catalog and use an exact current ID.";
  if (s.includes("abort") || s.includes("timeout")) return "Request timed out. Check provider status and retry.";
  return "Check model ID, key permissions, account quota, provider docs and task compatibility.";
}
function safe(e) { let s = String(e.message || "Provider error"); for (const k of keys.values()) if (k) s = s.split(k).join("[REDACTED]"); return s.slice(0, 900); }
async function run(req, res) {
  const id = req.params.id || String(req.body.provider || "");
  if (!providers.some(p => p.id === id)) return res.status(400).json({ error: "Choose a valid provider." });
  const key = keys.get(id); if (!key) return res.status(400).json({ error: `Add a ${providers.find(p => p.id === id).name} API key first.` });
  const model = String(req.body.model || "").trim(), message = String(req.body.message || "").trim();
  if (!model) return res.status(400).json({ error: "Choose a model or enter an exact model ID." });
  if (!message) return res.status(400).json({ error: "Type a message first." });
  if (message.length > 20000) return res.status(400).json({ error: "Message limit is 20,000 characters." });
  // Enforce free-only mode on the server too; a custom ID must not bypass the catalog.
  if (id === "openai") return res.status(403).json({ error: "OpenAI has no generally free API model catalog. API usage is billed separately from ChatGPT Free, so OpenAI inference is disabled in this free-only playground to prevent unexpected charges.", hint: "Use Groq Free Plan, a live OpenRouter free route, or a Hugging Face route marked free. If your OpenAI API account has promotional credits, check its billing page; this app cannot verify that balance safely." });
  const listed = id === "gemini" ? liveFreeIds.gemini.has(model)
    : id === "groq" ? liveFreeIds.groq.has(model)
    : id === "openrouter" ? liveFreeIds.openrouter.has(model)
    : id === "huggingface" ? liveFreeIds.huggingface.has(model)
    : false;
  if (!listed) return res.status(403).json({ error: `Model '${model}' is not in the current free-only catalog for ${id}.`, hint: "Refresh Models and choose an entry explicitly listed as free. Custom model IDs are blocked if they are not verified in the free-only catalog." });
  try {
    const result = await callModel(id, model, message, key, req.path.includes("/test/") ? 40 : 800);
    res.json({ ok: true, provider: providers.find(p => p.id === id).name, ...result, message: "Real inference succeeded. This does not guarantee future use will be free." });
  } catch (e) { res.status(e.status || 502).json({ error: safe(e), hint: hint(e, id, model) }); }
}
app.post("/api/test/:id", async (q, r) => { q.body = { ...(q.body || {}), message: "Reply with exactly: AEON connection test successful" }; await run(q, r); });
app.post("/api/chat", run);

// Hugging Face image generation is a real provider call; response bytes are returned for preview.
app.post("/api/image", async (req, res) => {
  const id = "huggingface", key = keys.get(id);
  if (!key) return res.status(400).json({ error: "Add your Hugging Face token in API Keys first.", hint: "HF Inference may include limited monthly credits; check your current balance." });
  const model = String(req.body?.model || "stabilityai/stable-diffusion-xl-base-1.0").trim();
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Enter an image prompt first." });
  if (prompt.length > 4000) return res.status(400).json({ error: "Image prompt must be 4,000 characters or fewer." });
  try {
    const url = `https://router.huggingface.co/hf-inference/models/${model.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "image/*, application/json" }, body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } }), signal: AbortSignal.timeout(120000) });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || contentType.includes("json") || contentType.includes("text")) {
      const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 900) }; }
      const message = data?.error || data?.message || raw || `HTTP ${response.status}`;
      const lower = String(message).toLowerCase();
      const hint = lower.includes("loading") || lower.includes("estimated_time") ? "Model is loading; retry in 20–60 seconds." : lower.includes("gated") || lower.includes("access") ? "This model may be gated. Accept its license on Hugging Face or choose another model." : lower.includes("credit") || lower.includes("payment") ? "Free credits may be exhausted or this model requires paid inference." : "Check Hugging Face token permissions and whether the model supports serverless image generation.";
      return res.status(response.status || 502).json({ error: String(message).slice(0, 900), hint });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) return res.status(502).json({ error: "Provider returned an empty image." });
    const mime = contentType.startsWith("image/") ? contentType.split(";")[0] : "image/png";
    res.json({ ok: true, model, mime, image: `data:${mime};base64,${bytes.toString("base64")}`, message: "Image returned by Hugging Face Inference. Check credits and pricing before repeated use." });
  } catch (e) { res.status(502).json({ error: safe(e), hint: "Image inference timed out or the provider is unavailable. Retry or test another supported model." }); }
});
// ---- My Models: persistent non-secret config, in-memory credentials ----
const dataDir = path.join(root, "data");
const modelsFile = path.join(dataDir, "my-models.json");
const modelSecrets = new Map();
async function readSavedModels() {
  try { const d = JSON.parse(await fs.readFile(modelsFile, "utf8")); return Array.isArray(d) ? d : []; }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
async function writeSavedModels(items) {
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${modelsFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
  await fs.rename(temp, modelsFile);
}
const forbiddenHeaders = new Set(["authorization", "proxy-authorization", "host", "cookie", "set-cookie", "connection", "content-length", "transfer-encoding", "x-forwarded-for"]);
function validateHeaders(input) {
  let obj = input || {};
  if (typeof obj === "string") { try { obj = JSON.parse(obj || "{}"); } catch { throw new Error("Custom headers must be valid JSON object text."); } }
  if (!obj || Array.isArray(obj) || typeof obj !== "object") throw new Error("Custom headers must be a JSON object.");
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || forbiddenHeaders.has(k.toLowerCase()) || /(auth|token|api[-_]?key|secret|password|credential)/i.test(k)) throw new Error(`Header '${k}' is not allowed. Use the dedicated authentication fields for credentials.`);
    if (typeof v !== "string" || v.length > 1000) throw new Error(`Header '${k}' must have a string value under 1000 characters.`);
    out[k] = v;
  }
  return out;
}
function isPrivateIPv4(host) {
  const a = host.split(".").map(Number); if (a.length !== 4 || a.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return a[0] === 10 || a[0] === 127 || (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || a[0] === 0;
}
async function validateModelUrl(raw, allowLocal) {
  let u; try { u = new URL(raw); } catch { throw new Error("API base URL must be a valid absolute URL."); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error("Only HTTP or HTTPS URLs are supported.");
  if (u.username || u.password || u.search || u.hash) throw new Error("Do not put credentials, query strings, or fragments in the API base URL.");
  const localNames = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const isLocal = localNames.includes(u.hostname.toLowerCase());
  if (isLocal) {
    if (!allowLocal) throw new Error("Local endpoints require the explicit 'Allow local endpoint' option.");
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (![11434, 1234, 3000, 8000, 8001, 8080, 8081, 9000].includes(port)) throw new Error("Local endpoint port is not in the allowed development-port list.");
    if (u.protocol !== 'http:') throw new Error("Local development endpoints must use HTTP.");
  } else {
    if (u.protocol !== 'https:') throw new Error("External custom endpoints must use HTTPS.");
    if (u.hostname.includes(':') || isPrivateIPv4(u.hostname) || u.hostname.endsWith('.local') || u.hostname === 'metadata.google.internal') throw new Error("Private-network and cloud-metadata endpoints are blocked.");
    try {
      const records = await dns.lookup(u.hostname, { all: true, verbatim: true });
      if (records.some(x => isPrivateIPv4(x.address) || x.address === '::1' || x.address.startsWith('fc') || x.address.startsWith('fd') || x.address.startsWith('fe80:'))) throw new Error("The endpoint resolves to a private/internal address and is blocked.");
    } catch (e) { if (e.message.includes('private/internal')) throw e; if (e.code !== 'ENOTFOUND' && e.code !== 'EAI_AGAIN') throw new Error("Could not validate the endpoint hostname."); }
  }
  return u;
}
function publicModel(m) { const { apiKey, ...safeModel } = m; const keyConfigured = modelSecrets.has(m.id) || (m.authMethod !== 'none' && m.providerId === 'huggingface' && keys.has('huggingface')); const connected = Boolean(m.lastTestOk && (m.authMethod === 'none' || keyConfigured)); return { ...safeModel, keyConfigured, connected, status: connected ? 'Connected (last real test succeeded)' : (m.lastTestOk && m.authMethod !== 'none' && !keyConfigured ? 'Previously tested; re-enter key after server restart' : 'Not tested / disconnected') }; }
function cleanModel(body, existing={}) {
  const displayName = String(body.displayName ?? existing.displayName ?? '').trim();
  const provider = String(body.provider ?? existing.provider ?? 'Custom').trim();
  const modelId = String(body.modelId ?? existing.modelId ?? '').trim();
  const apiBaseUrl = String(body.apiBaseUrl ?? existing.apiBaseUrl ?? '').trim().replace(/\/$/, '');
  const endpointPath = String(body.endpointPath ?? existing.endpointPath ?? '/chat/completions').trim();
  const authMethod = String(body.authMethod ?? existing.authMethod ?? 'bearer');
  const requestFormat = String(body.requestFormat ?? existing.requestFormat ?? 'openai-chat');
  const responseFormat = String(body.responseFormat ?? existing.responseFormat ?? 'auto');
  const modelType = String(body.modelType ?? existing.modelType ?? 'chat');
  const contextLength = body.contextLength === '' || body.contextLength == null ? (existing.contextLength || null) : Number(body.contextLength);
  const description = String(body.description ?? existing.description ?? '').trim().slice(0, 2000);
  const providerId = String(body.providerId ?? existing.providerId ?? 'custom');
  const providerRoute = String(body.providerRoute ?? existing.providerRoute ?? '').trim();
  if (providerRoute && !/^[A-Za-z0-9-]{1,64}$/.test(providerRoute)) throw new Error('Invalid inference provider identifier.');
  const allowLocal = Boolean(body.allowLocal ?? existing.allowLocal);
  if (!displayName || displayName.length > 120) throw new Error('Display name is required and must be under 120 characters.');
  if (!/^[A-Za-z0-9._:/-]{1,240}$/.test(modelId)) throw new Error('Model ID is required and contains unsupported characters.');
  if (!endpointPath.startsWith('/') || endpointPath.startsWith('//') || endpointPath.includes('..') || endpointPath.length > 180) throw new Error('Endpoint path must be a safe path beginning with one slash.');
  if (!['bearer','api-key-header','none'].includes(authMethod)) throw new Error('Choose a supported authentication method.');
  const authHeaderName = String(body.authHeaderName ?? existing.authHeaderName ?? 'x-api-key').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(authHeaderName) || forbiddenHeaders.has(authHeaderName.toLowerCase())) throw new Error('API-key header name is invalid or reserved.');
  if (!['openai-chat','gemini-generate','hf-text-generation','openai-image'].includes(requestFormat)) throw new Error('Unsupported request format.');
  if (!['auto','openai-chat','gemini','text'].includes(responseFormat)) throw new Error('Unsupported response format.');
  if (!['chat','coding','vision','image-generation'].includes(modelType)) throw new Error('Unsupported model type.');
  if (contextLength !== null && (!Number.isInteger(contextLength) || contextLength < 1 || contextLength > 2000000)) throw new Error('Context length must be a positive integer no larger than 2,000,000.');
  const customHeaders = validateHeaders(body.customHeaders ?? existing.customHeaders ?? {});
  return { id: existing.id || crypto.randomUUID(), displayName, provider, providerId, providerRoute, modelId, apiBaseUrl, endpointPath, authMethod, authHeaderName, customHeaders, requestFormat, responseFormat, modelType, contextLength, description, allowLocal, enabled: body.enabled === undefined ? (existing.enabled !== false) : Boolean(body.enabled), createdAt: existing.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), lastTestOk: existing.lastTestOk === true, lastTestAt: existing.lastTestAt || null };
}
async function modelKey(m) { return modelSecrets.get(m.id) || (m.providerId === 'huggingface' ? keys.get('huggingface') : '') || ''; }
async function inferCustom(m, message, testOnly=false) {
  if (!m.enabled) throw Object.assign(new Error('This model is disabled. Enable it in My Models before testing.'), { status: 400 });
  const key = await modelKey(m);
  if (m.authMethod !== 'none' && !key) throw Object.assign(new Error('API key is required. Enter it while saving/editing the model, or configure the Hugging Face token in API Keys.'), { status: 400 });
  const u = await validateModelUrl(m.apiBaseUrl, m.allowLocal);
  const url = `${u.toString().replace(/\/$/, '')}${m.endpointPath}`;
  const headers = { 'Content-Type': 'application/json', ...m.customHeaders };
  if (m.authMethod === 'bearer') headers.Authorization = `Bearer ${key}`;
  if (m.authMethod === 'api-key-header') headers[m.authHeaderName || 'x-api-key'] = key;
  let body;
  if (m.requestFormat === 'gemini-generate') body = { contents: [{ role: 'user', parts: [{ text: message }] }], generationConfig: { maxOutputTokens: testOnly ? 40 : 800, temperature: 0.3 } };
  else if (m.requestFormat === 'hf-text-generation') body = { inputs: message, parameters: { max_new_tokens: testOnly ? 40 : 800, return_full_text: false } };
  else if (m.requestFormat === 'openai-image') body = { model: m.modelId, prompt: message, n: 1 };
  else body = { model: (m.providerId === 'huggingface' && m.providerRoute ? `${m.modelId}:${m.providerRoute}` : m.modelId), messages: [{ role: 'user', content: message }], max_tokens: testOnly ? 40 : 800, temperature: 0.3 };
  const finalUrl = m.requestFormat === 'gemini-generate' ? `${u.toString().replace(/\/$/, '')}/${encodeURIComponent(m.modelId)}:generateContent` : url;
  const start = Date.now();
  let response;
  try { response = await fetch(finalUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000), redirect: 'error' }); }
  catch (e) { throw Object.assign(new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Request timed out after 45 seconds.' : `Network request failed: ${e.message}`), { status: 502 }); }
  const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1200) }; }
  if (!response.ok) throw Object.assign(new Error(String(data?.error?.message || data?.error || data?.message || data?.detail || data?.raw || `HTTP ${response.status}`).slice(0, 1000)), { status: response.status });
  let answer = '';
  const fmt = m.responseFormat;
  if (m.requestFormat === 'openai-image') { const image = data?.data?.[0]; const imageData = image?.b64_json ? `data:image/png;base64,${image.b64_json}` : image?.url; if (!imageData) throw Object.assign(new Error('Image endpoint returned no URL or base64 image data.'), { status: 502 }); return { answer: imageData.startsWith('data:') ? 'Image generated successfully (base64 image returned).' : `Image generated: ${imageData}`, imageData, model: data?.model || m.modelId, usage: data?.usage || null, responseTimeMs: Date.now()-start }; }
  if (fmt === 'gemini' || (fmt === 'auto' && data?.candidates)) answer = (data?.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  else if (fmt === 'text') answer = typeof data === 'string' ? data : String(data?.generated_text ?? data?.[0]?.generated_text ?? data?.output ?? data?.text ?? '');
  else answer = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : Array.isArray(data?.choices?.[0]?.message?.content) ? data.choices[0].message.content.map(x=>x.text||'').join('') : String(data?.answer ?? data?.message?.content?.[0]?.text ?? data?.generated_text ?? '');
  if (!answer.trim()) throw Object.assign(new Error('The endpoint returned HTTP success but no recognized text. Check the selected request/response format.'), { status: 502 });
  return { answer, model: data?.model || m.modelId, usage: data?.usage || data?.usageMetadata || null, responseTimeMs: Date.now()-start };
}
app.get('/api/my-models', async (_req,res) => { try { res.json({ models: (await readSavedModels()).map(publicModel) }); } catch { res.status(500).json({error:'Could not read saved model configurations.'}); } });
app.post('/api/my-models', async (req,res) => {
  try { const body=req.body||{}; const model=cleanModel(body); await validateModelUrl(model.apiBaseUrl, model.allowLocal); const items=await readSavedModels(); if(items.some(x=>x.displayName.toLowerCase()===model.displayName.toLowerCase())) return res.status(409).json({error:'A model with this display name already exists.'}); items.push(model); await writeSavedModels(items); const secret=String(body.apiKey||'').trim(); if(secret) modelSecrets.set(model.id,secret); res.status(201).json({model:publicModel(model),message:'Model configuration saved. Credentials remain in server memory only and are never written to the config file.'}); }
  catch(e){res.status(400).json({error:e.message||'Invalid model configuration.'});}
});
app.put('/api/my-models/:id', async (req,res) => {
  try { const items=await readSavedModels(),idx=items.findIndex(x=>x.id===req.params.id); if(idx<0)return res.status(404).json({error:'Model not found.'}); const model=cleanModel(req.body||{},items[idx]); await validateModelUrl(model.apiBaseUrl,model.allowLocal); items[idx]=model; await writeSavedModels(items); if(String(req.body?.apiKey||'').trim())modelSecrets.set(model.id,String(req.body.apiKey).trim()); res.json({model:publicModel(model),message:'Model updated. Credentials remain in memory only.'}); }
  catch(e){res.status(400).json({error:e.message||'Invalid model configuration.'});}
});
app.delete('/api/my-models/:id', async (req,res) => { const items=await readSavedModels(),next=items.filter(x=>x.id!==req.params.id); if(next.length===items.length)return res.status(404).json({error:'Model not found.'}); await writeSavedModels(next); modelSecrets.delete(req.params.id); res.json({ok:true}); });
app.post('/api/my-models/:id/toggle', async (req,res) => { const items=await readSavedModels(),m=items.find(x=>x.id===req.params.id); if(!m)return res.status(404).json({error:'Model not found.'}); m.enabled=Boolean(req.body?.enabled); m.updatedAt=new Date().toISOString(); await writeSavedModels(items); res.json({model:publicModel(m)}); });
async function customModelAction(req,res,testOnly) {
  try { const items=await readSavedModels(),m=items.find(x=>x.id===req.params.id); if(!m)return res.status(404).json({error:'Model not found.'}); const msg=testOnly?'Reply with exactly: AEON connection test successful':String(req.body?.message||'').trim(); if(!msg)return res.status(400).json({error:'Type a message first.'}); if(msg.length>20000)return res.status(400).json({error:'Message must be 20,000 characters or fewer.'}); const result=await inferCustom(m,msg,testOnly); m.lastTestOk=true;m.lastTestAt=new Date().toISOString();m.updatedAt=new Date().toISOString();await writeSavedModels(items);res.json({ok:true,provider:m.provider,...result,message:'Real inference succeeded.'}); }
  catch(e){ if(req.params.id){try{const items=await readSavedModels(),m=items.find(x=>x.id===req.params.id);if(m){m.lastTestOk=false;m.lastTestAt=new Date().toISOString();await writeSavedModels(items);}}catch{}} res.status(e.status||502).json({error:String(e.message||'Inference failed').slice(0,1000),hint:e.status===401||e.status===403?'Check API key permissions and model access.':e.status===429?'Quota/rate limit reached; check provider usage and billing.':e.status===404?'Endpoint or model ID was not found; verify the API base URL, endpoint path, and model ID.':'Check endpoint URL, authentication, request/response format, and provider status.'}); }
}
app.post('/api/my-models/:id/test', (req,res)=>customModelAction(req,res,true));
app.post('/api/my-models/:id/infer', (req,res)=>customModelAction(req,res,false));

// Hugging Face Hub catalog: the Hub proves that a model is served by a provider, not that it is free.
app.get('/api/huggingface/models', async (req,res) => {
  const query=String(req.query.q||'').trim().slice(0,120), task=String(req.query.task||'text-generation'), provider=String(req.query.provider||'all');
  const allowedTasks=new Set(['text-generation','conversational','image-text-to-text']);
  const allowedProviders=new Set(['all','hf-inference','publicai','groq','cerebras','cohere','deepinfra','fireworks-ai','featherless-ai','novita','together','fal-ai','replicate','scaleway','nscale','ovhcloud','wavespeedai','zai','baseten']);
  if(!allowedTasks.has(task))return res.status(400).json({error:'Unsupported task filter.'});
  if(!allowedProviders.has(provider))return res.status(400).json({error:'Unsupported provider filter.'});
  const params=new URLSearchParams({pipeline_tag:task==='conversational'?'text-generation':task,inference_provider:provider,sort:'downloads',direction:'-1',limit:'50','expand[]':'inferenceProviderMapping'}); if(query)params.set('search',query);
  const token=keys.get('huggingface'); const headers=token?{Authorization:`Bearer ${token}`} : {};
  try {
    const hub=await fetch(`https://huggingface.co/api/models?${params.toString()}`,{headers,signal:AbortSignal.timeout(15000)});
    const raw=await hub.text();let data;try{data=JSON.parse(raw)}catch{data=[]}
    if(!hub.ok)return res.status(hub.status).json({error:`Hugging Face Hub returned HTTP ${hub.status}.`,hint:hub.status===401?'Check your Hugging Face token.':'Retry later or narrow the search.'});
    let routerData=[]; if(token){try{const rr=await fetch('https://router.huggingface.co/v1/models',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});if(rr.ok){const rd=await rr.json();routerData=rd.data||rd.models||[];}}catch{}}
    const routerById=new Map(routerData.map(x=>[x.id,x]));
    const results=(Array.isArray(data)?data:[]).map(m=>{
      const mapping=m.inferenceProviderMapping||m.inference_provider_mapping||{};
      const mappings=Array.isArray(mapping)?mapping:Object.entries(mapping).map(([k,v])=>({provider:k,...v}));
      const live=mappings.filter(x=>!x.status||x.status==='live');
      const exact=routerById.get(m.id);const routes=(exact?.providers||[]).map(p=>({provider:p.provider,status:p.status||'unknown',pricing:p.pricing||null,isFree:p.is_free===true||(p.pricing&&Number(p.pricing.input)===0&&Number(p.pricing.output)===0)}));
      const freeRoute=routes.find(x=>x.isFree&&(!x.status||x.status==='live'));
      const chosenProvider=freeRoute?.provider||live[0]?.provider||live[0]?.provider_id||null;
      const freeStatus=freeRoute?'Verified free/zero-priced route in live router catalog':(live.length?'Unknown — live inference route listed; free status not verified':'Listed on Hub; usable hosted route not confirmed');
      return {id:m.id,name:m.id,task:m.pipeline_tag||task,downloads:m.downloads||null,likes:m.likes||null,provider:chosenProvider,providers:live.map(x=>x.provider||x.provider_id).filter(Boolean),requiresToken:!Boolean(token),free:!!freeRoute,freeStatus,hostedRouteVerified:live.length>0||Boolean(exact),pricing:freeRoute?.pricing||null,description:String(m.cardData?.description||'').slice(0,400),url:`https://huggingface.co/${encodeURIComponent(m.id).replace(/%2F/g,'/')}`};
    });
    const freeOnly=req.query.freeOnly==='true'; const filtered=freeOnly?results.filter(x=>x.free):results;
    res.json({models:filtered,refreshed:new Date().toISOString(),authenticated:Boolean(token),freeFilterNote:'Free is shown only when the authenticated live router catalog explicitly marks a provider route free or reports zero input/output pricing. Unknown is not treated as free. A route can still be subject to quotas and provider changes.',notice:'The Hub catalog indicates model/task/provider availability, not guaranteed free access. Hugging Face Free accounts currently receive limited monthly Inference Provider credits; see official pricing.'});
  } catch(e){res.status(502).json({error:`Hugging Face catalog request failed: ${e.message}`,hint:'Check network access and retry. The Hub catalog requires no token for public search; a token enables authenticated route/pricing checks.'});}
});
app.post('/api/huggingface/test', async (req,res)=>{
  const key=keys.get('huggingface'); if(!key)return res.status(400).json({error:'Save a Hugging Face token in API Keys before testing inference.',hint:'Create a token with Inference permissions at https://huggingface.co/settings/tokens.'});
  const model=String(req.body?.model||'').trim(),message=String(req.body?.message||'Reply with exactly: AEON Hugging Face test successful').trim(),provider=String(req.body?.provider||'auto').trim();
  if(!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model))return res.status(400).json({error:'Use the exact Hub model ID, without a provider suffix.'});
  if(!message||message.length>20000)return res.status(400).json({error:'Message is required and must be under 20,000 characters.'});
  const start=Date.now();try{const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};const allowedRoutes=new Set(['hf-inference','publicai','groq','cerebras','cohere','deepinfra','fireworks-ai','featherless-ai','novita','together','fal-ai','replicate','scaleway','nscale','ovhcloud','wavespeedai','zai','baseten']);const selectedModel=(provider!=='auto'&&allowedRoutes.has(provider)?`${model}:${provider}`:model);const response=await fetch('https://router.huggingface.co/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:selectedModel,messages:[{role:'user',content:message}],max_tokens:256}),signal:AbortSignal.timeout(45000)});const raw=await response.text();let d;try{d=JSON.parse(raw)}catch{d={raw:raw.slice(0,1000)}};if(!response.ok)return res.status(response.status).json({error:String(d?.error?.message||d?.error||d?.message||d?.raw||`HTTP ${response.status}`).slice(0,1000),hint:response.status===401?'Check your Hugging Face token and inference permission.':response.status===402?'Free credits may be exhausted or the route may require payment; check Hugging Face billing.':response.status===429?'Rate limit or quota exhausted.':response.status===404?'No usable route for this model ID/task; check its Hub inference-provider mapping.':'Check model access, provider availability, and current pricing.'});const answer=d?.choices?.[0]?.message?.content;if(typeof answer!=='string'||!answer.trim())return res.status(502).json({error:'Provider returned no chat text. The model may not support chat completion.'});res.json({ok:true,model:d.model||selectedModel,answer,usage:d.usage||null,responseTimeMs:Date.now()-start,provider:provider==='auto'?'Hugging Face automatic routing':provider});}catch(e){res.status(502).json({error:`Hugging Face inference request failed: ${e.message}`,hint:'Check network, token, route availability, and model task compatibility.'});}
});
app.use((err, _req, res, _next) => { const status = Number(err.status) || (err.type === "entity.too.large" ? 413 : 500); res.status(status).json({ error: status === 413 ? "Request body is too large." : (status >= 500 ? "Internal server error. Check the local terminal for details without sharing secrets." : String(err.message || "Request failed")) }); });
app.listen(PORT, () => console.log(`ÆON AI Playground: http://localhost:${PORT}\nAPI keys remain in process memory and clear on restart.`));
