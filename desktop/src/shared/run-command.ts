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
