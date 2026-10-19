'use strict';

// A small whole disc: boot header, apploader, main.dol, and a file system
// table with one file that ends the disc at 0x4000.
function gcm(id = 'GMSE01', revision = 0, title = 'Super Mario Sunshine') {
  const bytes = Buffer.alloc(0x4000);
  bytes.write(id, 0, 'ascii');
  bytes[7] = revision;
  bytes.writeUInt32BE(0xc2339f3d, 0x1c);
  bytes.write(title, 0x20, 'latin1');
  bytes.writeUInt32BE(0x2800, 0x420); bytes.writeUInt32BE(0x3000, 0x424); bytes.writeUInt32BE(0x20, 0x428);
  bytes.writeUInt32BE(0x100, 0x2440 + 0x14);
  bytes.writeUInt32BE(0x100, 0x2800); bytes.writeUInt32BE(0x200, 0x2800 + 0x90);
  bytes.writeUInt32BE(0x01000000, 0x3000); bytes.writeUInt32BE(2, 0x3008);
  bytes.writeUInt32BE(0x3800, 0x3010); bytes.writeUInt32BE(0x800, 0x3014);
  bytes.write('a\0', 0x3018, 'latin1');
  bytes.fill(1, 0x3800);
  return bytes;
}
// The same disc as a CISO with 0x800-byte blocks, leaving out empty ones.
function ciso(disc) {
  const head = Buffer.alloc(0x8000), kept = [];
  head.write('CISO'); head.writeUInt32LE(0x800, 4);
  for (let block = 0; block * 0x800 < disc.length; block++) {
    const data = disc.subarray(block * 0x800, (block + 1) * 0x800);
    if (data.some(Boolean)) { head[8 + block] = 1; kept.push(data); }
  }
  return Buffer.concat([head, ...kept]);
}

module.exports = { gcm, ciso };
