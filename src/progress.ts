import fs from 'fs-extra';
import path from 'path';

export interface ProgressData {
  completed: number;
  total: number;
  seed?: number;
}

export class ProgressTracker {
  private progressDir: string;

  constructor(progressDir: string) {
    this.progressDir = progressDir;
  }

  save(filename: string, data: ProgressData): void {
    try {
      fs.writeJsonSync(path.join(this.progressDir, filename), data, { spaces: 2 });
    } catch (error) {
      console.error(`Failed to save progress: ${error}`);
    }
  }

  load(filename: string): ProgressData | null {
    try {
      const filePath = path.join(this.progressDir, filename);
      if (fs.existsSync(filePath)) {
        return fs.readJsonSync(filePath);
      }
    } catch (error) {
      console.error(`Failed to load progress: ${error}`);
    }
    return null;
  }

  clear(filename: string): void {
    try {
      const filePath = path.join(this.progressDir, filename);
      if (fs.existsSync(filePath)) {
        fs.removeSync(filePath);
      }
    } catch (error) {
      console.error(`Failed to clear progress: ${error}`);
    }
  }
}
