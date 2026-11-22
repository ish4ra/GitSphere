import { inflateRawSync } from 'node:zlib';

// Minimal ZIP reader for single, well-formed archives such as GeoNames dumps.
// Supports stored (0) and deflate (8) entries; no encryption, no ZIP64.
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries.map((entry) => ({
    name: entry.name,
    read() {
      const local = entry.localOffset;
      if (buffer.readUInt32LE(local) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${entry.name}.`);
      }
      const nameLength = buffer.readUInt16LE(local + 26);
      const extraLength = buffer.readUInt16LE(local + 28);
      const start = local + 30 + nameLength + extraLength;
      const data = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return Buffer.from(data);
      if (entry.method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
    },
  }));
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end-of-central-directory record not found.');
}
