import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'build'), { recursive: true });
const licenses = new Map();
for (const [input, output] of [['src/mcp/index.js', 'build/server.cjs'], ['scripts/setup-auth.js', 'build/setup-auth.cjs']]) {
  const result = await build({ entryPoints: [path.join(root, input)], outfile: path.join(root, output), bundle: true, platform: 'node', target: 'node24', format: 'cjs', legalComments: 'eof', metafile: true });
  for (const filename of Object.keys(result.metafile.inputs)) {
    if (!filename.includes('node_modules')) continue;
    let dir = path.dirname(path.resolve(filename));
    while (dir !== path.dirname(dir)) {
      let pkg;
      try { pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')); } catch {}
      if (pkg?.name && pkg?.version) {
        const key = `${pkg.name}@${pkg.version}`;
        if (!licenses.has(key)) {
          const files = (await readdir(dir)).filter(name => /^(licen[cs]e|copying)(\.|$)/i.test(name));
          const texts = await Promise.all(files.map(name => readFile(path.join(dir, name), 'utf8')));
          if (!texts.length) throw new Error(`Missing bundled dependency license: ${key}`);
          licenses.set(key, `===== ${key} (${pkg.license || 'see license'}) =====\n${texts.join('\n')}`);
        }
        break;
      }
      dir = path.dirname(dir);
    }
  }
}
await writeFile(path.join(root, 'build/THIRD_PARTY_LICENSES.txt'), [...licenses.values()].join('\n\n'));
console.log(`Built self-contained Node 24 runtime and credential setup; included ${licenses.size} dependency licenses.`);
