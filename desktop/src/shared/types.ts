export type AppMode = 'sender' | 'receiver' | 'both';

export interface SenderProject {
  id: string;
  name: string;
  projectPath: string;
  buildCommand: string;
  buildOutputDir: string;
  artifactOutputDir: string;
  gitBranch: string;
  receiverBaseUrl: string;
  receiverToken: string;
  pagesProjectName: string;
  deployBranch: string;
}

export interface ReceiverConfig {
  host: string;
  port: number;
  authToken: string;
  maxUploadMb: number;
  workRootName: string;
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  wranglerBin: string;
}

export interface AppConfig {
  mode: AppMode;
  senderProjects: SenderProject[];
  receiver: ReceiverConfig;
}

export type DeploymentStatus = 'queued' | 'running' | 'success' | 'failed';

export interface DeploymentTask {
  id: string;
  status: DeploymentStatus;
  projectName: string;
  branch: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  url?: string;
  error?: string;
  logs?: string;
}

export interface ReceiverRuntimeStatus {
  running: boolean;
  host: string;
  port: number;
}

export interface BuildAndDeployResult {
  projectId: string;
  deploymentId: string;
}

export interface BuildLocalResult {
  projectId: string;
  artifactPath: string;
}

export interface BatchBuildAndDeployResult {
  submitted: BuildAndDeployResult[];
  failed: Array<{
    projectId: string;
    projectName: string;
    error: string;
  }>;
}

export interface BatchBuildLocalResult {
  succeeded: BuildLocalResult[];
  failed: Array<{
    projectId: string;
    projectName: string;
    error: string;
  }>;
}

/** 单项目部署的客户端进度步骤 */
export type DeployStepId = 'ready' | 'build' | 'zip' | 'upload' | 'deploy' | 'done';

export interface DeployStepState {
  id: DeployStepId;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

/** 部署步骤状态（供 UI 组件与渲染层复用） */
export type StepStatus = DeployStepState['status'];
