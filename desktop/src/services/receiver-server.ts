import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DeploymentTask, ReceiverConfig } from '../shared/types';
import { runCommand } from '../shared/run-command';

interface DeploymentMetadata {
  projectName: string;
  branch: string;
  commitSha?: string;
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

export class ReceiverServer {
  private server: http.Server | null = null;

  private readonly tasks = new Map<string, DeploymentTask>();

  private queue: Promise<void> = Promise.resolve();

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
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    workRoot: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url === '/api/v1/deployments') {
      await this.handleCreateDeployment(req, res, workRoot);
      return;
    }

    if (method === 'GET' && url.startsWith('/api/v1/deployments/')) {
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

        // zip slip 安全检查
        try {
          await checkZipSlip(zipPath, extractPath);
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
        );

        if (unzipResult.code !== 0) {
          task.status = 'failed';
          task.error = `解压失败: ${unzipResult.output}`;
          task.finishedAt = new Date().toISOString();
          return;
        }

        const cfg = this.getConfig();
        const deployResult = await runCommand(
          cfg.wranglerBin,
          [
            'pages',
            'deploy',
            extractPath,
            '--project-name',
            metadata.projectName,
            '--branch',
            metadata.branch,
          ],
          extractPath,
          {
            CLOUDFLARE_API_TOKEN: cfg.cloudflareApiToken,
            CLOUDFLARE_ACCOUNT_ID: cfg.cloudflareAccountId,
          },
        );

        task.logs = deployResult.output;

        const urlMatch = deployResult.output.match(/https?:\/\/[^\s]+pages\.dev[^\s]*/);

        if (deployResult.code === 0) {
          task.status = 'success';
          task.url = urlMatch?.[0] ?? '';
          task.finishedAt = new Date().toISOString();
          return;
        }

        task.status = 'failed';
        task.error = deployResult.output;
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
}
