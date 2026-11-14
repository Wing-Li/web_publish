import { rootIgnoreMatcher } from '../src/services/source-pack/gitignore';
import { normalizeProjects } from '../src/shared/projects';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReceiverServer } from '../src/services/receiver-server';
import { extractSourceZip } from '../src/services/source-extract';
import { SourceSender } from '../src/services/source-sender';
import { ReceiverConfig, SourceProject } from '../src/shared/types';

async function availablePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  return port;
}

test('Finder 根规则保留目录遍历、按顺序取消忽略和转义文件名的语义', () => {
  const ignored = rootIgnoreMatcher([
    'dist/', '!dist/keep.txt', '/root.*', '**/private/**', 'x[!0-9]?.log', 'a/**/z.txt',
    '\\#notes', '\\!build', '临时?.js', 'name\\ ',
  ].join('\n'));
  for (const file of ['dist/bin', 'root.js', 'a/private/f', 'xy0.log', 'a/z.txt', 'a/b/z.txt',
    '#notes', '!build', '临时甲.js', 'name ']) assert.equal(ignored(file), true, file);
  for (const file of ['dist', 'dist/keep.txt', 'nested/root.js', 'x00.log', 'a/z.log',
    'name', 'README.md']) assert.equal(ignored(file), false, file);
});

test('旧配置按用途迁移，重试任务保留原 ID，重新加载后类型稳定', () => {
  const rows = [
    { id: 'only-deploy', buildCommand: 'custom build' },
    { id: 'only-source', sourceOnly: true },
    { id: 'both', sourceTargetId: 'inbox', receiverToken: 'fixture', gitBranch: 'release', artifactOutputDir: 'zips' },
    { id: 'interrupted' },
    { id: 'both-deploy' },
  ];
  const migrated = normalizeProjects(rows, id => id === 'interrupted');
  assert.deepEqual(migrated.map(p => [p.id, p.kind]), [
    ['only-deploy', 'deploy'], ['only-source', 'source'],
    ['both-deploy-deploy', 'deploy'], ['both', 'source'],
    ['interrupted-deploy', 'deploy'], ['interrupted', 'source'], ['both-deploy', 'deploy'],
  ]);
  assert.equal(migrated.some(p => p.kind === 'source' && 'buildCommand' in p), false);
  assert.equal(migrated.some(p => p.kind === 'deploy' && 'sourceTargetId' in p), false);
  assert.deepEqual(migrated.filter(p => ['both-deploy-deploy', 'both'].includes(p.id))
    .map(p => [p.gitBranch, p.artifactOutputDir]), [['release', 'zips'], ['release', 'zips']]);
  assert.deepEqual(normalizeProjects(migrated, () => true), migrated);
  assert.deepEqual(normalizeProjects([], () => true), []);
});

test('源码本地打包使用所选分支和 ZIP 输出目录，普通目录以及项目根目录输出均可用', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-local-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'repo');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'hello.txt'), '未提交的源码');
  const project: SourceProject = {
    id: 'local', name: '本地示例', projectPath: workspace, kind: 'source', gitBranch: '',
    artifactOutputDir: '', receiverBaseUrl: '', receiverToken: '', sourceTargetId: '',
  };
  const sender = new SourceSender(path.join(root, 'cache'));
  const log = (): void => { /* 离线打包 */ };
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 14, 9, 5, 7) });
  const expectedStem = '本地示例_source_20261114_090507';
  const defaultZip = await sender.packLocal(project, log);
  assert.equal(path.dirname(defaultZip), path.join(workspace, '.web-publisher-artifacts'));
  assert.equal(path.basename(defaultZip), expectedStem + '.zip');
  execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
  await assert.rejects(sender.packLocal({ ...project, gitBranch: 'release' }, log), /当前分支为 main，与配置 release 不一致/);
  project.gitBranch = 'main';
  project.artifactOutputDir = 'packages';
  const selectedZip = await sender.packLocal(project, log);
  assert.equal(path.dirname(selectedZip), path.join(workspace, 'packages'));
  project.artifactOutputDir = workspace;
  const existingZip = path.join(workspace, expectedStem + '.zip');
  await fs.writeFile(existingZip, '同一秒生成的已有包');
  await fs.writeFile(path.join(workspace, '本地示例_source_1114_090507_12345678-1234-4234-8234-123456789abc.zip'), '旧包');
  const concurrent = await Promise.all([sender.packLocal(project, log), sender.packLocal(project, log)]);
  assert.deepEqual(concurrent.map(file => path.basename(file)).sort(), [expectedStem + '-2.zip', expectedStem + '-3.zip']);
  assert.equal(await fs.readFile(existingZip, 'utf8'), '同一秒生成的已有包');
  const rootZip = concurrent[0];
  const extracted = path.join(root, 'extracted');
  await fs.mkdir(extracted);
  await extractSourceZip(rootZip, extracted, 1024);
  assert.deepEqual(await fs.readdir(extracted), ['hello.txt']);
  assert.equal(await fs.readFile(path.join(extracted, 'hello.txt'), 'utf8'), '未提交的源码');
  assert.equal(sender.getPending(project.id), false);
});

test('源码发送中断后跨重启续传原快照；主动再次发送产生独立版本', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-delivery-'));
  const workspace = path.join(root, 'workspace');
  const destination = path.join(root, 'versions');
  const state = path.join(root, 'sender');
  const config: ReceiverConfig = {
    host: '127.0.0.1', port: await availablePort(), authToken: 'local-test',
    maxUploadMb: 32, workRootName: path.relative(os.homedir(), path.join(root, 'jobs')),
    cloudflareAccountId: '', cloudflareApiToken: '', wranglerBin: '',
    sourceTargets: [{ id: 'inbox', name: '源码', path: destination }],
  };
  const project: SourceProject = {
    id: 'app', name: '示例项目', projectPath: workspace, sourceTargetId: 'inbox',
    receiverBaseUrl: `http://${config.host}:${config.port}`, receiverToken: config.authToken,
    kind: 'source', gitBranch: 'main', artifactOutputDir: 'archives',
  };
  const realFetch = globalThis.fetch;
  let receiver = new ReceiverServer(() => config);
  let sender = new SourceSender(state);
  t.after(async () => {
    globalThis.fetch = realFetch;
    try { await receiver.stop(); } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
  await fs.mkdir(destination);
  await fs.writeFile(path.join(workspace, '.gitignore'), '*.local\n');
  await fs.writeFile(path.join(workspace, 'dev.local'), 'excluded');
  await fs.writeFile(path.join(workspace, 'src', '.gitignore'), 'main.txt\n');
  await fs.writeFile(path.join(workspace, 'src', 'main.txt'), '第一次发送');
  await fs.writeFile(path.join(workspace, 'assets.bin'), randomBytes(10 * 1024 * 1024));

  await receiver.start();
  assert.deepEqual(await sender.getTargets(project), config.sourceTargets);
  await assert.rejects(sender.getTargets({ ...project, receiverToken: 'incorrect' }), /401/);
  const putIndexes: number[] = [];
  const taskIds = new Set<string>();
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 14, 14, 25, 47) });
  let interrupt = true;
  globalThis.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    const match = String(url).match(/\/source\/tasks\/([^/]+)\/chunks\/(\d+)$/);
    if (match && options?.method === 'PUT' && response.ok) {
      taskIds.add(match[1]);
      putIndexes.push(Number(match[2]));
      if (interrupt) {
        interrupt = false;
        await response.arrayBuffer();
        throw new Error('模拟已接收第一个分片但回执丢失');
      }
    }
    return response;
  };
  const log = (): void => { /* 仅验证最终产物和实际传输。 */ };
  await assert.rejects(sender.send({ ...project, gitBranch: 'other' }, false, log), /与配置 other 不一致/);
  assert.equal(sender.getPending(project.id), false);
  await assert.rejects(sender.send(project, false, log), /回执丢失/);
  assert.equal(sender.getPending(project.id), true);
  assert.equal((await receiver.getSourceReceipts()).length, 0);
  await receiver.stop();
  receiver = new ReceiverServer(() => config);
  sender = new SourceSender(state);
  await receiver.start();
  await fs.writeFile(path.join(workspace, 'src', 'main.txt'), '第二次发送');
  const outputs = path.join(workspace, project.artifactOutputDir);
  const [originalZip] = await fs.readdir(outputs);
  assert.equal(originalZip, '示例项目_source_20261114_142547.zip');
  await fs.unlink(path.join(outputs, originalZip));
  const changedOutput = path.join(root, 'after-retry');
  t.mock.timers.setTime(new Date(2026, 10, 14, 15, 30, 55).getTime());
  const first = await sender.send({ ...project, gitBranch: 'other', artifactOutputDir: changedOutput }, true, log);
  assert.equal(path.basename(first.finalPath), '20261114_142547');
  await assert.rejects(fs.stat(changedOutput), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(outputs), []);
  assert.deepEqual(putIndexes, [0, 1]);
  assert.equal(taskIds.size, 1);
  assert.equal(sender.getPending(project.id), false);
  const originalFile = path.join(first.finalPath, 'src', 'main.txt');
  assert.equal(await fs.readFile(originalFile, 'utf8'), '第一次发送');
  assert.deepEqual((await fs.readdir(first.finalPath)).sort(), ['.gitignore', 'assets.bin', 'src']);
  globalThis.fetch = realFetch;
  // Another sender can submit the same time even though the original local ZIP was removed.
  t.mock.timers.setTime(new Date(2026, 10, 14, 14, 25, 47).getTime());
  const second = await sender.send(project, false, log);
  assert.equal((await fs.readdir(outputs)).length, 1);
  assert.equal(path.basename(second.finalPath), '20261114_142547-2');
  assert.equal(await fs.readFile(path.join(second.finalPath, 'src', 'main.txt'), 'utf8'), '第二次发送');
  assert.equal(await fs.readFile(originalFile, 'utf8'), '第一次发送');
  const canonicalTarget = await fs.realpath(destination);
  assert.equal(await fs.realpath(path.dirname(path.dirname(first.finalPath))), canonicalTarget);
  assert.equal((await fs.readdir(path.dirname(first.finalPath))).filter(n => !n.startsWith('.')).length, 2);
  assert.equal(receiver.getAllTasks().length, 0);
  await receiver.stop();
  receiver = new ReceiverServer(() => config);
  assert.deepEqual((await receiver.getSourceReceipts()).map(r => r.finalPath).sort(), [first.finalPath, second.finalPath].sort());
});
