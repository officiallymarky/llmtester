import path from 'path';
import os from 'os';

const APP_NAME = 'llmtester';

export function getAppDataDir(): string {
  const homeDir = os.homedir();

  // macOS: ~/Library/Application Support/llmbenchmark/
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', APP_NAME);
  }

  // Linux: ~/.local/share/llmbenchmark/
  if (process.platform === 'linux') {
    return path.join(homeDir, '.local', 'share', APP_NAME);
  }

  // Windows: %APPDATA%/llmbenchmark/
  return path.join(process.env.APPDATA || homeDir, APP_NAME);
}

export function getConfigDir(): string {
  const homeDir = os.homedir();

  // Linux: ~/.config/llmbenchmark/
  if (process.platform === 'linux') {
    return path.join(homeDir, '.config', APP_NAME);
  }

  // macOS: ~/Library/Application Support/llmbenchmark/
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', APP_NAME);
  }

  // Windows: %APPDATA%/llmbenchmark/
  return path.join(process.env.APPDATA || homeDir, APP_NAME);
}

export function getDetailedLogsDir(): string {
  return path.join(getAppDataDir(), 'detailed_logs');
}

export function getResultsDir(): string {
  return path.join(getAppDataDir(), 'results');
}

export function getProgressDir(): string {
  return path.join(getAppDataDir(), 'eval_progress');
}
