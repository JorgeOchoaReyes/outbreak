#!/usr/bin/env tsx
import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import { ingest } from './ingest.js';
import { writePackage } from './write-package.js';
import { validate } from './validate.js';
import { createPR } from './create-pr.js';
import type { GeneratedSDK } from '../src/types.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    name: { type: 'string' },
    docs: { type: 'string' },
    'skip-pr': { type: 'boolean', default: false },
    'skip-validate': { type: 'boolean', default: false },
  },
});

if (!values.name || !values.docs) {
  console.error('Usage: npm run generate -- --name <name> --docs <url>');
  console.error('       npm run generate -- --name cekura --docs https://docs.cekura.ai/openapi.json');
  process.exit(1);
}

const anthropic = new Anthropic();

const submitSDKTool: Anthropic.Tool = {
  name: 'submit_sdk',
  description: 'Submit the fully generated SDK package files.',
  input_schema: {
    type: 'object' as const,
    properties: {
      description: {
        type: 'string',
        description: 'One-sentence description of what this SDK does.',
      },
      files: {
        type: 'array',
        description: 'All files for the package, paths relative to the package root.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['description', 'files'],
  },
};

function buildPrompt(name: string, spec: string): string {
  const clientName = name.charAt(0).toUpperCase() + name.slice(1) + 'Client';

  return `Generate a production-quality TypeScript SDK for the API documented below.

Package name: @outbreak/${name}
Client class name: ${clientName}

${spec}

Requirements:
1. src/types.ts — all request/response types, exported
2. src/client.ts — single ${clientName} class:
   - Constructor: new ${clientName}({ apiKey: string, baseUrl?: string })
   - One typed async method per API endpoint
   - Injects auth header automatically
   - Throws typed ApiError on non-2xx responses
3. src/index.ts — re-exports client and types
4. package.json — name "@outbreak/${name}", version "0.1.0", type "module",
   main "./dist/index.js", types "./dist/index.d.ts",
   exports { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
   scripts: { "build": "tsc", "test": "vitest run", "typecheck": "tsc --noEmit" },
   devDependencies: { "typescript": "^5.7.0", "vitest": "^2.0.0" },
   publishConfig: { "access": "public" }, files: ["dist"]
5. tsconfig.json — target ES2022, module NodeNext, moduleResolution NodeNext,
   strict true, outDir dist, declaration true, declarationMap true
6. src/__tests__/client.test.ts — vitest tests that:
   - Verify the client constructs without throwing
   - Verify all public methods exist and are functions
   - Do NOT make real HTTP calls (use vi.fn() or mock fetch)
7. README.md — installation, quickstart example, full method reference table

Use zero runtime dependencies. Use native fetch only.
Use the submit_sdk tool to return your answer.`;
}

async function generateSDK(name: string, specContent: string): Promise<GeneratedSDK> {
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    tools: [submitSDKTool],
    tool_choice: { type: 'tool', name: 'submit_sdk' },
    messages: [{ role: 'user', content: buildPrompt(name, specContent) }],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call submit_sdk');

  return toolUse.input as GeneratedSDK;
}

async function main() {
  const { name, docs } = values as { name: string; docs: string };

  console.log(`\noutbreak: generating @outbreak/${name}\n`);

  console.log('[1/4] Ingesting docs...');
  const spec = await ingest(docs);
  console.log(`      detected: ${spec.type} (${Math.round(spec.content.length / 1024)}KB)`);

  console.log('[2/4] Generating SDK with Claude...');
  const label = spec.type === 'openapi' ? 'OpenAPI Specification' : 'API Documentation';
  const sdk = await generateSDK(name, `${label}:\n${spec.content}`);
  console.log(`      got ${sdk.files.length} files`);

  console.log('[3/4] Writing package files...');
  await writePackage(name, sdk.files);

  if (!values['skip-validate']) {
    console.log('[4/4] Validating...');
    validate(name);
  }

  if (!values['skip-pr']) {
    console.log('[5/5] Creating PR...');
    createPR(name, sdk.description);
  }

  console.log(`\nDone! @outbreak/${name} is ready.\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
