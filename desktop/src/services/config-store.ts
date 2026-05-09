import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, SenderProject } from '../shared/types';

const createDefaultProject = (): SenderProject => ({
  id: `project_${Date.now()}`,
  name: '默认项目',
  projectPath: '',
  buildCommand: 'npm run build',
  buildOutputDir: 'dist',
  artifactOutputDir: '',
  gitBranch: 'main',
  receiverBaseUrl: 'http://127.0.0.1:17777',
  receiverToken: 'change-me',
  pagesProjectName: '',
  deployBranch: 'main',
});

const DEFAULT_CONFIG: AppConfig = {
  mode: 'sender',
  senderProjects: [createDefaultProject()],
  receiver: {
    host: '127.0.0.1',
    port: 17777,
    authToken: 'change-me',
    maxUploadMb: 500,
    workRootName: 'web-publisher',
    cloudflareApiToken: '',
    cloudflareAccountId: '',
    wranglerBin: 'wrangler',
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

const normalizeProjects = (
  projects: Partial<SenderProject>[] | undefined,
  legacy: LegacyConfig,
): SenderProject[] => {
  if (projects && projects.length > 0) {
    return projects.map((project, index) => ({
      ...createDefaultProject(),
      ...project,
      id: project.id?.trim() || `project_${Date.now()}_${index}`,
      name: project.name?.trim() || `项目 ${index + 1}`,
    }));
  }

  if (legacy.senderProfile) {
    const profile = legacy.senderProfile;
    return [
      {
        ...createDefaultProject(),
        id: profile.id?.trim() || `project_${Date.now()}`,
        name: profile.name?.trim() || '迁移项目',
        projectPath: profile.projectPath ?? '',
        buildCommand: profile.buildCommand ?? 'npm run build',
        buildOutputDir: profile.buildOutputDir ?? 'dist',
        artifactOutputDir: profile.artifactOutputDir ?? '',
        gitBranch: profile.gitBranch ?? 'main',
        receiverBaseUrl: profile.receiverBaseUrl ?? 'http://127.0.0.1:17777',
        receiverToken: profile.receiverToken ?? 'change-me',
        pagesProjectName: profile.projectName ?? '',
        deployBranch: profile.deployBranch ?? 'main',
      },
    ];
  }

  return [createDefaultProject()];
};

export class ConfigStore {
  private readonly filePath: string;

  constructor() {
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
    const senderProjects = Array.isArray(parsed.senderProjects) ? parsed.senderProjects : undefined;
    const receiver = isRecord(parsed.receiver) ? parsed.receiver : {};

    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      mode: normalizeMode(parsed.mode),
      senderProjects: normalizeProjects(senderProjects, parsed),
      receiver: {
        ...DEFAULT_CONFIG.receiver,
        ...receiver,
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
