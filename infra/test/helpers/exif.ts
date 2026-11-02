/** Minimal metadata containers for exercising the real parser, not its mocks. */
export function exifTiff(tags: Record<number, string>): Buffer {
  const entries = Object.entries(tags).map(([tag, value]) => [Number(tag), Buffer.from(value + "\0")] as const)
    .sort((a, b) => a[0] - b[0]);
  const exifOffset = 26;
  const dataStart = exifOffset + 2 + entries.length * 12 + 4;
  const bytes = Buffer.alloc(dataStart + entries.reduce((size, [, value]) => size + (value.length > 4 ? value.length : 0), 0));
  bytes.write("II", 0); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8); bytes.writeUInt16LE(0x8769, 10); bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(1, 14); bytes.writeUInt32LE(exifOffset, 18);
  bytes.writeUInt16LE(entries.length, exifOffset);
  let dataOffset = dataStart;
  entries.forEach(([tag, value], index) => {
    const entry = exifOffset + 2 + index * 12;
    bytes.writeUInt16LE(tag, entry); bytes.writeUInt16LE(2, entry + 2);
    bytes.writeUInt32LE(value.length, entry + 4);
    if (value.length <= 4) value.copy(bytes, entry + 8);
    else { bytes.writeUInt32LE(dataOffset, entry + 8); value.copy(bytes, dataOffset); dataOffset += value.length; }
  });
  return bytes;
}
export function exifJpeg(tags: Record<number, string>): Buffer {
  const data = Buffer.concat([Buffer.from("Exif\0\0"), exifTiff(tags)]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(data.length + 2, 4);
  return Buffer.concat([header, data, Buffer.from([0xff, 0xd9])]);
}
export function exifWebp(tags: Record<number, string>): Buffer {
  const data = exifTiff(tags);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0); header.writeUInt32LE(12 + data.length + data.length % 2, 4);
  header.write("WEBPEXIF", 8); header.writeUInt32LE(data.length, 16);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function exifPng(tags: Record<number, string>): Buffer {
  const data = exifTiff(tags);
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length, 0); header.write("eXIf", 4);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), header, data, crc]);
}
