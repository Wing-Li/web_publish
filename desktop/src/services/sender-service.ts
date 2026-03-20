import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  BatchBuildAndDeployResult,
  BatchBuildLocalResult,
  BuildAndDeployResult,
  BuildLocalResult,
  SenderProject,
} from '../shared/types';
import { runCommand } from '../shared/run-command';

type LogFn = (msg: string) => void;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const noop: LogFn = (_msg: string) => { /* default no-op */ };
const COMMON_PATH_ENTRIES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];
let cachedShellPath = '';
let cachedInteractiveShellPath = '';

const mergePath = (...paths: Array<string | undefined>): string => {
  const seen = new Set<string>();
  const merged: string[] = [];
  paths
    .filter(Boolean)
    .flatMap((value) => (value as string).split(':'))
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((entry) => {
      if (seen.has(entry)) return;
      seen.add(entry);
      merged.push(entry);
    });
  return merged.join(':');
};

const getLoginShellPath = async (cwd: string): Promise<string> => {
  if (cachedShellPath) return cachedShellPath;
  const shell = process.env.SHELL || '/bin/zsh';
  const pathResult = await runCommand(
    shell,
    ['-lc', 'printf %s "$PATH"'],
    cwd,
  );
  if (pathResult.code === 0) {
    cachedShellPath = pathResult.output.trim();
  }
  return cachedShellPath;
};

const getInteractiveShellPath = async (cwd: string): Promise<string> => {
  if (cachedInteractiveShellPath) return cachedInteractiveShellPath;
  const shell = process.env.SHELL || '/bin/zsh';
  const pathResult = await runCommand(
    shell,
    ['-lic', 'printf %s "$PATH"'],
    cwd,
  );
  if (pathResult.code === 0) {
    cachedInteractiveShellPath = pathResult.output.trim();
  }
  return cachedInteractiveShellPath;
};

const getBuildEnv = async (cwd: string): Promise<NodeJS.ProcessEnv> => {
  const shellPath = await getLoginShellPath(cwd);
  const interactiveShellPath = await getInteractiveShellPath(cwd);
  const pathValue = mergePath(
    interactiveShellPath,
    shellPath,
    process.env.PATH,
    COMMON_PATH_ENTRIES.join(':'),
  );
  return { ...process.env, PATH: pathValue };
};

const sha256File = (filePath: string): string => {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
};

const ensure = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const ensureDir = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const formatDateTimeForFileName = (date: Date): string => {
  const pad2 = (value: number): string => String(value).padStart(2, '0');
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${mm}${dd}_${hh}${mi}${ss}`;
};

const validateProjectBeforeBuild = async (
  project: SenderProject,
  log: LogFn,
): Promise<void> => {
  ensure(Boolean(project.projectPath), '项目路径不能为空');
  if (process.platform === 'darwin') {
    try {
      fs.accessSync(project.projectPath, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      throw new Error(
        `[MAC_PERMISSION_REQUIRED] 无法访问项目目录: ${project.projectPath}\n` +
        'macOS 可能尚未授予此应用访问“文稿/桌面/下载”等目录的权限。',
      );
    }
  }

  log('▶ 检查 Git 分支…');
  const gitCheck = await runCommand(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    project.projectPath,
  );

  if (gitCheck.code !== 0) {
    throw new Error(`无法读取 Git 分支，请确认目录是 Git 仓库:\n${gitCheck.output}`);
  }

  const currentBranch = gitCheck.output.trim();
  log(`  当前分支: ${currentBranch}`);

  if (project.gitBranch && currentBranch !== project.gitBranch) {
    throw new Error(
      `项目 ${project.name} 当前分支为 ${currentBranch}，与配置 ${project.gitBranch} 不一致。`,
    );
  }
};

const buildProjectArtifact = async (
  project: SenderProject,
  log: LogFn,
): Promise<{ zipPath: string }> => {
  await validateProjectBeforeBuild(project, log);

  log(`▶ 执行构建命令: ${project.buildCommand}`);
  const buildEnv = await getBuildEnv(project.projectPath);

  // 用 env -u 在命令层做环境隔离，避免 Electron/IDE 注入变量污染构建
  const sanitizedBuild = await runCommand(
    'env',
    [
      '-u', 'NODE_ENV',
      '-u', 'NODE_OPTIONS',
      '-u', 'VSCODE_INSPECTOR_OPTIONS',
      '-u', 'NODE_INSPECT_RESUME_ON_START',
      '-u', 'ELECTRON_RUN_AS_NODE',
      '-u', 'ELECTRON_NO_ATTACH_CONSOLE',
      '-u', 'ELECTRON_ENABLE_LOGGING',
      '-u', 'ELECTRON_ENABLE_STACK_DUMPING',
      '-u', 'ELECTRON_CRASH_REPORTER_LOGGER',
      'sh',
      '-lc',
      project.buildCommand,
    ],
    project.projectPath,
    buildEnv,
    (chunk) => log(chunk),
  );

  if (sanitizedBuild.code !== 0) {
    if (
      /command not found|No such file or directory/i.test(sanitizedBuild.output) &&
      /(npm|pnpm|yarn|node)/i.test(sanitizedBuild.output)
    ) {
      throw new Error(
        `构建失败：未找到 Node.js 或包管理器命令。\n` +
        `请确认已安装 Node.js，并且在终端执行 node/npm/pnpm 可用。\n` +
        `原始输出:\n${sanitizedBuild.output}`,
      );
    }
    throw new Error(`构建失败 (exit ${sanitizedBuild.code})`);
  }
  log('✓ 构建完成');

  const outputDir = path.resolve(project.projectPath, project.buildOutputDir);
  ensure(
    fs.existsSync(outputDir),
    `构建输出目录不存在: ${outputDir}\n请检查 buildOutputDir 配置`,
  );
  ensure(
    fs.readdirSync(outputDir).length > 0,
    `构建输出目录为空: ${outputDir}`,
  );

  // 支持自定义压缩包输出目录；未配置时回退到项目目录下默认路径
  const customArtifactDir = project.artifactOutputDir?.trim();
  const artifactDir = customArtifactDir
    ? (path.isAbsolute(customArtifactDir)
      ? customArtifactDir
      : path.resolve(project.projectPath, customArtifactDir))
    : path.resolve(project.projectPath, '.web-publisher-artifacts');
  ensureDir(artifactDir);
  const normalizedProjectName = (project.name || project.id).trim().replace(/\s+/g, '_');
  const zipName = `${normalizedProjectName}_${formatDateTimeForFileName(new Date())}.zip`;
  const zipPath = path.join(artifactDir, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  log(`▶ 压缩输出目录 → ${zipPath}`);
  const zipResult = await runCommand(
    'zip',
    ['-r', zipPath, '.'],
    outputDir,
    undefined,
    (chunk) => log(chunk),
  );
  if (zipResult.code !== 0) {
    throw new Error(`压缩失败 (exit ${zipResult.code}):\n${zipResult.output}`);
  }

  const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
  log(`✓ 压缩完成，大小: ${sizeMB} MB`);

  log(`▶ 压缩产物: ${zipPath}`);
  return { zipPath };
};

export const runBuildProjectOnly = async (
  project: SenderProject,
  log: LogFn = noop,
): Promise<BuildLocalResult> => {
  const { zipPath } = await buildProjectArtifact(project, log);
  return { projectId: project.id, artifactPath: zipPath };
};

export const runBuildAndDeployProject = async (
  project: SenderProject,
  log: LogFn = noop,
): Promise<BuildAndDeployResult> => {
  ensure(Boolean(project.pagesProjectName), 'Cloudflare Pages 项目名不能为空');
  ensure(Boolean(project.receiverBaseUrl), '接收端地址不能为空');
  ensure(Boolean(project.receiverToken), '接收端 Token 不能为空');

  const { zipPath } = await buildProjectArtifact(project, log);

  const sha = sha256File(zipPath);
  const metadata = {
    projectName: project.pagesProjectName,
    branch: project.deployBranch,
  };
  const metadataBase64 = Buffer.from(JSON.stringify(metadata), 'utf-8').toString('base64');
  const body = fs.readFileSync(zipPath);

  log(`▶ 上传到接收端 ${project.receiverBaseUrl} …`);
  const response = await fetch(`${project.receiverBaseUrl}/api/v1/deployments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${project.receiverToken}`,
      'Content-Type': 'application/octet-stream',
      'X-Checksum-SHA256': sha,
      'X-Metadata-Base64': metadataBase64,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`上传失败 (HTTP ${response.status}): ${text}`);
  }

  const result = (await response.json()) as { deploymentId: string };
  log(`✓ 上传完成，deploymentId: ${result.deploymentId}`);
  return { projectId: project.id, deploymentId: result.deploymentId };
};

export const runBuildAllProjectsOnly = async (
  projects: SenderProject[],
  log: LogFn = noop,
): Promise<BatchBuildLocalResult> => {
  const succeeded: BuildLocalResult[] = [];
  const failed: BatchBuildLocalResult['failed'] = [];

  for (const project of projects) {
    log(`\n━━ ${project.name} ━━`);
    try {
      succeeded.push(await runBuildProjectOnly(project, log));
    } catch (error) {
      failed.push({
        projectId: project.id,
        projectName: project.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { succeeded, failed };
};

export const runBuildAndDeployAllProjects = async (
  projects: SenderProject[],
  log: LogFn = noop,
): Promise<BatchBuildAndDeployResult> => {
  const submitted: BuildAndDeployResult[] = [];
  const failed: BatchBuildAndDeployResult['failed'] = [];

  for (const project of projects) {
    log(`\n━━ ${project.name} ━━`);
    try {
      submitted.push(await runBuildAndDeployProject(project, log));
    } catch (error) {
      failed.push({
        projectId: project.id,
        projectName: project.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { submitted, failed };
};
