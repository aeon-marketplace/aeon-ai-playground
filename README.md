# ÆON AI Playground — Existing project fix and model integrations

## Windows / VS Code
1. Extract the ZIP. Open the folder that directly contains `package.json`.
2. In VS Code Terminal run:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd start
```

3. Open http://localhost:3000

## What changed
- Gemini models are discovered using the configured key and Google’s live model list; stale hard-coded Gemini IDs are no longer shown as available.
- Hugging Face catalog search uses the official Hub API `inference_provider` and task filters. Free Access only includes authenticated router routes that explicitly report free/zero pricing; unknown pricing is not marked free.
- Added My Models CRUD, persistent non-secret model configurations, enable/disable, test connection, and real inference. Model keys are held in backend process memory only and are not written to disk; re-enter them after restarting the server.
- Added Hugging Face model search, provider/task filters, model details links, test inference, and add-to-My-Models actions.
- Added endpoint validation, explicit local endpoint opt-in, restricted local ports, external HTTPS requirement, private-address checks, safe custom headers, timeouts, and clearer errors.

## API keys
Use API Keys inside the app. Keys are stored in server memory only, and disappear on server restart. Do not expose this development app to the internet. Do not put keys in frontend code or commit them to GitHub. For Hugging Face, create a token with inference permission at https://huggingface.co/settings/tokens.

## Custom model formats
- `openai-chat`: OpenAI-compatible `/chat/completions` request and response.
- `gemini-generate`: Gemini-style `contents` request and `candidates` response; endpoint path is the base path and model ID is appended as `/{model}:generateContent`.
- `hf-text-generation`: legacy-style `inputs` request and `generated_text` response; provider support varies.

## Hugging Face access labels
- `Verified free/zero-priced route`: authenticated router metadata explicitly reports a free route or zero input/output pricing. Provider capacity and rate limits still apply.
- `Unknown`: Hub shows a model/provider route but the app could not verify free pricing.
- The Hub catalog may include models that are listed but not usable for the requested task/account. A real test is needed to verify inference. Hugging Face documents limited monthly Inference Provider credits for free accounts, subject to change; credits do not make all models permanently free.

## Test limitations
`npm.cmd run check` validates JavaScript syntax. A real provider inference test requires your own API key and a model that your account can access. No successful live inference is claimed until you run Test Connection/Test Model with your credentials.

Official documentation: https://huggingface.co/docs/inference-providers and https://huggingface.co/docs/inference-providers/hub-api
