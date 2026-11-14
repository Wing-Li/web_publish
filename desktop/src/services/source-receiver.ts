import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReceiverConfig, SourceInitRequest, SourceReceipt, SourceTarget, SourceTaskStatus } from '../shared/types';
import { extractSourceZip, validSourceName } from './source-extract';
import { sourceVersionTime } from './project-artifact';

const disk = fs.promises;
const MiB = 1024 * 1024;
const sha256 = /^[0-9a-f]{64}$/i;
const taskIdPattern = /^[a-zA-Z0-9_-]{1,96}$/;
const archiveVersionPattern = /^(\d{8}_\d{6})(?:-([1-9]\d{0,8}))?$/;

class SourceError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

interface StoredTask {
  id: string;
  request: SourceInitRequest;
  target: SourceTarget;
  version: string;
  status: SourceTaskStatus['status'];
  error?: string;
  receipt?: SourceReceipt;
  staging?: { path: string; identity: string };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function directoryIdentity(folder: string): Promise<string | undefined> {
  try {
    const stat = await disk.lstat(folder, { bigint: true });
    if (stat.isDirectory()) return `${stat.dev}:${stat.ino}`;
  } catch (err) { if (!isMissing(err)) throw err; }
  return undefined;
}

function finalPath(task: StoredTask): string {
  return path.join(task.target.path, task.request.projectName, task.version);
}

async function saveTask(folder: string, task: StoredTask): Promise<void> {
  const tmp = path.join(folder, 'task.json.tmp');
  await disk.writeFile(tmp, JSON.stringify(task), { mode: 0o600 });
  await disk.rename(tmp, path.join(folder, 'task.json'));
}

async function readTask(folder: string): Promise<StoredTask> {
  try {
    return JSON.parse(await disk.readFile(path.join(folder, 'task.json'), 'utf8'));
  } catch (err) {
    if (isMissing(err)) throw new SourceError(404, '源码任务不存在');
    throw err;
  }
}

async function indexes(folder: string): Promise<number[]> {
  const files = await disk.readdir(folder);
  return files.filter(name => /^\d+\.part$/.test(name))
    .map(name => parseInt(name, 10)).sort((a, b) => a - b);
}

async function status(folder: string, task: StoredTask): Promise<SourceTaskStatus> {
  return {
    id: task.id, status: task.status,
    uploadedIndexes: task.status === 'success' ? [] : await indexes(folder),
    finalPath: task.receipt?.finalPath, error: task.error,
  };
}

async function readInit(req: IncomingMessage): Promise<SourceInitRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new SourceError(413, '源码任务参数过大');
    chunks.push(chunk);
  }
  let body: SourceInitRequest;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SourceError(400, '源码任务参数不是有效的 JSON'); }
  if (!body || typeof body.targetId !== 'string' || !body.targetId || !validSourceName(body.projectName) ||
      typeof body.fileSha256 !== 'string' || !sha256.test(body.fileSha256) || !Number.isSafeInteger(body.fileSize) ||
      body.fileSize <= 0 || !Number.isSafeInteger(body.chunkSize) || body.chunkSize < 1 || body.chunkSize > 16 * MiB ||
      body.chunkCount !== Math.ceil(body.fileSize / body.chunkSize) || body.chunkCount > 10_000) {
    throw new SourceError(400, '源码任务的目标、项目名、校验值或分片参数无效');
  }
  // Normalize to a stable order; unrelated request fields must not become persisted paths.
  const { targetId, projectName, fileSize, fileSha256, chunkSize, chunkCount, archiveVersion } = body;
  if (archiveVersion !== undefined && (typeof archiveVersion !== 'string' || !archiveVersionPattern.test(archiveVersion))) {
    throw new SourceError(400, '源码包版本名称无效');
  }
  return { targetId, projectName, fileSize, fileSha256: fileSha256.toLowerCase(), chunkSize, chunkCount, archiveVersion };
}

async function publishVersion(folder: string, project: string, task: StoredTask, staging: string): Promise<void> {
  const preferred = task.version;
  const timestamp = archiveVersionPattern.exec(preferred);
  const base = timestamp?.[1] ?? preferred;
  let number = Number(timestamp?.[2] ?? 1);
  for (;;) {
    const version = number === 1 ? base : `${base}-${number}`;
    number++;
    const destination = path.join(project, version);
    // Receivers sharing a target must not replace each other's directories, even empty ones.
    const lockPath = path.join(project, `.source-${version}.lock`);
    let lock;
    try { lock = await disk.open(lockPath, 'wx', 0o600); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; throw err; }
    try {
      try { await disk.lstat(destination); continue; }
      catch (err) { if (!isMissing(err)) throw err; }
      if (task.version !== version) {
        task.version = version;
        await saveTask(folder, task);
      }
      await disk.rename(staging, destination);
      return;
    } finally {
      await lock.close();
      await disk.unlink(lockPath);
    }
  }
}

async function writeChunk(req: IncomingMessage, folder: string, task: StoredTask, index: number): Promise<void> {
  const meta = task.request;
  const digest = req.headers['x-chunk-sha256'];
  if (!Number.isSafeInteger(index) || index < 0 || index >= meta.chunkCount ||
      typeof digest !== 'string' || !sha256.test(digest)) throw new SourceError(400, '分片编号或校验值无效');
  const expectedSize = Math.min(meta.chunkSize, meta.fileSize - index * meta.chunkSize);
  const tmp = path.join(folder, 'chunk.tmp');
  const hash = crypto.createHash('sha256');
  let size = 0;
  async function* data() {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > expectedSize) throw new SourceError(413, '分片超过声明大小');
      hash.update(chunk);
      yield chunk;
    }
  }
  try {
    await pipeline(Readable.from(data()), fs.createWriteStream(tmp, { mode: 0o600 }));
    if (size !== expectedSize || hash.digest('hex') !== digest.toLowerCase()) {
      throw new SourceError(400, '源码分片大小或校验值不符，请重传');
    }
    await disk.rename(tmp, path.join(folder, `${index}.part`));
  } finally { await disk.rm(tmp, { force: true }); }
}

async function removePayload(folder: string): Promise<void> {
  const entries = await disk.readdir(folder);
  await Promise.all(entries.filter(name => /^\d+\.part$/.test(name) || name === 'source.zip' || name === 'chunk.tmp')
    .map(name => disk.rm(path.join(folder, name), { force: true })));
}

async function assembleZip(folder: string, task: StoredTask): Promise<string> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  async function* parts() {
    for (let i = 0; i < task.request.chunkCount; i++) {
      for await (const chunk of fs.createReadStream(path.join(folder, `${i}.part`))) {
        bytes += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    }
  }
  const file = path.join(folder, 'source.zip');
  await pipeline(Readable.from(parts()), fs.createWriteStream(file, { mode: 0o600 }));
  if (bytes !== task.request.fileSize || hash.digest('hex') !== task.request.fileSha256) {
    await removePayload(folder);
    throw new Error('源码包整包校验失败，请重试重新上传');
  }
  return file;
}

export class SourceReceiver {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly processing = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly getConfig: () => ReceiverConfig) {}

  // Serializes init, chunk writes and completion transitions for the same task.
  private async locked<T>(folder: string, action: () => Promise<T>): Promise<T> {
    const current = (this.pending.get(folder) ?? Promise.resolve()).then(action, action);
    this.pending.set(folder, current);
    try { return await current; }
    finally { if (this.pending.get(folder) === current) this.pending.delete(folder); }
  }

  private async currentTarget(targetId: string): Promise<SourceTarget> {
    const target = (this.getConfig().sourceTargets ?? []).find(item => item.id === targetId);
    if (!target || !path.isAbsolute(target.path)) throw new SourceError(400, '接收目标不存在或未指定绝对目录');
    const real = await disk.realpath(target.path);
    if (!(await disk.stat(real)).isDirectory()) throw new SourceError(400, '接收目标不是文件夹');
    await disk.access(real, fs.constants.W_OK | fs.constants.X_OK);
    return { id: target.id, name: target.name, path: real };
  }

  private async readRecovered(folder: string): Promise<StoredTask> {
    const task = await readTask(folder);
    if (task.status === 'extracting' && !this.processing.has(folder)) {
      // A crash can happen between publishing a directory and persisting the receipt.
      if (task.staging && await directoryIdentity(finalPath(task)) === task.staging.identity) {
        await this.finish(folder, task);
      } else {
        await this.clearStaging(task);
        task.status = 'failed';
        task.error = '接收服务在解压期间中断，可以重试此任务';
        await saveTask(folder, task);
      }
    }
    return task;
  }

  private async clearStaging(task: StoredTask): Promise<void> {
    if (task.staging && await directoryIdentity(task.staging.path) === task.staging.identity) {
      await disk.rm(task.staging.path, { recursive: true, force: true });
    }
    delete task.staging;
  }

  private async finish(folder: string, task: StoredTask): Promise<void> {
    const receipt: SourceReceipt = {
      id: task.id, projectName: task.request.projectName, targetName: task.target.name,
      completedAt: new Date().toISOString(), finalPath: finalPath(task),
    };
    await saveTask(folder, { ...task, status: 'success', receipt, staging: undefined, error: undefined });
    Object.assign(task, { status: 'success', receipt, staging: undefined, error: undefined });
    await removePayload(folder).catch(() => { /* Receipt is already committed. */ });
  }

  private async publish(folder: string, task: StoredTask): Promise<void> {
    const target = await this.currentTarget(task.target.id);
    if (target.path !== task.target.path) throw new Error('接收目标已更改，请新建发送任务');
    const project = path.join(target.path, task.request.projectName);
    await disk.mkdir(project, { recursive: true });
    if (await disk.realpath(project) !== project) throw new Error('项目目录不能是符号链接');
    try {
      const archive = await assembleZip(folder, task);
      const staging = await disk.mkdtemp(path.join(project, '.source-'));
      const identity = await directoryIdentity(staging);
      if (!identity) throw new Error('源码解压临时目录不可用');
      task.staging = { path: staging, identity };
      await saveTask(folder, task);
      const expansionLimit = Math.min(4096 * MiB, Math.max(64 * MiB, this.getConfig().maxUploadMb * MiB * 8));
      await extractSourceZip(archive, staging, expansionLimit);
      if (await disk.realpath(project) !== project ||
          (await this.currentTarget(task.target.id)).path !== target.path) throw new Error('接收目录已更改');
      await publishVersion(folder, project, task, staging);
      await this.finish(folder, task);
    } finally { await disk.rm(path.join(folder, 'source.zip'), { force: true }); }
  }

  private schedule(folder: string, task: StoredTask): void {
    this.processing.add(folder);
    this.queue = this.queue.then(async () => {
      try { await this.publish(folder, task); }
      catch (err) {
        // If rename already succeeded, leave the journal for readRecovered to finish.
        if (!task.staging || await directoryIdentity(finalPath(task)) !== task.staging.identity) {
          await this.clearStaging(task);
          task.status = 'failed';
          task.error = (err as Error).message;
          await saveTask(folder, task);
        }
      } finally { this.processing.delete(folder); }
    }).catch(error => { console.error('无法保存源码任务状态', error); });
  }

  async receipts(workRoot: string): Promise<SourceReceipt[]> {
    const base = path.join(workRoot, 'source-tasks');
    let entries: fs.Dirent[];
    try { entries = await disk.readdir(base, { withFileTypes: true }); }
    catch (err) { if (isMissing(err)) return []; throw err; }
    const result: SourceReceipt[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !taskIdPattern.test(entry.name)) continue;
      const folder = path.join(base, entry.name);
      try {
        const task = await this.locked(folder, () => this.readRecovered(folder));
        if (task.status === 'success' && task.receipt) result.push(task.receipt);
      } catch (err) {
        if (!(err instanceof SourceError && err.code === 404)) throw err;
      }
    }
    return result.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }

  async handle(req: IncomingMessage, res: ServerResponse, workRoot: string): Promise<void> {
    const respond = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const token = this.getConfig().authToken;
      if (!token?.trim() || req.headers.authorization !== 'Bearer ' + token) throw new SourceError(401, '接收端鉴权失败');
      const route = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && route === '/api/v1/source/targets') {
        respond(200, { targets: this.getConfig().sourceTargets ?? [] });
        return;
      }
      const match = route.match(/^\/api\/v1\/source\/tasks\/([a-zA-Z0-9_-]{1,96})(?:\/(init|complete|chunks\/(\d+)))?$/);
      if (!match) throw new SourceError(404, '源码接口不存在');
      const [, id, operation, chunkIndex] = match;
      const folder = path.join(workRoot, 'source-tasks', id);
      const initialization = req.method === 'POST' && operation === 'init' ? await readInit(req) : undefined;
      const payload = await this.locked(folder, async () => {
        if (initialization) {
          let existing: StoredTask | undefined;
          try { existing = await this.readRecovered(folder); }
          catch (err) { if (!(err instanceof SourceError && err.code === 404)) throw err; }
          // Older receivers saved requests without the optional naming hint; retries keep the saved version.
          if (existing) initialization.archiveVersion = existing.request.archiveVersion;
          if (existing && JSON.stringify(existing.request) !== JSON.stringify(initialization)) {
            throw new SourceError(409, '任务 ID 已用于另一份源码包或接收目标');
          }
          if (existing && existing.status !== 'failed') return status(folder, existing);
          const limit = this.getConfig().maxUploadMb * MiB;
          if (!Number.isFinite(limit) || limit <= 0 || initialization.fileSize > limit) {
            throw new SourceError(413, '源码包超过接收端允许的上传大小');
          }
          const target = await this.currentTarget(initialization.targetId);
          if (existing && existing.target.path !== target.path) throw new SourceError(409, '原任务的目标目录已更改');
          const task: StoredTask = existing ?? { id, request: initialization,
            version: initialization.archiveVersion ?? sourceVersionTime(new Date()), target, status: 'uploading' };
          task.status = 'uploading';
          delete task.error;
          await disk.mkdir(folder, { recursive: true, mode: 0o700 });
          await saveTask(folder, task);
          return status(folder, task);
        }

        const task = await this.readRecovered(folder);
        if (req.method === 'GET' && !operation) return status(folder, task);
        if (req.method === 'PUT' && chunkIndex !== undefined) {
          if (task.status !== 'uploading') throw new SourceError(409, '当前任务不接受分片');
          await writeChunk(req, folder, task, Number(chunkIndex));
          return { ok: true };
        }
        if (req.method === 'POST' && operation === 'complete') {
          if (task.status !== 'uploading') return status(folder, task);
          const uploaded = await indexes(folder);
          if (uploaded.length !== task.request.chunkCount) throw new SourceError(409, '源码分片尚未传完');
          task.status = 'extracting';
          await saveTask(folder, task);
          this.schedule(folder, task);
          return { id, status: 'extracting', uploadedIndexes: uploaded };
        }
        throw new SourceError(404, '源码接口不存在');
      });
      respond(200, payload);
    } catch (err) {
      const error = err as Error;
      respond(err instanceof SourceError ? err.code : 500, { message: error.message });
    }
  }
}
