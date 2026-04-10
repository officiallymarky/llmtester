#!/usr/bin//env node

import { execFileSync } from 'child_process';
import path from 'path';
import { runBenchmarks } from './runner.js';
import { showMainMenu } from './menu.js';

async function main() {
  while (true) {
    const choice = await showMainMenu();

    if (choice === 0) {
      await runBenchmarks();
    } else if (choice === 1) {
      const tuiPath = path.join(__dirname, '..', 'bin', 'tui.js');
      execFileSync('node', [tuiPath], { stdio: 'inherit' });
    }
  }
}

main().catch(console.error);
