import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  DeploymentTask,
  ReceiverConfig,
  UploadCompleteResponse,
  UploadInitRequest,
  UploadInitResponse,
  UploadStatusResponse,
} from '../shared/types';
import { runCommand } from '../shared/run-command';
import { SourceReceiver } from './source-receiver';

interface DeploymentMetadata {
  projectName: string;
  branch: string;
  commitSha?: string;
}

interface DeployAttemptResult {
  ok: boolean;
  url?: string;
  error?: string;
}

interface WranglerLauncher {
  command: string;
  baseArgs: string[];
  label: string;
}

interface UploadSessionMeta {
  uploadId: string;
  uploadKey: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  chunkSize: number;
  chunkCount: number;
  metadata: DeploymentMetadata;
  completed: boolean;
  deploymentId?: string;
  createdAt: string;
  updatedAt: string;
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};

const ensureDir = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const readBodyAsJson = async <T>(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<T> => {
  const chunks: Buffer[] = [];
  let size = 0;

  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
};

const buildWranglerEnv = (cfg: ReceiverConfig): NodeJS.ProcessEnv => ({
  CLOUDFLARE_API_TOKEN: cfg.cloudflareApiToken,
  CLOUDFLARE_ACCOUNT_ID: cfg.cloudflareAccountId,
  CI: '1',
  WRANGLER_SEND_METRICS: 'false',
  NO_COLOR: '1',
});

const buildDeployErrorHint = (raw: string): string => {
  const output = raw.toLowerCase();

  if (output.includes('command not found') || output.includes('enoent')) {
    return '未找到 wrangler 命令，请在接收端安装 Wrangler CLI，或修改 wranglerBin。';
  }
  if (output.includes('authentication') || output.includes('unauthorized') || output.includes('forbidden')) {
    return 'Cloudflare 鉴权失败，请检查 API Token 权限和 Account ID。';
  }
  if (output.includes('project') && output.includes('not found')) {
    return 'Pages 项目不存在，请先在 Cloudflare 创建 Direct Upload 项目，或检查项目名。';
  }
  if (output.includes('branch')) {
    return '分支参数异常，请检查 deployBranch 配置是否有效。';
  }
  if (output.includes('too large') || output.includes('file size')) {
    return '静态资源文件大小超出限制，请压缩或拆分过大文件后再部署。';
  }

  return 'wrangler pages deploy 执行失败，请查看完整日志定位问题。';
};

const isProjectAlreadyExists = (raw: string): boolean => {
  const output = raw.toLowerCase();
  return output.includes('already exists') || output.includes('project already exists');
};

const parseCommandLine = (raw: string): { command: string; baseArgs: string[] } | null => {
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    command: parts[0],
    baseArgs: parts.slice(1),
  };
};

const uniqueLaunchers = (items: WranglerLauncher[]): WranglerLauncher[] => {
  const seen = new Set<string>();
  const result: WranglerLauncher[] = [];
  for (const item of items) {
    const key = `${item.command}::${item.baseArgs.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

/**
 * 流式接收请求体并写入文件。
 * 同时计算 SHA256、累计大小；超过 maxBytes 时立刻中止并抛出错误。
 */
const readBodyToFile = async (
  req: IncomingMessage,
  filePath: string,
  maxBytes: number,
): Promise<{ sha256: string; size: number }> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(filePath);
    let size = 0;
    let aborted = false;

    const abort = (err: Error): void => {
      if (aborted) return;
      aborted = true;
      req.destroy();
      output.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 忽略清理失败
      }
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        abort(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      hash.update(chunk);
      output.write(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      output.end(() => {
        resolve({ sha256: hash.digest('hex'), size });
      });
    });

    req.on('error', (err) => {
      abort(err);
    });

    output.on('error', (err) => {
      abort(err);
    });
  });

/**
 * 使用 unzip -l 预检 zip 内文件路径，防止 zip slip 攻击。
 * 确保所有条目解压后都落在 extractPath 目录内。
 */
const checkZipSlip = async (
  zipPath: string,
  extractPath: string,
): Promise<void> => {
  const result = await runCommand('unzip', ['-l', zipPath], extractPath);
  if (result.code !== 0) {
    throw new Error(`zip 预检失败: ${result.output}`);
  }

  const lines = result.output.split('\n');
  const resolvedExtract = path.resolve(extractPath);

  for (const line of lines) {
    // unzip -l 输出格式: "  length  date  time  name"
    const match = line.match(/\s+\d+\s+\S+\s+\S+\s+(.+)/);
    if (!match) continue;
    const entryName = match[1].trim();
    if (!entryName || entryName.endsWith('/')) continue;

    const resolved = path.resolve(extractPath, entryName);
    if (!resolved.startsWith(resolvedExtract + path.sep) && resolved !== resolvedExtract) {
      throw new Error(`zip 包含非法路径（zip slip 攻击）: ${entryName}`);
    }
  }
};

const readMeta = (metaPath: string): UploadSessionMeta => {
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as UploadSessionMeta;
};

const writeMeta = (metaPath: string, meta: UploadSessionMeta): void => {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
};

const formatChunkFileName = (index: number): string => `${String(index).padStart(6, '0')}.part`;

const collectUploadedIndexes = (chunksDir: string): number[] => {
  if (!fs.existsSync(chunksDir)) return [];
  return fs.readdirSync(chunksDir)
    .map((name) => name.match(/^(\d+)\.part$/)?.[1] ?? '')
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);
};

const mergeChunksToZip = async (
  chunksDir: string,
  chunkCount: number,
  targetZipPath: string,
): Promise<{ sha256: string; size: number }> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(targetZipPath);
    let size = 0;
    let index = 0;

    const abort = (err: Error): void => {
      output.destroy();
      try {
        fs.unlinkSync(targetZipPath);
      } catch {
        // ignore cleanup failure
      }
      reject(err);
    };

    const pipeNext = (): void => {
      if (index >= chunkCount) {
        output.end(() => resolve({ sha256: hash.digest('hex'), size }));
        return;
      }

      const partPath = path.join(chunksDir, formatChunkFileName(index));
      if (!fs.existsSync(partPath)) {
        abort(new Error(`缺少分片: ${index}`));
        return;
      }

      const input = fs.createReadStream(partPath);
      input.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      });
      input.on('error', (err) => abort(err as Error));
      input.on('end', () => {
        index += 1;
        pipeNext();
      });
      input.pipe(output, { end: false });
    };

    output.on('error', (err) => abort(err as Error));
    pipeNext();
  });

export class ReceiverServer {
  private server: http.Server | null = null;

  private readonly sources = new SourceReceiver(() => this.getConfig());
  private activeWorkRoot?: string;

  getSourceReceipts() {
    return this.sources.receipts(this.activeWorkRoot ?? path.join(os.homedir(), this.getConfig().workRootName));
  }

  private readonly tasks = new Map<string, DeploymentTask>();

  private queue: Promise<void> = Promise.resolve();

  private static readonly TASK_LOG_MAX_CHARS = 300 * 1024;

  constructor(private readonly getConfig: () => ReceiverConfig) {}

  getStatus(): { running: boolean; host: string; port: number } {
    const cfg = this.getConfig();
    return {
      running: this.server !== null,
      host: cfg.host,
      port: cfg.port,
    };
  }

  getTask(id: string): DeploymentTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): DeploymentTask[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const cfg = this.getConfig();
    const workRoot = path.join(os.homedir(), cfg.workRootName);
    ensureDir(workRoot);
    this.activeWorkRoot = workRoot;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res, workRoot).catch((err) => {
        json(res, 500, { message: (err as Error).message });
      });
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(cfg.port, cfg.host, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.server = null;
    this.activeWorkRoot = undefined;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (url.startsWith('/api/v1/source/')) {
      await this.sources.handle(req, res, workRoot);
      return;
    }

    if (method === 'GET' && url === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url === '/api/v1/deployments') {
      await this.handleCreateDeployment(req, res, workRoot);
      return;
    }

    if (method === 'POST' && url === '/api/v1/uploads/init') {
      await this.handleInitUpload(req, res, workRoot);
      return;
    }

    if (method === 'GET' && url.startsWith('/api/v1/uploads/')) {
      await this.handleUploadStatus(req, res, workRoot);
      return;
    }

    if (method === 'PUT' && url.startsWith('/api/v1/uploads/')) {
      await this.handleUploadChunk(req, res, workRoot);
      return;
    }

    if (method === 'POST' && url.startsWith('/api/v1/uploads/')) {
      await this.handleCompleteUpload(req, res, workRoot);
      return;
    }

    if (method === 'GET' && url.startsWith('/api/v1/deployments/')) {
      if (!this.checkAuth(req)) {
        json(res, 401, { message: '鉴权失败，请检查 Token' });
        return;
      }
      const id = url.replace('/api/v1/deployments/', '');
      const task = this.tasks.get(id);
      if (!task) {
        json(res, 404, { message: 'deployment not found' });
        return;
      }
      json(res, 200, task);
      return;
    }

    json(res, 404, { message: 'not found' });
  }

  private checkAuth(req: IncomingMessage): boolean {
    const cfg = this.getConfig();
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${cfg.authToken}`;
  }

  private parseMetadata(req: IncomingMessage): DeploymentMetadata {
    const rawHeader = req.headers['x-metadata-base64'];
    const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!value) {
      throw new Error('missing x-metadata-base64');
    }

    const jsonText = Buffer.from(value, 'base64').toString('utf-8');
    const data = JSON.parse(jsonText) as DeploymentMetadata;

    if (!data.projectName || !data.branch) {
      throw new Error('invalid metadata: projectName and branch are required');
    }

    return data;
  }

  private getUploadPaths(workRoot: string, uploadId: string): {
    uploadDir: string;
    chunksDir: string;
    metaPath: string;
    zipPath: string;
  } {
    const uploadDir = path.join(workRoot, 'uploads', uploadId);
    return {
      uploadDir,
      chunksDir: path.join(uploadDir, 'chunks'),
      metaPath: path.join(uploadDir, 'meta.json'),
      zipPath: path.join(uploadDir, 'artifact.zip'),
    };
  }

  private getUploadMeta(workRoot: string, uploadId: string): UploadSessionMeta | null {
    const { metaPath } = this.getUploadPaths(workRoot, uploadId);
    if (!fs.existsSync(metaPath)) return null;
    return readMeta(metaPath);
  }

  private async handleInitUpload(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    if (!this.checkAuth(req)) {
      json(res, 401, { message: '鉴权失败，请检查 Token' });
      return;
    }

    let body: UploadInitRequest;
    try {
      body = await readBodyAsJson<UploadInitRequest>(req);
    } catch (err) {
      json(res, 400, { message: `初始化上传失败: ${(err as Error).message}` });
      return;
    }

    if (
      !body.uploadKey?.trim() ||
      !body.projectName?.trim() ||
      !body.branch?.trim() ||
      !body.fileName?.trim() ||
      !body.fileSha256?.trim() ||
      !Number.isInteger(body.fileSize) ||
      body.fileSize <= 0 ||
      !Number.isInteger(body.chunkSize) ||
      body.chunkSize <= 0 ||
      !Number.isInteger(body.chunkCount) ||
      body.chunkCount <= 0
    ) {
      json(res, 400, { message: '上传初始化参数不完整或格式错误' });
      return;
    }

    const uploadId = `upl_${body.uploadKey.trim()}`;
    const { uploadDir, chunksDir, metaPath } = this.getUploadPaths(workRoot, uploadId);
    if (fs.existsSync(metaPath)) {
      const existing = readMeta(metaPath);
      if (!existing.completed) {
        const payload: UploadInitResponse = { uploadId: existing.uploadId };
        json(res, 200, payload);
        return;
      }
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }

    ensureDir(uploadDir);
    ensureDir(chunksDir);

    const now = new Date().toISOString();
    const meta: UploadSessionMeta = {
      uploadId,
      uploadKey: body.uploadKey.trim(),
      fileName: body.fileName,
      fileSize: body.fileSize,
      fileSha256: body.fileSha256,
      chunkSize: body.chunkSize,
      chunkCount: body.chunkCount,
      metadata: {
        projectName: body.projectName,
        branch: body.branch,
      },
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    writeMeta(metaPath, meta);

    const payload: UploadInitResponse = { uploadId };
    json(res, 200, payload);
  }

  private async handleUploadStatus(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    if (!this.checkAuth(req)) {
      json(res, 401, { message: '鉴权失败，请检查 Token' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const match = pathname.match(/^\/api\/v1\/uploads\/([^/]+)$/);
    if (!match) {
      json(res, 404, { message: 'not found' });
      return;
    }

    const uploadId = decodeURIComponent(match[1]);
    const meta = this.getUploadMeta(workRoot, uploadId);
    if (!meta) {
      json(res, 404, { message: 'upload not found' });
      return;
    }

    const { chunksDir } = this.getUploadPaths(workRoot, uploadId);
    const payload: UploadStatusResponse = {
      uploadId,
      chunkCount: meta.chunkCount,
      uploadedIndexes: collectUploadedIndexes(chunksDir),
      completed: meta.completed,
    };
    json(res, 200, payload);
  }

  private async handleUploadChunk(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    if (!this.checkAuth(req)) {
      json(res, 401, { message: '鉴权失败，请检查 Token' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const match = pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/);
    if (!match) {
      json(res, 404, { message: 'not found' });
      return;
    }

    const uploadId = decodeURIComponent(match[1]);
    const index = Number(match[2]);
    const meta = this.getUploadMeta(workRoot, uploadId);
    if (!meta) {
      json(res, 404, { message: 'upload not found' });
      return;
    }
    if (meta.completed) {
      json(res, 409, { message: '上传会话已完成，不能继续上传分片' });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) {
      json(res, 400, { message: '分片索引超出范围' });
      return;
    }

    const expectedSha = (req.headers['x-chunk-sha256'] ?? '').toString().trim();
    if (!expectedSha) {
      json(res, 400, { message: '缺少 X-Chunk-SHA256' });
      return;
    }

    const { chunksDir, metaPath } = this.getUploadPaths(workRoot, uploadId);
    ensureDir(chunksDir);
    const chunkPath = path.join(chunksDir, formatChunkFileName(index));

    let result: { sha256: string; size: number };
    try {
      result = await readBodyToFile(req, chunkPath, meta.chunkSize);
    } catch (err) {
      const message = (err as Error).message;
      json(res, message === 'PAYLOAD_TOO_LARGE' ? 413 : 500, {
        message: `分片接收失败: ${message}`,
      });
      return;
    }

    if (result.sha256 !== expectedSha) {
      try {
        fs.unlinkSync(chunkPath);
      } catch {
        // ignore cleanup failure
      }
      json(res, 400, { message: `分片校验失败: chunk ${index}` });
      return;
    }

    meta.updatedAt = new Date().toISOString();
    writeMeta(metaPath, meta);
    json(res, 200, { ok: true, index, size: result.size });
  }

  private async handleCompleteUpload(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    if (!this.checkAuth(req)) {
      json(res, 401, { message: '鉴权失败，请检查 Token' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const match = pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/complete$/);
    if (!match) {
      json(res, 404, { message: 'not found' });
      return;
    }

    const uploadId = decodeURIComponent(match[1]);
    const paths = this.getUploadPaths(workRoot, uploadId);
    const meta = this.getUploadMeta(workRoot, uploadId);
    if (!meta) {
      json(res, 404, { message: 'upload not found' });
      return;
    }
    if (meta.completed && meta.deploymentId) {
      const payload: UploadCompleteResponse = {
        deploymentId: meta.deploymentId,
        status: 'queued',
      };
      json(res, 200, payload);
      return;
    }

    const uploadedIndexes = collectUploadedIndexes(paths.chunksDir);
    if (uploadedIndexes.length !== meta.chunkCount) {
      json(res, 409, { message: '分片未上传完整，不能合并' });
      return;
    }

    try {
      const merged = await mergeChunksToZip(paths.chunksDir, meta.chunkCount, paths.zipPath);
      if (merged.sha256 !== meta.fileSha256) {
        try {
          fs.unlinkSync(paths.zipPath);
        } catch {
          // ignore cleanup failure
        }
        json(res, 400, { message: '整包 SHA256 校验失败，文件可能在传输中损坏' });
        return;
      }
      if (merged.size !== meta.fileSize) {
        json(res, 400, { message: '整包大小校验失败，文件可能在传输中损坏' });
        return;
      }
    } catch (err) {
      json(res, 500, { message: `合并分片失败: ${(err as Error).message}` });
      return;
    }

    const deploymentId = `dep_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const jobDir = path.join(workRoot, deploymentId);
    ensureDir(jobDir);
    const zipPath = path.join(jobDir, 'artifact.zip');
    const extractPath = path.join(jobDir, 'extracted');
    ensureDir(extractPath);
    fs.copyFileSync(paths.zipPath, zipPath);

    const task: DeploymentTask = {
      id: deploymentId,
      status: 'queued',
      projectName: meta.metadata.projectName,
      branch: meta.metadata.branch,
      createdAt: new Date().toISOString(),
      logs: `[upload] ${uploadId} merged ${meta.chunkCount} chunks\n`,
    };
    this.tasks.set(deploymentId, task);
    this.enqueueProcess(deploymentId, zipPath, extractPath, meta.metadata);

    meta.completed = true;
    meta.deploymentId = deploymentId;
    meta.updatedAt = new Date().toISOString();
    writeMeta(paths.metaPath, meta);

    const payload: UploadCompleteResponse = {
      deploymentId,
      status: 'queued',
    };
    json(res, 200, payload);
  }

  private enqueueProcess(
    taskId: string,
    zipPath: string,
    extractPath: string,
    metadata: DeploymentMetadata,
  ): void {
    this.queue = this.queue
      .then(async () => {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'running';
        task.startedAt = new Date().toISOString();
        task.logs = '';

        const appendTaskLog = (chunk: string): void => {
          const current = task.logs ?? '';
          let next = current + chunk;
          if (next.length > ReceiverServer.TASK_LOG_MAX_CHARS) {
            next = next.slice(next.length - ReceiverServer.TASK_LOG_MAX_CHARS);
          }
          task.logs = next;
        };

        // zip slip 安全检查
        try {
          appendTaskLog('[zip precheck] unzip -l artifact.zip\n');
          await checkZipSlip(zipPath, extractPath);
          appendTaskLog('[zip precheck] ok\n');
        } catch (err) {
          task.status = 'failed';
          task.error = (err as Error).message;
          task.finishedAt = new Date().toISOString();
          return;
        }

        const unzipResult = await runCommand(
          'unzip',
          ['-o', zipPath, '-d', extractPath],
          extractPath,
          undefined,
          (chunk) => appendTaskLog(chunk),
        );

        if (unzipResult.code !== 0) {
          task.status = 'failed';
          task.error = `解压失败: ${unzipResult.output}`;
          task.finishedAt = new Date().toISOString();
          return;
        }

        const cfg = this.getConfig();
        const deployAttempt = await this.deployToCloudflare(
          cfg,
          extractPath,
          metadata,
          appendTaskLog,
        );

        if (deployAttempt.ok) {
          task.status = 'success';
          task.url = deployAttempt.url ?? '';
          task.finishedAt = new Date().toISOString();
          return;
        }

        task.status = 'failed';
        task.error = deployAttempt.error ?? '部署失败';
        task.finishedAt = new Date().toISOString();
      })
      .catch((err: Error) => {
        const task = this.tasks.get(taskId);
        if (!task) return;
        task.status = 'failed';
        task.error = err.message;
        task.finishedAt = new Date().toISOString();
      });
  }

  private async handleCreateDeployment(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    if (!this.checkAuth(req)) {
      json(res, 401, { message: '鉴权失败，请检查 Token' });
      return;
    }

    let metadata: DeploymentMetadata;
    try {
      metadata = this.parseMetadata(req);
    } catch (err) {
      json(res, 400, { message: (err as Error).message });
      return;
    }

    const cfg = this.getConfig();
    const maxBytes = cfg.maxUploadMb * 1024 * 1024;

    const deploymentId = `dep_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const jobDir = path.join(workRoot, deploymentId);
    ensureDir(jobDir);

    const zipPath = path.join(jobDir, 'artifact.zip');
    const extractPath = path.join(jobDir, 'extracted');
    ensureDir(extractPath);

    let bodyResult: { sha256: string; size: number };
    try {
      bodyResult = await readBodyToFile(req, zipPath, maxBytes);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'PAYLOAD_TOO_LARGE') {
        json(res, 413, { message: `上传文件超过限制 ${cfg.maxUploadMb}MB` });
      } else {
        json(res, 500, { message: `文件接收失败: ${message}` });
      }
      return;
    }

    const expectedSha = (req.headers['x-checksum-sha256'] ?? '').toString();
    if (expectedSha && expectedSha !== bodyResult.sha256) {
      fs.unlinkSync(zipPath);
      json(res, 400, { message: 'SHA256 校验失败，文件可能在传输中损坏' });
      return;
    }

    const task: DeploymentTask = {
      id: deploymentId,
      status: 'queued',
      projectName: metadata.projectName,
      branch: metadata.branch,
      createdAt: new Date().toISOString(),
    };

    this.tasks.set(deploymentId, task);
    this.enqueueProcess(deploymentId, zipPath, extractPath, metadata);

    json(res, 200, { deploymentId, status: 'queued' });
  }

  private async deployToCloudflare(
    cfg: ReceiverConfig,
    extractPath: string,
    metadata: DeploymentMetadata,
    onLog: (chunk: string) => void,
  ): Promise<DeployAttemptResult> {
    if (!cfg.cloudflareApiToken.trim()) {
      return { ok: false, error: '未配置 Cloudflare API Token' };
    }
    if (!cfg.cloudflareAccountId.trim()) {
      return { ok: false, error: '未配置 Cloudflare Account ID' };
    }
    if (!cfg.wranglerBin.trim()) {
      return { ok: false, error: '未配置 wranglerBin' };
    }

    const wranglerEnv = buildWranglerEnv(cfg);

    const configured = parseCommandLine(cfg.wranglerBin);
    const candidates = uniqueLaunchers([
      ...(configured ? [{
        command: configured.command,
        baseArgs: configured.baseArgs,
        label: `配置命令: ${cfg.wranglerBin.trim()}`,
      }] : []),
      { command: 'wrangler', baseArgs: [], label: '系统命令 wrangler' },
      { command: 'npx', baseArgs: ['-y', 'wrangler'], label: 'npx -y wrangler' },
      { command: 'pnpm', baseArgs: ['dlx', 'wrangler'], label: 'pnpm dlx wrangler' },
    ]);

    const runWithLauncher = async (
      launcher: WranglerLauncher,
      args: string[],
      title: string,
    ) => {
      onLog(`[${launcher.label}] ${title}\n`);
      const result = await runCommand(
        launcher.command,
        [...launcher.baseArgs, ...args],
        extractPath,
        wranglerEnv,
        (chunk) => onLog(chunk),
      );
      onLog('\n');
      return result;
    };

    let selectedLauncher: WranglerLauncher | null = null;
    for (const launcher of candidates) {
      const versionResult = await runWithLauncher(launcher, ['--version'], 'version check');
      if (versionResult.code === 0) {
        selectedLauncher = launcher;
        break;
      }
    }

    if (!selectedLauncher) {
      return {
        ok: false,
        error: 'Wrangler 不可用：已尝试 wrangler / npx -y wrangler / pnpm dlx wrangler',
      };
    }

    const createArgs = [
      'pages',
      'project',
      'create',
      metadata.projectName,
      '--production-branch',
      metadata.branch,
    ];
    const createResult = await runWithLauncher(
      selectedLauncher,
      createArgs,
      `project create ${metadata.projectName}`,
    );
    if (createResult.code !== 0 && !isProjectAlreadyExists(createResult.output)) {
      return {
        ok: false,
        error: `创建 Pages 项目失败: ${createResult.output}`.trim(),
      };
    }

    const deployArgs = [
      'pages',
      'deploy',
      extractPath,
      '--project-name',
      metadata.projectName,
      '--branch',
      metadata.branch,
    ];

    const deployResult = await runWithLauncher(
      selectedLauncher,
      deployArgs,
      `pages deploy ${metadata.projectName}`,
    );

    const urlMatch = deployResult.output.match(/https?:\/\/[^\s]+pages\.dev[^\s]*/);
    if (deployResult.code === 0) {
      return {
        ok: true,
        url: urlMatch?.[0],
      };
    }

    const hint = buildDeployErrorHint(deployResult.output);
    return {
      ok: false,
      error: `${hint}\n\n${deployResult.output}`.trim(),
    };
  }
}
