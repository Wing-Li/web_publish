import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { ConfigStore } from './services/config-store';
import { ReceiverServer } from './services/receiver-server';
import {
  runBuildAllProjectsOnly,
  runBuildAndDeployAllProjects,
  runBuildAndDeployProject,
  runBuildProjectOnly,
} from './services/sender-service';
import { runCommand, runCommandStrict } from './shared/run-command';
import { AppConfig } from './shared/types';

if (started) {
  app.quit();
}

app.setName('便捷打包工具');

const configStore = new ConfigStore();
let config: AppConfig;
let receiverServer: ReceiverServer;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

const registerIpcHandlers = (): void => {
  ipcMain.handle('app:get-config', () => config);

  ipcMain.handle('app:update-config', (_, nextConfig: AppConfig) => {
    config = nextConfig;
    configStore.save(config);
    return config;
  });

  ipcMain.handle('app:get-config-path', () => configStore.getPath());

  ipcMain.handle('app:pick-directory', async (_, initialPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory'],
      defaultPath: initialPath || undefined,
    });

    if (result.canceled || result.filePaths.length === 0) {
      return '';
    }
    return result.filePaths[0];
  });

  ipcMain.handle('app:open-folder', (_, folderPath: string) => {
    shell.openPath(folderPath);
  });

  ipcMain.handle('app:request-macos-folder-permission-help', async (_, folderPath?: string) => {
    if (process.platform !== 'darwin') return false;
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['打开系统设置', '稍后处理'],
      defaultId: 0,
      cancelId: 1,
      title: '需要文件夹访问权限',
      message: '当前目录访问被 macOS 拒绝，无法继续构建。',
      detail: `请在“系统设置 -> 隐私与安全性 -> 文件与文件夹”中，允许“便捷打包工具”访问目标目录。\n${folderPath ? `目录：${folderPath}` : ''}`,
      noLink: true,
    });
    if (result.response === 0) {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
      return true;
    }
    return false;
  });

  ipcMain.handle('app:list-git-branches', async (_, projectPath: string) => {
    if (!projectPath) {
      return { branches: [], current: '' };
    }

    const branchResult = await runCommand(
      'git',
      ['branch', '--format=%(refname:short)'],
      projectPath,
    );
    if (branchResult.code !== 0) {
      throw new Error(`读取 Git 分支失败: ${branchResult.output}`);
    }

    const currentResult = await runCommand(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      projectPath,
    );
    if (currentResult.code !== 0) {
      throw new Error(`读取当前分支失败: ${currentResult.output}`);
    }

    const branches = branchResult.output
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);

    const current = currentResult.output.trim();
    return { branches, current };
  });

  ipcMain.handle(
    'sender:switch-branch-and-pull',
    async (_, projectId: string): Promise<{ currentBranch: string }> => {
      const project = config.senderProjects.find((item) => item.id === projectId);
      if (!project) throw new Error(`未找到项目: ${projectId}`);
      if (!project.projectPath) throw new Error('项目路径为空，无法切换分支。');
      if (!project.gitBranch) throw new Error('未配置目标分支，无法切换分支。');

      await runCommandStrict(
        'git',
        ['fetch', '--all', '--prune'],
        project.projectPath,
        '拉取远端分支失败',
      );

      const checkoutTarget = project.gitBranch;
      const checkoutResult = await runCommand(
        'git',
        ['checkout', checkoutTarget],
        project.projectPath,
      );

      if (checkoutResult.code !== 0) {
        await runCommandStrict(
          'git',
          ['checkout', '-b', checkoutTarget, `origin/${checkoutTarget}`],
          project.projectPath,
          '切换分支失败',
        );
      }

      await runCommandStrict(
        'git',
        ['pull', '--ff-only'],
        project.projectPath,
        '拉取最新代码失败',
      );

      const currentBranch = await runCommandStrict(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        project.projectPath,
        '读取当前分支失败',
      );

      return { currentBranch };
    },
  );

  ipcMain.handle('receiver:start', async () => {
    await receiverServer.start();
    return receiverServer.getStatus();
  });

  ipcMain.handle('receiver:stop', async () => {
    await receiverServer.stop();
    return receiverServer.getStatus();
  });

  ipcMain.handle('receiver:status', () => receiverServer.getStatus());

  ipcMain.handle('receiver:get-deployment', (_, id: string) => {
    return receiverServer.getTask(id) ?? null;
  });

  ipcMain.handle('receiver:get-all-deployments', () => {
    return receiverServer.getAllTasks();
  });

  ipcMain.handle('sender:build-deploy-one', async (event, projectId: string) => {
    const project = config.senderProjects.find((item) => item.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const log = (msg: string): void => {
      try { event.sender.send('sender:log', { projectId, msg }); } catch { /* window closed */ }
    };
    return runBuildAndDeployProject(project, log);
  });

  ipcMain.handle('sender:build-deploy-all', async (event) => {
    const log = (msg: string): void => {
      try { event.sender.send('sender:log', { projectId: '__all__', msg }); } catch { /* window closed */ }
    };
    return runBuildAndDeployAllProjects(config.senderProjects, log);
  });

  ipcMain.handle('sender:build-local-one', async (event, projectId: string) => {
    const project = config.senderProjects.find((item) => item.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const log = (msg: string): void => {
      try { event.sender.send('sender:log', { projectId, msg }); } catch { /* window closed */ }
    };
    return runBuildProjectOnly(project, log);
  });

  ipcMain.handle('sender:build-local-all', async (event) => {
    const log = (msg: string): void => {
      try { event.sender.send('sender:log', { projectId: '__all__', msg }); } catch { /* window closed */ }
    };
    return runBuildAllProjectsOnly(config.senderProjects, log);
  });
};

app.on('ready', async () => {
  config = configStore.load();
  receiverServer = new ReceiverServer(() => config.receiver);

  registerIpcHandlers();

  if (config.mode === 'receiver' || config.mode === 'both') {
    await receiverServer.start();
  }

  createWindow();
});

app.on('window-all-closed', async () => {
  if (receiverServer) {
    await receiverServer.stop();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
