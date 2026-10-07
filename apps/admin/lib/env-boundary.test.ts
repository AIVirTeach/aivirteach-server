import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SKIP = new Set(['node_modules', '.next', 'env-boundary.test.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|mjs|css)$/.test(name) ? [path] : [];
  });
}

describe('apps/admin 不碰服务端密钥', () => {
  it('源码里没有 JWT_SECRET 或 DATABASE_URL', () => {
    const offenders = sourceFiles(ROOT).filter((file) =>
      /JWT_SECRET|DATABASE_URL/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
