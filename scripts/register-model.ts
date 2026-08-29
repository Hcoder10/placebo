/**
 * Points TrueForge at a self-hosted OpenAI-compatible endpoint.
 *
 * This is the step that closes the loop the project is built around: the
 * harness runs the experiment, and the model it runs on is one we serve
 * ourselves — so a model post-trained on those experiments can be swapped in
 * behind the same URL without touching the agent.
 *
 *   npx tsx scripts/register-model.ts http://100.79.153.43:8000/v1 gpt-oss-20b
 *
 * Prints the fully-qualified name to set as PLACEBO_MODEL.
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';

const [baseUrl, modelId, providerNameArg] = process.argv.slice(2);

if (!baseUrl || !modelId) {
  process.stdout.write('usage: register-model.ts <base_url> <model_id> [provider_name]\n');
  process.exit(1);
}

// TrueForge resource names are lowercase, dot/dash/underscore, 2-64 chars.
const providerName = (providerNameArg ?? 'selfhosted').toLowerCase();
const modelName = modelId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 120,
});

// Confirm the endpoint answers before registering it, so a failure here reads
// as "the server is down" rather than surfacing later as an opaque agent error.
const probe = await fetch(`${baseUrl}/models`).catch(() => null);
if (!probe?.ok) {
  process.stdout.write(`endpoint not reachable: ${baseUrl}/models\n`);
  process.exit(1);
}
const served = (await probe.json()) as { data?: { id?: string }[] };
process.stdout.write(`endpoint serves: ${(served.data ?? []).map(m => m.id).join(', ')}\n`);

// The SDK takes camelCase and serialises to the snake_case wire format.
await client.settings.modelProviders.createOrUpdate({
  manifest: {
    type: 'custom',
    name: providerName,
    baseUrl,
    // vLLM needs no key, but the schema requires the field.
    auth: { apiKey: process.env.PLACEBO_MODEL_API_KEY ?? 'not-required' },
    models: [
      {
        modelId,
        name: modelName,
        properties: { contextLength: 32768, maxOutputTokens: 8192 },
      },
    ],
  } as never,
});

process.stdout.write(`\nregistered. set:\n  PLACEBO_MODEL=${providerName}/${modelName}\n`);
process.stdout.write(`then:\n  npx tsx src/orchestrator/main.ts run 3\n`);
