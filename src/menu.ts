import chalk from 'chalk';
import readline from 'readline';

export interface MenuItem {
  id: string;
  name: string;
}

export interface SelectableItem<T> {
  name: string;
  data: T;
}

export async function selectOption<T extends { id: string; name: string }>(
  items: T[],
  message: string
): Promise<T> {
  process.stdin.removeAllListeners('keypress');
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let cursor = 0;

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(chalk.cyan(`${message}\n`));
    items.forEach((item, i) => {
      const prefix = i === cursor ? chalk.cyan('> ') : '  ';
      console.log(`${prefix}${item.name}`);
    });
    console.log(chalk.gray('\nUse arrow keys, Enter to select'));
  };

  render();

  return new Promise((resolve) => {
    const handleKeypress = (str: string, key: unknown) => {
      const k = key as { ctrl?: boolean; name: string };
      if (k.ctrl && k.name === 'c') {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }
      if (k.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (k.name === 'down') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      } else if (k.name === 'return') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        resolve(items[cursor]);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}

export async function selectMulti<T extends { name: string }>(
  items: T[],
  message: string,
  formatItem?: (item: T) => string
): Promise<T[]> {
  process.stdin.removeAllListeners('keypress');
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdout.write('\x1b[2J\x1b[H');
  console.log(chalk.cyan(`\n${message}`));
  console.log(chalk.gray('Space to toggle, Enter to confirm\n'));

  const selected: T[] = [];
  let cursor = 0;

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(chalk.cyan(`${message}\n`));
    items.forEach((item, i) => {
      const mark = selected.includes(item) ? chalk.green('[x]') : '[ ]';
      const prefix = i === cursor ? chalk.cyan('> ') : '  ';
      const extra = formatItem ? ` ${chalk.gray(formatItem(item))}` : '';
      console.log(`${prefix}${mark} ${item.name}${extra}`);
    });
    console.log(chalk.gray('\nSpace to toggle, Enter to confirm'));
  };

  render();

  return new Promise((resolve) => {
    const handleKeypress = (str: string, key: unknown) => {
      const k = key as { ctrl?: boolean; name: string };
      if (k.ctrl && k.name === 'c') {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }
      if (k.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (k.name === 'down') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      } else if (k.name === 'space' || str === ' ') {
        const item = items[cursor];
        if (selected.includes(item)) {
          selected.splice(selected.indexOf(item), 1);
        } else {
          selected.push(item);
        }
        render();
      } else if (k.name === 'return') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        resolve(selected);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}

export async function showMainMenu(): Promise<number> {
  process.stdin.removeAllListeners('keypress');
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let cursor = 0;
  const items = ['Run benchmarks', 'Explore past results'];

  const render = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(chalk.bold.cyan('\n=== LLM Benchmark Runner ===\n'));
    items.forEach((item, i) => {
      const prefix = i === cursor ? chalk.cyan('> ') : '  ';
      console.log(`${prefix}${item}`);
    });
    console.log(chalk.gray('\nArrow keys, Enter to select, Esc to quit'));
  };

  render();

  return new Promise((resolve) => {
    const handleKeypress = (str: string, key: unknown) => {
      const k = key as { ctrl?: boolean; name: string };
      if (k.ctrl && k.name === 'c') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log(chalk.green('\nGoodbye!'));
        process.exit(0);
      }
      if (k.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (k.name === 'down') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      } else if (k.name === 'escape') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log(chalk.green('\nGoodbye!'));
        process.exit(0);
      } else if (k.name === 'return') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        resolve(cursor);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}
