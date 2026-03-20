import { contextBridge, ipcRenderer } from 'electron';
import {
  AppConfig,
  BatchBuildAndDeployResult,
  BatchBuildLocalResult,
  BuildAndDeployResult,
  BuildLocalResult,
  DeploymentTask,
  ReceiverRuntimeStatus,
} from './shared/types';

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('app:get-config'),
  updateConfig: (config: AppConfig): Promise<AppConfig> =>
    ipcRenderer.invoke('app:update-config', config),
  getConfigPath: (): Promise<string> => ipcRenderer.invoke('app:get-config-path'),
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
  getAllDeployments: (): Promise<DeploymentTask[]> =>
    ipcRenderer.invoke('receiver:get-all-deployments'),

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
  buildAndDeployAll: (): Promise<BatchBuildAndDeployResult> =>
    ipcRenderer.invoke('sender:build-deploy-all'),
  buildLocalOne: (projectId: string): Promise<BuildLocalResult> =>
    ipcRenderer.invoke('sender:build-local-one', projectId),
  buildLocalAll: (): Promise<BatchBuildLocalResult> =>
    ipcRenderer.invoke('sender:build-local-all'),
};

contextBridge.exposeInMainWorld('desktopApi', api);

export type DesktopApi = typeof api;
