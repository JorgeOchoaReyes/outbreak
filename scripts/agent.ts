import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRun, ApiSpec } from '../src/types.js';

const root = path.resolve(fileURLToPath(import.meta.url), '../../');

/**
 * Fireworks serves an Anthropic-compatible gateway, so the Claude Agent SDK can
 * drive an open model without any change to the harness itself. The SDK appends
 * /v1/messages to this base URL.
 */
const DEFAULT_BASE_URL = 'https://api.fireworks.ai/inference';

/**
 * Fireworks' version-tracking alias for the current Kimi flagship. Pin a
 * canonical id (accounts/fireworks/models/kimi-k2-thinking) via FIREWORKS_MODEL
 * for reproducible builds. Append [1m] only for models with a 1M context
 * window — the suffix is how the harness sizes its context and compaction.
 */
const DEFAULT_MODEL = 'kimi-latest';

/** Filename the spec is staged under so the agent can read and grep it. */
const SPEC_FILE = '.outbreak-spec';

/** Bash the agent needs to typecheck and test its own output. */
const ALLOWED_BASH = [
  /^npx\s+(tsc|vitest)\b/,
  /^npm\s+(install|ci|run\s+\S+|test)\b/,
  /^(ls|cat|pwd|find|head|tail|wc|grep|rg|node)\b/,
];

function buildEnv(): Record<string, string | undefined> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    throw new Error('FIREWORKS_API_KEY is not set (see .env.example)');
  }

  return {
    ...process.env,
    // The gateway authenticates on X-Fireworks-Api-Key. Clear any Anthropic
    // credentials in the shell so they are not sent alongside it.
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: process.env.FIREWORKS_BASE_URL ?? DEFAULT_BASE_URL,
    ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${apiKey}`,
  };
}

/**
 * Confines the agent to its own package directory: file tools may only touch
 * paths under pkgDir, and Bash is limited to the build/test commands above.
 */
function buildPermissionGate(pkgDir: string): CanUseTool {
  const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });

  return async (toolName, input) => {
    if (toolName === 'Bash') {
      const command = String(input.command ?? '');
      const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim());
      const blocked = segments.find((s) => s && !ALLOWED_BASH.some((re) => re.test(s)));
      return blocked
        ? deny(`"${blocked}" is not allowed. Use npx tsc, npx vitest, or npm.`)
        : { behavior: 'allow' };
    }

    const filePath = input.file_path;
    if (typeof filePath === 'string') {
      const resolved = path.resolve(pkgDir, filePath);
      if (resolved !== pkgDir && !resolved.startsWith(pkgDir + path.sep)) {
        return deny(`${filePath} is outside the package directory.`);
      }
    }

    return { behavior: 'allow' };
  };
}

function buildPrompt(name: string, spec: ApiSpec): string {
  const clientName = name.charAt(0).toUpperCase() + name.slice(1) + 'Client';
  const label = spec.type === 'openapi' ? 'an OpenAPI specification' : 'scraped API documentation';

  return `Build a production-quality TypeScript SDK for the API described in ./${SPEC_FILE}, which contains ${label}. Read it first — it may be large, so grep it for the endpoint list before reading it end to end.

Write every file into the current directory. It is the package root for @outbreak/${name}.

Package name: @outbreak/${name}
Client class name: ${clientName}

Files to create:
1. src/types.ts — all request/response types, exported.
2. src/client.ts — a single ${clientName} class:
   - Constructor: new ${clientName}({ apiKey: string, baseUrl?: string })
   - One typed async method per API endpoint
   - Injects the auth header automatically
   - Throws a typed ApiError on non-2xx responses
3. src/index.ts — re-exports the client and types.
4. package.json — name "@outbreak/${name}", version "0.1.0", type "module",
   main "./dist/index.js", types "./dist/index.d.ts",
   exports { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
   scripts: { "build": "tsc", "test": "vitest run", "typecheck": "tsc --noEmit" },
   devDependencies: { "typescript": "^5.7.0", "vitest": "^2.0.0" },
   publishConfig: { "access": "public" }, files: ["dist"],
   and a "description" field holding one sentence on what this SDK does.
5. tsconfig.json — target ES2022, module NodeNext, moduleResolution NodeNext,
   strict true, outDir dist, declaration true, declarationMap true.
6. src/__tests__/client.test.ts — vitest tests that verify the client constructs
   without throwing and that every public method exists and is a function. They
   must not make real HTTP calls — mock fetch with vi.fn().
7. README.md — installation, a quickstart example, and a full method reference table.

Zero runtime dependencies. Native fetch only.

Before you finish, verify your own work and fix whatever fails:
- npx tsc --noEmit must pass with no errors
- npx vitest run must pass

Do not edit anything outside this directory, and do not modify ./${SPEC_FILE}.`;
}

/** Files the agent is told to produce but that must not ship in the package. */
async function listPackageFiles(pkgDir: string): Promise<string[]> {
  const entries = await fs.readdir(pkgDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(pkgDir, path.join(entry.parentPath, entry.name)))
    .filter((rel) => rel !== SPEC_FILE && !rel.startsWith('node_modules' + path.sep))
    .sort();
}

/**
 * Runs the Claude Agent SDK against packages/<name>, backed by a Kimi model on
 * Fireworks. The agent writes the SDK itself and iterates until its own
 * typecheck and tests pass.
 */
export async function generateSDK(name: string, spec: ApiSpec): Promise<AgentRun> {
  // Fail before touching the filesystem if credentials are missing.
  const env = buildEnv();

  const pkgDir = path.join(root, 'packages', name);
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, SPEC_FILE), spec.content, 'utf-8');

  const model = process.env.FIREWORKS_MODEL ?? DEFAULT_MODEL;
  console.log(`      model: ${model}`);

  try {
    for await (const message of query({
      prompt: buildPrompt(name, spec),
      options: {
        model,
        env,
        cwd: pkgDir,
        systemPrompt:
          'You are a senior TypeScript engineer generating a client SDK. Write real, ' +
          'complete implementations — never placeholders or TODOs. Prefer reading the ' +
          'spec over guessing endpoint shapes. Verify your work with the project tooling ' +
          'before you report being done.',
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
        canUseTool: buildPermissionGate(pkgDir),
        // Keep the run reproducible: ignore the host machine's CLAUDE.md,
        // settings and session history.
        settingSources: [],
        persistSession: false,
        maxTurns: Number(process.env.OUTBREAK_MAX_TURNS ?? 60),
      },
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') console.log(`      ${block.name}`);
        }
      }

      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(`Agent stopped: ${message.subtype} after ${message.num_turns} turns`);
        }
        return {
          files: await listPackageFiles(pkgDir),
          numTurns: message.num_turns,
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
        };
      }
    }
  } finally {
    await fs.rm(path.join(pkgDir, SPEC_FILE), { force: true });
  }

  throw new Error('Agent ended without producing a result');
}

/** Reads back the description the agent wrote into the generated package.json. */
export async function readDescription(name: string): Promise<string> {
  const manifest = path.join(root, 'packages', name, 'package.json');
  const parsed = JSON.parse(await fs.readFile(manifest, 'utf-8')) as { description?: string };
  return parsed.description ?? `TypeScript SDK for the ${name} API.`;
}
