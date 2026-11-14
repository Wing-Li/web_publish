import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, SourceTarget } from '../shared/types';

import { normalizeProjects } from '../shared/projects';

const DEFAULT_CONFIG: AppConfig = {
  mode: 'sender',
  senderProjects: [],
  receiver: {
    host: '127.0.0.1',
    port: 17777,
    authToken: 'change-me',
    maxUploadMb: 500,
    workRootName: 'web-publisher',
    cloudflareApiToken: '',
    cloudflareAccountId: '',
    wranglerBin: 'wrangler',
    sourceTargets: [],
  },
};

interface LegacyConfig {
  senderProfile?: {
    id?: string;
    name?: string;
    projectPath?: string;
    buildCommand?: string;
    buildOutputDir?: string;
    artifactOutputDir?: string;
    gitBranch?: string;
    receiverBaseUrl?: string;
    receiverToken?: string;
    projectName?: string;
    deployBranch?: string;
  };
}

const ensureDir = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const normalizeMode = (mode: unknown): AppConfig['mode'] =>
  mode === 'receiver' || mode === 'both' ? mode : 'sender';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const normalizeTargets = (raw: unknown): SourceTarget[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('源码接收目录配置格式无效');
  const ids = new Set<string>();
  return raw.map((target) => {
    if (!isRecord(target) || typeof target.id !== 'string' || !target.id.trim()
      || typeof target.name !== 'string' || !target.name.trim()
      || typeof target.path !== 'string' || !path.isAbsolute(target.path)) {
      throw new Error('请为每个源码接收目录设置名称并选择本机目录');
    }
    const id = target.id.trim();
    if (ids.has(id)) throw new Error('源码接收目录的标识重复');
    ids.add(id);
    return { id, name: target.name.trim(), path: path.normalize(target.path) };
  });
};

export class ConfigStore {
  private readonly filePath: string;

  constructor(private readonly hasPendingSource: (id: string) => boolean) {
    const userDataDir = app.getPath('userData');
    ensureDir(userDataDir);
    this.filePath = path.join(userDataDir, 'config.json');
  }

  load(): AppConfig {
    if (!fs.existsSync(this.filePath)) {
      this.save(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const normalized = this.normalize(JSON.parse(content));

    this.save(normalized);
    return normalized;
  }

  normalize(raw: unknown): AppConfig {
    if (!raw || typeof raw !== 'object') {
      throw new Error('配置文件格式无效，请选择由本工具导出的 JSON 文件。');
    }

    const parsed = raw as Partial<AppConfig> & LegacyConfig;
    const legacy = parsed.senderProfile;
    const rows = parsed.senderProjects ?? (legacy ? [{ ...legacy, pagesProjectName: legacy.projectName }] : []);
    if (!Array.isArray(rows)) throw new Error('项目列表格式无效');
    const receiver: Record<string, unknown> = isRecord(parsed.receiver) ? parsed.receiver : {};

    return {
      ...DEFAULT_CONFIG,
      mode: normalizeMode(parsed.mode),
      senderProjects: normalizeProjects(rows, this.hasPendingSource),
      receiver: {
        ...DEFAULT_CONFIG.receiver,
        ...receiver,
        sourceTargets: normalizeTargets(receiver.sourceTargets),
      },
    };
  }

  save(config: AppConfig): void {
    fs.writeFileSync(this.filePath, JSON.stringify(config, null, 2), 'utf-8');
  }

  getPath(): string {
    return this.filePath;
  }
}
