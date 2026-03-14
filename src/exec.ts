import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Runs an external command with the given arguments.
 * Uses execFile (not exec) to prevent shell injection — args are never interpolated.
 */
export async function runCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args);
  return stdout;
}
