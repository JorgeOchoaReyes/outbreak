import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../../');

export function validate(name: string): void {
  const pkgDir = path.join(root, 'packages', name);
  const opts = { stdio: 'inherit' as const };

  // Install deps at workspace root so new package deps get hoisted
  console.log('  installing dependencies...');
  execSync('npm install', { cwd: root, ...opts });

  // Type check
  console.log('  running tsc...');
  execSync('npx tsc --noEmit', { cwd: pkgDir, ...opts });

  // Tests
  console.log('  running tests...');
  execSync('npx vitest run', { cwd: pkgDir, ...opts });
}
