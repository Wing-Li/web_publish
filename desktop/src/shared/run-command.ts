import { spawn } from 'node:child_process';
import path from 'node:path';

export interface RunResult {
  code: number;
  output: string;
}

const dedupePathEntries = (entries: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of entries) {
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
};

const normalizeSpawnEnv = (
  command: string,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const currentPath = merged[pathKey] ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);

  if (path.isAbsolute(command)) {
    entries.unshift(path.dirname(command));
  }

  if (process.platform === 'darwin') {
    entries.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    );
  }

  merged[pathKey] = dedupePathEntries(entries).join(path.delimiter);
  return merged;
};

export const runCommand = (
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  onData?: (chunk: string) => void,
): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: normalizeSpawnEnv(command, env),
    });

    let output = '';
    let settled = false;

    const finalize = (code: number, extra?: string): void => {
      if (settled) return;
      settled = true;
      const merged = extra ? `${output}${extra}` : output;
      resolve({ code, output: merged });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onData?.(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onData?.(text);
    });

    child.on('error', (err: Error) => {
      finalize(1, `${err.message}\n`);
    });

    child.on('close', (code) => {
      finalize(code ?? 1);
    });
  });

export const runCommandStrict = async (
  command: string,
  args: string[],
  cwd: string,
  errorPrefix: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> => {
  const result = await runCommand(command, args, cwd, env);
  if (result.code !== 0) {
    throw new Error(`${errorPrefix}: ${result.output}`);
  }
  return result.output.trim();
};
