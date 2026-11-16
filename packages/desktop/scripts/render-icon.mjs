// Rasterise the app-icon artwork into the PNG ladder that scripts/icons.mjs packs into
// icon.png / icon.ico / icon.icns.  npm run icons:render -w @baton/desktop
//
// Input:  assets/logo.svg (preferred) or assets/logo.png (square raster, ≥1024 px); optional
//         assets/logo-small.png — a tighter crop used for the 16/32/48 px slots so tiny icons stay legible
// Output: assets/icon-source/<size>.png for every size below — commit them; CI only packs, so the
// build itself stays free of rasterisers.
//
// This step is macOS-only on purpose: QuickLook renders the SVG and sips resizes, both system
// tools, so the repo needs no Chromium/ImageMagick dependency to cut a new icon. The artwork must
// be a square drawing (0 0 1024 1024 or similar) — QuickLook crops non-square SVGs to the canvas.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') { console.error('render-icon: needs macOS (qlmanage + sips); run it on a Mac and commit assets/icon-source/'); process.exit(1); }

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const RENDER = 1024;
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const svgPath = `${assets}logo.svg`, pngPath = `${assets}logo.png`;
const source = existsSync(svgPath) ? svgPath : existsSync(pngPath) ? pngPath : null;
if (!source) { console.error('render-icon: add assets/logo.svg or assets/logo.png first'); process.exit(1); }

const size = (file) => Number(/pixelWidth:\s*(\d+)/.exec(execFileSync('sips', ['-g', 'pixelWidth', file], { encoding: 'utf8' }))?.[1]);
const scratch = mkdtempSync(join(tmpdir(), 'baton-icon-'));
let master;
if (source.endsWith('.svg')) {
  execFileSync('qlmanage', ['-t', '-s', String(RENDER), '-o', scratch, svgPath], { stdio: 'ignore' });
  master = join(scratch, 'logo.svg.png');
  if (!existsSync(master)) { console.error('render-icon: QuickLook produced no thumbnail'); process.exit(1); }
} else {
  master = source;
}
const masterWidth = size(master);
const masterHeight = Number(/pixelHeight:\s*(\d+)/.exec(execFileSync('sips', ['-g', 'pixelHeight', master], { encoding: 'utf8' }))?.[1]);
if (masterWidth !== masterHeight || masterWidth < 512) { console.error(`render-icon: ${master} is not usable (need a square ≥512 px master)`); process.exit(1); }

const smallPath = `${assets}logo-small.png`;
const small = existsSync(smallPath) ? smallPath : null;
mkdirSync(`${assets}icon-source`, { recursive: true });
for (const px of SIZES) {
  const out = `${assets}icon-source/${px}.png`;
  const from = small && px <= 48 ? small : master;
  if (from === master && px === masterWidth) writeFileSync(out, readFileSync(master));
  else execFileSync('sips', ['-z', String(px), String(px), from, '--out', out], { stdio: 'ignore' });
}
rmSync(scratch, { recursive: true, force: true });
console.log(`render-icon: ${source.replace(assets, 'assets/')} → assets/icon-source/{${SIZES.join(',')}}.png (${masterWidth} px master${small ? ', logo-small.png for ≤48 px' : ''})`);
