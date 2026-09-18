/**
 * Module resolution shim for the test runner.
 *
 * The application is compiled by Next.js, which resolves the "@/..." path alias
 * and extensionless imports. Node's ESM resolver does neither, so these hooks
 * reproduce both rules and let node:test import the TypeScript sources directly
 * (with --experimental-strip-types) instead of testing a separate build.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

function firstExisting(basePath) {
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath;
  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const resolved = firstExisting(path.join(root, 'src', specifier.slice(2)));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentPath = context.parentURL?.startsWith('file:')
      ? path.dirname(fileURLToPath(context.parentURL))
      : null;
    if (parentPath) {
      const resolved = firstExisting(path.resolve(parentPath, specifier));
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
