#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { ingest } from './ingest.js';
import { generateSDK, readDescription } from './agent.js';
import { validate } from './validate.js';
import { createPR } from './create-pr.js';

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

async function main() {
  const { name, docs } = values as { name: string; docs: string };
  const steps = 2 + (values['skip-validate'] ? 0 : 1) + (values['skip-pr'] ? 0 : 1);
  let step = 0;
  const next = (label: string) => console.log(`[${++step}/${steps}] ${label}`);

  console.log(`\noutbreak: generating @outbreak/${name}\n`);

  next('Ingesting docs...');
  const spec = await ingest(docs);
  console.log(`      detected: ${spec.type} (${Math.round(spec.content.length / 1024)}KB)`);

  next('Generating SDK with the agent...');
  const run = await generateSDK(name, spec);
  console.log(
    `      ${run.files.length} files in ${run.numTurns} turns ` +
      `(${Math.round(run.durationMs / 1000)}s, $${run.costUsd.toFixed(4)})`,
  );

  if (!values['skip-validate']) {
    next('Validating...');
    validate(name);
  }

  if (!values['skip-pr']) {
    next('Creating PR...');
    const url = await createPR(name, await readDescription(name));
    console.log(`      ${url}`);
  }

  console.log(`\nDone! @outbreak/${name} is ready.\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
