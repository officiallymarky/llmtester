import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';

export interface LogEntry {
  benchmark: string;
  model: string;
  question: any;
  response: any;
  isCorrect: boolean;
  judgeResponse?: string;
  timestamp: string;
  index?: number;
}

export class Logger {
  private logsDir: string;

  constructor(logsDir: string) {
    this.logsDir = logsDir;
    fs.ensureDirSync(logsDir);
  }

  logBatch(entries: LogEntry[], prefix?: string): void {
    try {
      const filename = prefix || `batch_${Date.now()}`;
      const filePath = path.join(this.logsDir, `${filename}.jsonl`);
      const lines = entries.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(filePath, lines);
      console.log(chalk.gray(`\nSaved ${entries.length} entries to ${filename}.jsonl`));
    } catch (error) {
      console.error(`Failed to write batch log: ${error}`);
    }
  }
}
