import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  output: string;
}

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
      env: { ...process.env, ...env },
    });

    let output = '';

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

    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
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
