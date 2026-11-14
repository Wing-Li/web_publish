export type AppMode = 'sender' | 'receiver' | 'both';

interface ProjectConnection {
  id: string;
  name: string;
  projectPath: string;
  receiverBaseUrl: string;
  receiverToken: string;
}

export interface DeployProject extends ProjectConnection {
  kind: 'deploy';
  buildCommand: string;
  buildOutputDir: string;
  artifactOutputDir: string;
  gitBranch: string;
  pagesProjectName: string;
  deployBranch: string;
}

export interface SourceProject extends ProjectConnection {
  kind: 'source';
  sourceTargetId: string;
}

export type SenderProject = DeployProject | SourceProject;

/** 接收端为发送端公开的源码存放目录。 */
export interface SourceTarget {
  id: string;
  name: string;
  path: string;
}

export interface SourceInitRequest {
  targetId: string;
  projectName: string;
  fileSize: number;
  fileSha256: string;
  chunkSize: number;
  chunkCount: number;
}

export interface SourceTaskStatus {
  id: string;
  status: 'uploading' | 'extracting' | 'success' | 'failed';
  uploadedIndexes: number[];
  finalPath?: string;
  error?: string;
}

export interface SourceReceipt {
  id: string;
  projectName: string;
  targetName: string;
  finalPath: string;
  completedAt: string;
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
  sourceTargets: SourceTarget[];
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

export interface UploadInitRequest {
  uploadKey: string;
  projectName: string;
  branch: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  chunkSize: number;
  chunkCount: number;
}

export interface UploadInitResponse {
  uploadId: string;
}

export interface UploadStatusResponse {
  uploadId: string;
  chunkCount: number;
  uploadedIndexes: number[];
  completed: boolean;
}

export interface UploadCompleteResponse {
  deploymentId: string;
  status: 'queued';
}

export interface BuildLocalResult {
  projectId: string;
  artifactPath: string;
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
