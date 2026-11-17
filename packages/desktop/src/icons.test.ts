import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
// Alpha of the top-left pixel and of the centre pixel of an 8-bit RGBA PNG.
function alphaAt(file: string): { width: number; corner: number; centre: number } {
  const data = readFileSync(file); let offset = 8; const idat: Buffer[] = []; let width = 0, height = 0, colorType = 0;
  while (offset < data.length) {
    const length = data.readUInt32BE(offset), type = data.toString("latin1", offset + 4, offset + 8), body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]!; }
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  expect(colorType).toBe(6);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4 + 1, rows: Buffer[] = []; let previous = Buffer.alloc(stride - 1);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride]!, line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    for (let x = 0; x < line.length; x++) {
      const a = x >= 4 ? line[x - 4]! : 0, b = previous[x]!, c = x >= 4 ? previous[x - 4]! : 0;
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (Math.abs(b - c) <= Math.abs(a - c) && Math.abs(b - c) <= Math.abs(a + b - 2 * c) ? a : Math.abs(a - c) <= Math.abs(a + b - 2 * c) ? b : c) : 0;
      line[x] = (line[x]! + predictor) & 255;
    }
    rows.push(line); previous = line;
  }
  return { width, corner: rows[0]![3]!, centre: rows[height >> 1]![(width >> 1) * 4 + 3]! };
}

describe("app icon", () => {
  // QuickLook renders SVGs onto opaque white; a missed alpha pass shows up in the Dock as a white square.
  it("keeps the rounded-square corners transparent at every size", () => {
    const files = [...readdirSync(`${assets}icon-source`).map(name => `${assets}icon-source/${name}`), `${assets}logo.png`, `${assets}logo-small.png`, `${assets}icon.png`];
    for (const file of files) { const { corner, centre } = alphaAt(file); expect({ file, corner }).toEqual({ file, corner: 0 }); expect(centre).toBe(255); }
  });
});
