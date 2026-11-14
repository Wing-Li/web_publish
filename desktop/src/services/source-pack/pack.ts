import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { rootIgnoreMatcher } from './gitignore';

// Skip current and legacy source ZIPs even when the output directory has changed.
const sourceZipName = /_source_(?:\d{8}_\d{6}(?:-\d+)?|\d{4}_\d{6}_[0-9a-f-]{36})\.zip(?:\.tmp)?$/i;

const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

async function checkedRealpath(root: string, file: string): Promise<string> {
  const real = await fs.promises.realpath(file);
  if (!within(root, real)) throw new Error('符号链接指向项目目录以外：' + path.relative(root, file));
  return real;
}

async function openRegular(root: string, name: string, expected: fs.Stats) {
  const resolved = await checkedRealpath(root, name);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const handle = await fs.promises.open(resolved, flags);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
      await checkedRealpath(root, name) !== resolved) throw new Error('打包期间文件发生变化：' + name);
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function rootRules(root: string): Promise<string> {
  const file = path.join(root, '.gitignore');
  try { await fs.promises.lstat(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw err; }
  const stats = await fs.promises.stat(await checkedRealpath(root, file));
  if (!stats.isFile()) throw new Error('.gitignore 必须是普通文件');
  const handle = await openRegular(root, file, stats);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await handle.readFile()); }
  finally { await handle.close(); }
}

/** 文件筛选沿用 Finder「项目打包」。读写 ZIP 均在 Electron 的 Node.js 运行时完成。 */
export async function packSource(source: string, output: string, stateDir: string, artifactDir: string): Promise<number> {
  if (!source || !path.isAbsolute(source)) throw new Error('请选择本地项目目录');
  const root = await fs.promises.realpath(source);
  const cache = await fs.promises.realpath(stateDir);
  if (within(cache, root)) throw new Error('项目目录位于源码发送缓存内');
  const destination = await fs.promises.realpath(artifactDir);
  const selectedDir = path.resolve(root, path.relative(source, artifactDir));
  const defaultDir = path.join(root, '.web-publisher-artifacts');
  const ignored = rootIgnoreMatcher(await rootRules(root));
  const entries: { full: string; relative: string; stats: fs.Stats }[] = [];

  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (!entry.isDirectory() && sourceZipName.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (full === defaultDir || full === selectedDir) continue;
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.name !== '.gitignore' && ignored(relative)) continue;
      const resolved = await checkedRealpath(root, full);
      if (within(cache, resolved) || resolved === destination) continue;
      if (entry.isSymbolicLink() && sourceZipName.test(path.basename(resolved))) continue;
      const stats = await fs.promises.stat(resolved);
      if (stats.isDirectory()) {
        if (!entry.isSymbolicLink() && !ignored(relative)) await visit(full);
      } else {
        if (!stats.isFile()) throw new Error('无法打包非常规文件：' + relative);
        if (relative.includes('\\')) throw new Error('源码包无法保存含反斜杠的文件名：' + relative);
        entries.push({ full, relative, stats });
      }
    }
  }
  await visit(root);

  const zip = new ZipFile();
  const outputStream = zip.outputStream as Readable;
  let activeFile: fs.ReadStream | undefined;
  zip.on('error', err => outputStream.destroy(err));
  const writing = pipeline(outputStream, fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  try {
    for (const {full, relative, stats} of entries) {
      zip.addReadStreamLazy(relative, { mode: stats.mode, mtime: stats.mtime, size: stats.size }, done => {
        void openRegular(root, full, stats).then(handle => {
          if (outputStream.destroyed) { void handle.close(); return; }
          activeFile = handle.createReadStream();
          activeFile.on('error', err => zip.emit('error', err));
          done(null, activeFile);
        }, err => zip.emit('error', err));
      });
    }
    zip.end();
    await writing;
    return entries.length;
  } finally {
    outputStream.destroy();
    activeFile?.destroy();
    await writing.catch((): void => undefined);
  }
}
