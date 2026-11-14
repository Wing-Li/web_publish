import { contextBridge, ipcRenderer } from 'electron';
import {
  AppConfig,
  BuildAndDeployResult,
  BuildLocalResult,
  DeploymentTask,
  ReceiverRuntimeStatus,
  SourceProject,
  SourceReceipt,
  SourceTarget,
} from './shared/types';

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('app:get-config'),
  updateConfig: (config: AppConfig): Promise<AppConfig> =>
    ipcRenderer.invoke('app:update-config', config),
  getConfigPath: (): Promise<string> => ipcRenderer.invoke('app:get-config-path'),
  exportConfig: (
    config: AppConfig,
  ): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('app:export-config', config),
  importConfig: (): Promise<{ canceled: boolean; filePath?: string; config?: AppConfig }> =>
    ipcRenderer.invoke('app:import-config'),
  pickDirectory: (initialPath?: string): Promise<string> =>
    ipcRenderer.invoke('app:pick-directory', initialPath),
  listGitBranches: (
    projectPath: string,
  ): Promise<{ branches: string[]; current: string }> =>
    ipcRenderer.invoke('app:list-git-branches', projectPath),
  switchBranchAndPull: (
    projectId: string,
  ): Promise<{ currentBranch: string }> =>
    ipcRenderer.invoke('sender:switch-branch-and-pull', projectId),

  startReceiver: (): Promise<ReceiverRuntimeStatus> =>
    ipcRenderer.invoke('receiver:start'),
  stopReceiver: (): Promise<ReceiverRuntimeStatus> =>
    ipcRenderer.invoke('receiver:stop'),
  getReceiverStatus: (): Promise<ReceiverRuntimeStatus> =>
    ipcRenderer.invoke('receiver:status'),
  getDeployment: (id: string): Promise<DeploymentTask | null> =>
    ipcRenderer.invoke('receiver:get-deployment', id),
  getRemoteDeployment: (
    receiverBaseUrl: string,
    receiverToken: string,
    id: string,
  ): Promise<DeploymentTask | null> =>
    ipcRenderer.invoke('sender:get-remote-deployment', receiverBaseUrl, receiverToken, id),
  getAllDeployments: (): Promise<DeploymentTask[]> =>
    ipcRenderer.invoke('receiver:get-all-deployments'),

  getSourceTargets: (project: SourceProject): Promise<SourceTarget[]> =>
    ipcRenderer.invoke('source:get-targets', project),
  getSourceInfo: (projectId: string, projectPath: string): Promise<{ pending: boolean; hasRootIgnore: boolean }> =>
    ipcRenderer.invoke('source:get-info', projectId, projectPath),
  sendSource: (projectId: string, retry: boolean): Promise<{ finalPath: string }> =>
    ipcRenderer.invoke('source:send', projectId, retry),
  getSourceReceipts: (): Promise<SourceReceipt[]> => ipcRenderer.invoke('source:get-receipts'),
  openSourceReceipt: (id: string): Promise<void> => ipcRenderer.invoke('source:open-receipt', id),
  onSourceLog: (callback: (data: { projectId: string; msg: string }) => void): void => {
    ipcRenderer.on('source:log', (_, data: { projectId: string; msg: string }) => callback(data));
  },
  offSourceLog: (): void => { ipcRenderer.removeAllListeners('source:log'); },

  onSenderLog: (callback: (data: { projectId: string; msg: string }) => void): void => {
    ipcRenderer.on('sender:log', (_, data: { projectId: string; msg: string }) => callback(data));
  },
  offSenderLog: (): void => {
    ipcRenderer.removeAllListeners('sender:log');
  },

  openFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke('app:open-folder', folderPath),
  requestMacOsFolderPermissionHelp: (folderPath?: string): Promise<boolean> =>
    ipcRenderer.invoke('app:request-macos-folder-permission-help', folderPath),

  buildAndDeployOne: (projectId: string): Promise<BuildAndDeployResult> =>
    ipcRenderer.invoke('sender:build-deploy-one', projectId),
  buildLocalOne: (projectId: string): Promise<BuildLocalResult> =>
    ipcRenderer.invoke('sender:build-local-one', projectId),
};

contextBridge.exposeInMainWorld('desktopApi', api);

export type DesktopApi = typeof api;
