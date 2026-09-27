import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Local, owner-trusted loader for package source directories (fixtures and the
// genesis package). Model-authored packages arrive as validated file maps instead.
export function readPackageDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).split('\\').join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return files;
}
// Authors receive the parent hash in their input bundle; fixtures bind it the same way.
export function withManifest(files: Record<string, string>, patch: Record<string, unknown>): Record<string, string> {
  const manifest = { ...JSON.parse(files['package.json']), ...patch };
  return { ...files, 'package.json': JSON.stringify(manifest, null, 2) + '\n' };
}
