import yaml from 'js-yaml';
import type { ApiSpec } from '../src/types.js';

export async function ingest(url: string): Promise<ApiSpec> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json, application/yaml, text/yaml, text/html, */*' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch docs: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  // Try JSON OpenAPI spec
  if (contentType.includes('json') || url.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.openapi || parsed.swagger || parsed.paths) {
        return { type: 'openapi', content: text };
      }
    } catch {}
  }

  // Try YAML OpenAPI spec
  if (url.endsWith('.yaml') || url.endsWith('.yml') || contentType.includes('yaml')) {
    try {
      const parsed = yaml.load(text) as Record<string, unknown>;
      if (parsed && (parsed.openapi || parsed.swagger || parsed.paths)) {
        return { type: 'openapi', content: JSON.stringify(parsed, null, 2) };
      }
    } catch {}
  }

  // Try JSON anyway (URL might not have extension)
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.openapi || parsed.swagger || parsed.paths) {
      return { type: 'openapi', content: text };
    }
  } catch {}

  // Try YAML anyway
  try {
    const parsed = yaml.load(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && (parsed.openapi || parsed.swagger || parsed.paths)) {
      return { type: 'openapi', content: JSON.stringify(parsed, null, 2) };
    }
  } catch {}

  // Fall back to raw text: strip HTML tags for cleaner input
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { type: 'raw', content: stripped };
}
