import { rootIgnoreMatcher } from '../src/services/source-pack/gitignore';
import { normalizeProjects } from '../src/shared/projects';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ReceiverServer } from '../src/services/receiver-server';
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
    { id: 'both', sourceTargetId: 'inbox', receiverToken: 'fixture' },
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
  assert.deepEqual(normalizeProjects(migrated, () => true), migrated);
  assert.deepEqual(normalizeProjects([], () => true), []);
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
    kind: 'source',
  };
  const realFetch = globalThis.fetch;
  let receiver = new ReceiverServer(() => config);
  let sender = new SourceSender(state);
  t.after(async () => {
    globalThis.fetch = realFetch;
    try { await receiver.stop(); } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'));
  await fs.mkdir(destination);
  await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'test');
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
  await assert.rejects(sender.send(project, false, log), /回执丢失/);
  assert.equal(sender.getPending(project.id), true);
  assert.equal((await receiver.getSourceReceipts()).length, 0);
  await receiver.stop();
  receiver = new ReceiverServer(() => config);
  sender = new SourceSender(state);
  await receiver.start();
  await fs.writeFile(path.join(workspace, 'src', 'main.txt'), '第二次发送');
  const first = await sender.send(project, true, log);
  assert.deepEqual(putIndexes, [0, 1]);
  assert.equal(taskIds.size, 1);
  assert.equal(sender.getPending(project.id), false);
  const originalFile = path.join(first.finalPath, 'src', 'main.txt');
  assert.equal(await fs.readFile(originalFile, 'utf8'), '第一次发送');
  assert.deepEqual((await fs.readdir(first.finalPath)).sort(), ['.gitignore', 'assets.bin', 'src']);
  globalThis.fetch = realFetch;
  const second = await sender.send(project, false, log);
  assert.notEqual(second.finalPath, first.finalPath);
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
