import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratedFile } from '../src/types.js';

const root = path.resolve(fileURLToPath(import.meta.url), '../../');

export async function writePackage(name: string, files: GeneratedFile[]): Promise<void> {
  const pkgDir = path.join(root, 'packages', name);

  await fs.mkdir(pkgDir, { recursive: true });

  for (const file of files) {
    const filePath = path.join(pkgDir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, 'utf-8');
    console.log(`  wrote ${path.relative(root, filePath)}`);
  }
}
