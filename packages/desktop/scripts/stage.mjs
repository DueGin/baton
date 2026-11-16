import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url)), root = resolve(desktop, '../..');
const stage = join(desktop, 'staging/runtime');
await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const copied = new Set();
const manifest = [];
async function locate(name, from) {
  if (name.startsWith('@baton/')) return join(root, 'packages', name.slice(7));
  const require = createRequire(join(from, 'package.json'));
  let cursor;
  try { cursor = dirname(require.resolve(`${name}/package.json`)); } catch { cursor = dirname(require.resolve(name)); }
  for (;;) {
    try { const pkg = JSON.parse(await readFile(join(cursor, 'package.json'), 'utf8')); if (pkg.name === name) return cursor; } catch { /* Walk up to the package root. */ }
    const parent = dirname(cursor); if (parent === cursor) throw new Error(`Cannot find ${name}`); cursor = parent;
  }
}
async function dependency(name, from, optional = false) {
  // baton drives the user's Claude CLI (pathToClaudeCodeExecutable), never the SDK's bundled
  // 220 MB platform binary. Exclude every platform variant on ALL hosts, including cross-builds.
  if (name.startsWith('@anthropic-ai/claude-agent-sdk-')) return;
  let source;
  try { source = await realpath(await locate(name, from)); } catch (error) { if (optional) return; throw error; }
  if (copied.has(source)) return; copied.add(source);
  const workspace = name.startsWith('@baton/');
  const destination = join(stage, relative(root, source));
  if (!workspace && !relative(root, source).split(/[\\/]/).includes('node_modules')) throw new Error(`Dependency is outside node_modules: ${source}`);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await mkdir(destination, { recursive: true });
  if (workspace) { await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true }); await cp(join(source, 'package.json'), join(destination, 'package.json')); }
  else await cp(source, destination, { recursive: true, filter: path => !['node_modules', '.git'].includes(path.slice(source.length + 1).split(/[\\/]/)[0]) });
  manifest.push({ name, version: pkg.version, path: relative(stage, destination) });
  const required = { ...pkg.dependencies, ...pkg.peerDependencies };
  for (const child of Object.keys(required)) await dependency(child, source, Boolean(pkg.peerDependenciesMeta?.[child]?.optional || pkg.optionalDependencies?.[child]));
  for (const child of Object.keys(pkg.optionalDependencies ?? {})) await dependency(child, source, true);
}
for (const name of ['server','protocol','providers','web']) {
  const source = join(root,'packages',name), destination = join(stage,'packages',name);
  await mkdir(destination,{recursive:true});
  await cp(join(source,'dist'),join(destination,'dist'),{recursive:true});
  await cp(join(source,'package.json'),join(destination,'package.json'));
  if (name !== 'web') await dependency(`@baton/${name}`, source);
}
// Materialize workspace aliases (rather than symlinks) for portable Windows archives.
for (const name of ['server','protocol','providers']) await cp(join(stage,'packages',name), join(stage,'node_modules','@baton',name), {recursive:true});
for (const name of ['LICENSE','NOTICE']) { try { await cp(join(root,name), join(stage,name)); } catch { /* Repository may not provide NOTICE. */ } }
await writeFile(join(stage,'dependencies.json'), JSON.stringify(manifest.sort((a,b) => a.name.localeCompare(b.name)), null, 2));
console.log(`Staged ${manifest.length} production packages in ${stage}`);
