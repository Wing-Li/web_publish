import fs from 'node:fs';
import path from 'node:path';
import type { SenderProject } from '../shared/types';
import { currentGitBranch } from '../shared/run-command';

export const artifactDirectory = (project: SenderProject): string =>
  path.resolve(project.projectPath, project.artifactOutputDir.trim() || '.web-publisher-artifacts');

export const formatDateTimeForFileName = (date: Date): string => {
  const pad2 = (value: number): string => String(value).padStart(2, '0');
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${mm}${dd}_${hh}${mi}${ss}`;
};

export const sourceVersionTime = (date: Date): string => date.getFullYear() + formatDateTimeForFileName(date);

export const validateProjectBeforePack = async (
  project: SenderProject,
  log: (msg: string) => void,
): Promise<void> => {
  if (!project.projectPath) throw new Error('项目路径不能为空');
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

  if (project.kind === 'source' && !project.gitBranch) return;
  log('▶ 检查 Git 分支…');
  const currentBranch = await currentGitBranch(project.projectPath);
  log(`  当前分支: ${currentBranch}`);

  if (project.gitBranch && currentBranch !== project.gitBranch) {
    throw new Error(
      `项目 ${project.name} 当前分支为 ${currentBranch}，与配置 ${project.gitBranch} 不一致。`,
    );
  }
};
