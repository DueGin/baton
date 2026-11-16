// Deterministic placeholder icon: three white baton strokes on a violet rounded tile.
// Pure PNG/ICO/ICNS encoders keep dev/CI independent of ImageMagick and platform tools.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
await mkdir(assets, { recursive: true });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return result; }
function png(size) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (y + .5) / size, index = y * (size * 4 + 1) + x * 4 + 1;
    const dx = Math.max(.18 - u, 0, u - .82), dy = Math.max(.18 - v, 0, v - .82);
    const visible = u >= .04 && u <= .96 && v >= .04 && v <= .96 && dx * dx + dy * dy < .14 ** 2;
    const stroke = [[.23,.34,.27,.71],[.445,.555,.18,.82],[.66,.77,.36,.73]].some(([left,right,top,bottom]) => u >= left && u <= right && v >= top && v <= bottom);
    bytes[index] = stroke ? 248 : 101; bytes[index + 1] = stroke ? 249 : 80; bytes[index + 2] = stroke ? 255 : 224; bytes[index + 3] = visible ? 255 : 0;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}
await writeFile(`${assets}/icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="14" fill="#6550e0"/><path d="M23 27h11v44H23zM44.5 18h11v64h-11zM66 36h11v37H66z" fill="#f8f9ff"/></svg>\n');
await writeFile(`${assets}/icon.png`, png(512));
const icoImages = [16,32,48,64,128,256].map(size => ({ size, image: png(size) }));
const ico = Buffer.alloc(6 + 16 * icoImages.length); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(icoImages.length, 4); let offset = ico.length;
for (const [index, { size, image }] of icoImages.entries()) { const start = 6 + index * 16; ico[start] = ico[start + 1] = size === 256 ? 0 : size; ico.writeUInt16LE(1, start + 4); ico.writeUInt16LE(32, start + 6); ico.writeUInt32LE(image.length, start + 8); ico.writeUInt32LE(offset, start + 12); offset += image.length; }
await writeFile(`${assets}/icon.ico`, Buffer.concat([ico, ...icoImages.map(({ image }) => image)]));
const icnsImages = [[128,'ic07'],[256,'ic08'],[512,'ic09'],[1024,'ic10']].map(([size,type]) => { const image = png(size), header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(image.length + 8, 4); return Buffer.concat([header,image]); });
const icns = Buffer.alloc(8); icns.write('icns'); icns.writeUInt32BE(8 + icnsImages.reduce((sum,image) => sum + image.length, 0), 4);
await writeFile(`${assets}/icon.icns`, Buffer.concat([icns,...icnsImages]));
