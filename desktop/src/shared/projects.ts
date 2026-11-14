import type { DeployProject, SenderProject, SourceProject } from './types';

export const isDeployProject = (project: SenderProject): project is DeployProject => project.kind === 'deploy';
export const isSourceProject = (project: SenderProject): project is SourceProject => project.kind === 'source';

export function createProject(kind: SenderProject['kind'], id: string): SenderProject {
  const common = { id, projectPath: '', receiverBaseUrl: 'http://127.0.0.1:17777', receiverToken: 'change-me' };
  if (kind === 'source') return { ...common, kind, name: '新源码项目', sourceTargetId: '' };
  return { ...common, kind, name: '新部署项目', buildCommand: 'npm run build', buildOutputDir: 'dist',
    artifactOutputDir: '', gitBranch: 'main', pagesProjectName: '', deployBranch: 'main' };
}

type SavedProject = Partial<Omit<DeployProject, 'kind'>> & {
  sourceTargetId?: string;
  kind?: SenderProject['kind'];
  sourceOnly?: boolean;
};

/** 仅旧版混用项目可能产生两份配置。原 ID 留给源码任务，以便继续已缓存的快照。 */
export function normalizeProjects(rows: SavedProject[], hasPending: (id: string) => boolean): SenderProject[] {
  const occupied = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || (row.kind !== undefined && row.kind !== 'source' && row.kind !== 'deploy')) {
      throw new Error('项目配置或类型无效');
    }
    const fields = ['id', 'name', 'projectPath', 'receiverBaseUrl', 'receiverToken', 'sourceTargetId',
      'buildCommand', 'buildOutputDir', 'artifactOutputDir', 'gitBranch', 'pagesProjectName', 'deployBranch'] as const;
    if (fields.some(key => row[key] !== undefined && typeof row[key] !== 'string')) throw new Error('项目配置字段无效');
    const id = row.id?.trim();
    if (id && occupied.has(id)) throw new Error('项目 ID 重复');
    if (id) occupied.add(id);
  }
  return rows.flatMap((row, index): SenderProject[] => {
    const id = row.id?.trim() || crypto.randomUUID();
    const common = { id, name: row.name?.trim() || `项目 ${index + 1}`, projectPath: row.projectPath ?? '',
      receiverBaseUrl: row.receiverBaseUrl ?? 'http://127.0.0.1:17777', receiverToken: row.receiverToken ?? 'change-me' };
    const source: SourceProject = { ...common, kind: 'source', sourceTargetId: row.sourceTargetId ?? '' };
    if (row.kind === 'source' || (!row.kind && row.sourceOnly === true)) return [source];

    const deploy: DeployProject = { ...common, kind: 'deploy',
      buildCommand: row.buildCommand ?? 'npm run build', buildOutputDir: row.buildOutputDir ?? 'dist',
      artifactOutputDir: row.artifactOutputDir ?? '', gitBranch: row.gitBranch ?? 'main',
      pagesProjectName: row.pagesProjectName ?? '', deployBranch: row.deployBranch ?? 'main' };
    if (row.kind === 'deploy' || (!source.sourceTargetId && !hasPending(id))) return [deploy];

    let deployId = id + '-deploy';
    while (occupied.has(deployId)) deployId += '-deploy';
    occupied.add(deployId);
    return [{ ...deploy, id: deployId }, source];
  });
}
