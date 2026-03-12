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

const deleteIndexTxtFiles = (rootDir: string): number => {
  let removed = 0;
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'index.txt') {
        fs.unlinkSync(fullPath);
        removed += 1;
      }
    }
  }

  return removed;
};

const validateProjectBeforeBuild = async (
  project: SenderProject,
  log: LogFn,
): Promise<void> => {
  ensure(Boolean(project.projectPath), '项目路径不能为空');

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
    process.env,
    (chunk) => log(chunk),
  );

  if (sanitizedBuild.code !== 0) {
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

  // Next.js + Cloudflare 场景：先清理 index.txt，避免静置后命中 txt 页面
  const removedIndexTxtCount = deleteIndexTxtFiles(outputDir);
  if (removedIndexTxtCount > 0) {
    log(`✓ 已清理 index.txt 文件 ${removedIndexTxtCount} 个`);
  } else {
    log('ℹ 未发现 index.txt 文件，无需清理');
  }

  // 打包产物固定放回目标项目目录，方便定位与排查
  const artifactDir = path.resolve(project.projectPath, '.web-publisher-artifacts');
  ensureDir(artifactDir);
  const zipName = `artifact_${project.id}_${Date.now()}.zip`;
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
