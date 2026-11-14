import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';

const unixTypeMask = 0o170000;
const maxEntries = 100_000;

export function validSourceName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 &&
    name !== '.' && name !== '..' && !/[\\/\p{Cc}]/u.test(name) &&
    Buffer.byteLength(name) <= 255 &&
    (process.platform !== 'win32' ||
      (!/[<>:"|?*]|[. ]$/u.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)));
}

/** root is a newly created private staging directory on the destination volume. */
export async function extractSourceZip(archive: string, root: string, maxBytes: number): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: false, strictFileNames: true }, (err, file) => {
      if (err) reject(err);
      else resolve(file);
    });
  });
  let expandedBytes = 0;
  try {
    if (zip.entryCount > maxEntries) throw new Error('源码包文件数量超过限制');
    for (let index = 0; index < zip.entryCount; index++) {
      const nextEntry = once(zip, 'entry');
      zip.readEntry();
      const [entry] = await nextEntry as [yauzl.Entry];

      const directory = entry.fileName.endsWith('/');
      const entryPath = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const components = entryPath.split('/');
      if (components.length > 128 || !components.every(validSourceName)) {
        throw new Error('源码包包含无效文件路径');
      }
      const mode = entry.externalFileAttributes >>> 16;
      const type = mode & unixTypeMask;
      if (entry.isEncrypted() || (type && type !== (directory ? 0o040000 : 0o100000))) {
        throw new Error('源码包包含加密文件、符号链接或特殊文件');
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || (directory && entry.uncompressedSize !== 0) ||
          expandedBytes + entry.uncompressedSize > maxBytes) {
        throw new Error('源码包解压大小超过限制或目录条目无效');
      }
      const outPath = path.join(root, ...components);
      await fs.promises.mkdir(directory ? outPath : path.dirname(outPath), { recursive: true, mode: 0o700 });
      if (directory) continue;

      const input = await new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(entry, (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        });
      });
      let checksum = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          expandedBytes += chunk.length;
          if (expandedBytes > maxBytes) return done(new Error('源码包解压大小超过限制'));
          checksum = crc32(chunk, checksum);
          done(null, chunk);
        },
      });
      const output = fs.createWriteStream(outPath, { flags: 'wx', mode: 0o600 | (mode & 0o111) });
      await pipeline(input, verify, output);
      if (checksum !== entry.crc32) throw new Error(`源码文件校验失败: ${entry.fileName}`);
    }
  } finally {
    zip.close();
  }
}
