import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { getConfigDir } from './paths.js';
import { ProviderType } from './client.js';

export interface Config {
  provider: ProviderType;
  mode?: 'openai' | 'anthropic';
  apiKey: string;
  baseUrl: string;
  modelName: string;
  judgeProvider?: ProviderType;
  judgeApiKey?: string;
  judgeBaseUrl?: string;
  judgeModelName?: string;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export async function loadConfig(): Promise<Partial<Config> | null> {
  const configPath = getConfigPath();
  try {
    if (await fs.pathExists(configPath)) {
      return await fs.readJson(configPath);
    }
  } catch (e) {
    console.log(chalk.yellow(`Warning: Could not load config: ${e}`));
  }
  return null;
}

export async function saveConfig(config: Config): Promise<void> {
  const configPath = getConfigPath();
  try {
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeJson(configPath, config, { spaces: 2 });
    console.log(chalk.green(`Config saved to: ${configPath}`));
  } catch (e) {
    console.log(chalk.yellow(`Warning: Could not save config: ${e}`));
  }
}

export async function prompt(message: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.removeAllListeners('keypress');
    process.stdin.setRawMode?.(false);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(message, (answer: string) => {
      rl.close();
      resolve(answer);
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  });
}
