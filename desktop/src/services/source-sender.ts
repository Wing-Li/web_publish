import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { packSource } from './source-pack/pack';
import type { SourceProject, SourceInitRequest, SourceTarget, SourceTaskStatus } from '../shared/types';

const CHUNK_SIZE = 9 * 1024 * 1024;

interface PendingSource {
  id: string;
  receiver: string;
  init: SourceInitRequest;
}

function receiverAddress(project: SourceProject): string {
  const address = new URL(project.receiverBaseUrl);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password ||
      address.hash || address.search) throw new Error('请填写有效的 HTTP(S) 接收端地址。');
  return address.href.replace(/\/+$/, '');
}

async function hashFile(archive: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  return hash.digest('hex');
}

async function request<T>(url: string, token: string, options: RequestInit = {}, missingRouteHint?: string): Promise<T> {
  if (!token.trim()) throw new Error('请填写接收端鉴权 Token。');
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!response.ok) {
    if (response.status === 404 && missingRouteHint) throw new Error(missingRouteHint);
    let detail = '';
    try {
      const body = await response.json();
      detail = String(body.message || body.error || '').slice(0, 300);
    } catch { /* Some proxies return HTML errors. */ }
    throw new Error(`接收端返回 HTTP ${response.status}。${detail}`);
  }
  return response.json() as Promise<T>;
}

function validateStatus(result: SourceTaskStatus, id: string): SourceTaskStatus {
  if (!result || result.id !== id ||
      !['uploading', 'extracting', 'success', 'failed'].includes(result.status)) {
    throw new Error('接收端返回了无法识别的源码任务状态。');
  }
  if (result.status === 'uploading' && !Array.isArray(result.uploadedIndexes)) {
    throw new Error('接收端没有返回已接收的分片列表。');
  }
  return result;
}

export class SourceSender {
  private readonly active = new Set<string>();

  constructor(private readonly stateDir: string) {}

  private projectDir(projectId: string): string {
    const key = createHash('sha256').update(projectId).digest('hex');
    return path.resolve(this.stateDir, key);
  }

  getPending(projectId: string): boolean {
    return fs.existsSync(path.join(this.projectDir(projectId), 'pending.json'));
  }

  async getTargets(project: SourceProject): Promise<SourceTarget[]> {
    const endpoint = `${receiverAddress(project)}/api/v1/source/targets`;
    const response = await request<{targets: SourceTarget[]}>(endpoint, project.receiverToken, {},
      '未找到源码接收接口。请核对接收端地址，并确认接收端已更新到支持发送源码的版本。');
    if (!Array.isArray(response?.targets) || !response.targets.every(t =>
      t && [t.id, t.name, t.path].every(v => typeof v === 'string' && v.length > 0))) {
      throw new Error('接收端返回的源码目录列表无效。');
    }
    return response.targets;
  }

  private async readPending(dir: string): Promise<PendingSource> {
    const raw: PendingSource = JSON.parse(await fs.promises.readFile(path.join(dir, 'pending.json'), 'utf8'));
    if (!raw || !/^[0-9a-f-]{36}$/.test(raw.id) || !raw.init || !raw.receiver) {
      throw new Error('待重试任务的本地记录损坏，请重新发送源码。');
    }
    return raw;
  }

  private async prepare(project: SourceProject, dir: string, receiver: string, log: (msg: string) => void) {
    if (!project.sourceTargetId) throw new Error('请选择接收端源码目录。');
    if (!project.name.trim()) throw new Error('请填写项目名称。');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const archive = path.join(dir, `${id}.zip`);
    const tmp = path.join(dir, `${id}.tmp`);
    let previous: PendingSource | undefined;
    if (this.getPending(project.id)) {
      try { previous = await this.readPending(dir); } catch { /* A fresh send can replace an unreadable record. */ }
    }
    try {
      log('开始打包当前工作目录…\n');
      const count = await packSource(project.projectPath, archive, this.stateDir);
      log(`已打包 ${count} 个源码文件。\n`);
      const { size } = await fs.promises.stat(archive);
      const pending: PendingSource = {
        id, receiver,
        init: { targetId: project.sourceTargetId, projectName: project.name, fileSize: size,
          fileSha256: await hashFile(archive), chunkSize: CHUNK_SIZE, chunkCount: Math.ceil(size / CHUNK_SIZE) },
      };
      await fs.promises.writeFile(tmp, JSON.stringify(pending), { mode: 0o600 });
      await fs.promises.rename(tmp, path.join(dir, 'pending.json'));
      if (previous) await fs.promises.rm(path.join(dir, `${previous.id}.zip`), { force: true }).catch((): void => undefined);
      return pending;
    } catch (error) {
      await fs.promises.rm(tmp, { force: true }).catch((): void => undefined);
      await fs.promises.rm(archive, { force: true }).catch((): void => undefined);
      throw error;
    }
  }

  private async uploadMissing(
    pending: PendingSource, archive: string, endpoint: string, token: string,
    uploaded: number[], log: (msg: string) => void,
  ): Promise<void> {
    const { chunkCount, chunkSize, fileSize } = pending.init;
    const received = new Set(uploaded);
    if (received.size) log(`接收端已收到 ${received.size}/${chunkCount} 个分片。\n`);
    const file = await fs.promises.open(archive, 'r');
    try {
      if ((await file.stat()).size !== fileSize) throw new Error('本地缓存的源码包大小已改变，请重新发送源码。');
      for (let index = 0; index < chunkCount; index++) {
        if (received.has(index)) continue;
        const position = index * chunkSize;
        const buffer = Buffer.allocUnsafe(Math.min(chunkSize, fileSize - position));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
          if (!bytesRead) throw new Error('本地缓存的源码包不完整，请重新发送源码。');
          offset += bytesRead;
        }
        log(`上传源码分片 ${index + 1}/${chunkCount}…\n`);
        await request(`${endpoint}/chunks/${index}`, token, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream',
            'X-Chunk-SHA256': createHash('sha256').update(buffer).digest('hex') },
          body: buffer,
        });
      }
    } finally {
      await file.close();
    }
  }

  async send(project: SourceProject, retry: boolean, onLog: (msg: string) => void): Promise<{finalPath: string}> {
    if (this.active.has(project.id)) throw new Error('此项目已有源码发送任务正在进行。');
    this.active.add(project.id);
    try {
      const dir = this.projectDir(project.id);
      const receiver = receiverAddress(project);
      const token = project.receiverToken;
      if (!token.trim()) throw new Error('请填写接收端鉴权 Token。');
      if (retry && !this.getPending(project.id)) throw new Error('此项目没有待重试的源码任务。');
      const pending = retry
        ? await this.readPending(dir)
        : await this.prepare(project, dir, receiver, onLog);
      if (pending.receiver !== receiver) {
        throw new Error('接收端地址已更改，请恢复原地址后重试，或点击「发送源码」创建新版本。');
      }
      if (retry) onLog(`继续原源码任务 ${pending.id}。\n`);
      const archive = path.join(dir, `${pending.id}.zip`);
      const endpoint = `${receiver}/api/v1/source/tasks/${pending.id}`;
      const status = async (url: string, opts?: RequestInit): Promise<SourceTaskStatus> =>
        validateStatus(await request<SourceTaskStatus>(url, token, opts), pending.id);
      let result = await status(`${endpoint}/init`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.init),
      });
      if (result.status === 'uploading') {
        await this.uploadMissing(pending, archive, endpoint, token, result.uploadedIndexes, onLog);
        onLog('分片已上传，正在由接收端校验并解压…\n');
        result = await status(`${endpoint}/complete`, { method: 'POST' });
      }
      while (result.status === 'extracting') {
        await delay(1000);
        result = await status(endpoint);
      }
      if (result.status !== 'success' || !result.finalPath) {
        throw new Error(result.error || '接收端尚未完成源码解压，请重试原任务。');
      }
      // The receiver's success receipt is authoritative, even if local cleanup fails.
      try {
        await fs.promises.unlink(path.join(dir, 'pending.json'));
        await fs.promises.rm(archive, { force: true });
      } catch { onLog('接收端已完成，本地缓存清理未完成。\n'); }
      return { finalPath: result.finalPath };
    } finally {
      this.active.delete(project.id);
    }
  }
}
