#!/usr/bin/env node

import dotenv from 'dotenv';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { execFileSync } from 'child_process';
import { createLLMClient, LLMClient, ProviderType } from './client.js';
import { fetchBenchmark, Benchmark, BENCHMARK_DEFINITIONS } from './benchmarks.js';
import { Evaluator, EvaluationResult } from './evaluator.js';
import { ProgressTracker } from './progress.js';
import { Logger } from './logger.js';
import { getAppDataDir, getConfigDir, getDetailedLogsDir, getResultsDir, getProgressDir } from './paths.js';

dotenv.config();

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

async function loadConfig(): Promise<Partial<Config> | null> {
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

async function saveConfig(config: Config): Promise<void> {
  const configPath = getConfigPath();
  try {
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeJson(configPath, config, { spaces: 2 });
    console.log(chalk.green(`Config saved to: ${configPath}`));
  } catch (e) {
    console.log(chalk.yellow(`Warning: Could not save config: ${e}`));
  }
}

interface Config {
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

const PROVIDERS: { id: ProviderType; name: string; defaultUrl: string }[] = [
  { id: 'openai', name: 'OpenAI', defaultUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', defaultUrl: 'https://api.anthropic.com' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', defaultUrl: '' },
];

const COMMON_OPENAI_ENDPOINTS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'Together.ai', url: 'https://api.together.xyz/v1' },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1' },
  { name: 'Perplexity', url: 'https://api.perplexity.ai' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'Custom URL', url: '' },
];

async function prompt(message: string): Promise<string> {
  process.stdin.removeAllListeners('keypress');
  process.stdin.removeAllListeners('readable');
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('end');
  return new Promise((resolve) => {
    process.stdout.write(message);
    let input = '';
    const onData = (data: Buffer) => {
      const ch = data.toString();
      if (ch === '\r' || ch === '\n') {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        console.log('');
        resolve(input);
        return;
      }
      if (ch === '\x7f' || ch === '\x08') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (ch === '\x03') {
        process.stdin.removeListener('data', onData);
        process.exit(0);
        return;
      }
      if (ch.length === 1 && ch >= ' ') {
        input += ch;
        process.stdout.write(ch);
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function selectOption<T extends { id: string; name: string }>(
  items: T[],
  message: string
): Promise<T> {
  // Remove all existing keypress listeners first
  process.stdin.removeAllListeners('keypress');
  readline.emitKeypressEvents(process.stdin);
  
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let cursor = 0;

  const render = () => {
    process.stdout.write('\x1b[H\x1b[2J');
    console.log(chalk.cyan(`${message}\n`));
    items.forEach((item, i) => {
      const prefix = i === cursor ? chalk.cyan('> ') : '  ';
      console.log(`${prefix}${item.name}`);
    });
    console.log(chalk.gray('\nUse arrow keys, Enter to select'));
  };

  render();

  return new Promise((resolve) => {
    const handleKeypress = (str: string, key: any) => {
      if (key.ctrl && key.name === 'c') {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }
      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key.name === 'down') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      } else if (key.name === 'return') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        resolve(items[cursor]);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}

async function selectMulti<T extends { name: string }>(
  items: T[],
  message: string,
  formatItem?: (item: T) => string
): Promise<T[]> {
  // Remove all existing keypress listeners first
  process.stdin.removeAllListeners('keypress');
  readline.emitKeypressEvents(process.stdin);
  
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdout.write('\x1b[H\x1b[2J');
  console.log(chalk.cyan(`\n${message}`));
  console.log(chalk.gray('Space to toggle, Enter to confirm\n'));

  const selected: T[] = [];
  let cursor = 0;

  const render = () => {
    process.stdout.write('\x1b[H\x1b[2J');
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
    const handleKeypress = (str: string, key: any) => {
      if (key.ctrl && key.name === 'c') {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }
      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key.name === 'down') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      } else if (key.name === 'space' || str === ' ') {
        const item = items[cursor];
        if (selected.includes(item)) {
          selected.splice(selected.indexOf(item), 1);
        } else {
          selected.push(item);
        }
        render();
      } else if (key.name === 'return') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        resolve(selected);
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}

async function selectProvider(): Promise<{ id: ProviderType; name: string; defaultUrl: string }> {
  return selectOption(PROVIDERS, 'Select your provider');
}


async function selectProviderWithPrompt(message: string): Promise<{ id: ProviderType; name: string; defaultUrl: string }> {
  console.log(chalk.cyan('\n' + message));
  PROVIDERS.forEach((p, i) => { console.log(String(i + 1) + '. ' + p.name); });
  const providerIds = ['openai', 'anthropic', 'custom'];
  while (true) {
    const answer = await prompt('Enter a number (1-3) or name: ');
    const trimmed = answer.trim().toLowerCase();
    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= PROVIDERS.length) { return PROVIDERS[num - 1]; }
    if (providerIds.includes(trimmed)) { return PROVIDERS.find(p => p.id === trimmed)!; }
    console.log(chalk.yellow('Invalid selection. Please try again.'));
  }
}

async function selectEndpoint(provider: ProviderType): Promise<string> {
  if (provider === 'anthropic') {
    return 'https://api.anthropic.com';
  }

  if (provider === 'custom' || provider === 'openai') {
    const endpoints = COMMON_OPENAI_ENDPOINTS.map(e => ({ id: e.url || 'custom', name: e.name, url: e.url }));
    const selection = await selectOption(endpoints, 'Select or enter endpoint');
    if (selection.url === '') {
      return (await prompt('Enter custom endpoint URL: ')).trim();
    }
    return selection.url;
  }

  return PROVIDERS.find(p => p.id === provider)?.defaultUrl || '';
}


async function selectEndpointWithPrompt(provider: ProviderType): Promise<string> {
  if (provider === 'anthropic') { return 'https://api.anthropic.com'; }
  if (provider === 'custom') {
    const answer = await prompt('Enter custom endpoint URL: ');
    return answer.trim();
  }
  return PROVIDERS.find(p => p.id === provider)?.defaultUrl || '';
}

async function getConfig(): Promise<Config> {
  const envProvider = process.env.LLM_PROVIDER || '';
  const envApiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const envBaseUrl = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || '';
  const envModelName = process.env.LLM_MODEL || process.env.MODEL_NAME || '';

  // Load saved config
  const savedConfig = await loadConfig();

  let provider: ProviderType;
  let providerMode: string = savedConfig?.mode || 'openai';
  let providerInfo: { id: ProviderType; name: string; defaultUrl: string };

  if (envProvider && PROVIDERS.some(p => p.id === envProvider)) {
    provider = envProvider as ProviderType;
    providerInfo = PROVIDERS.find(p => p.id === provider)!;
    console.log(chalk.green(`Provider: ${providerInfo.name} (from env)`));
  } else if (savedConfig?.provider) {
    provider = savedConfig.provider;
    providerInfo = PROVIDERS.find(p => p.id === provider)!;
    console.log(chalk.green(`Provider: ${providerInfo.name} (from config)`));
  } else {
    providerInfo = await selectProvider();
    provider = providerInfo.id;
  }

  // Ask for mode when custom provider
  if (provider === 'custom') {
    const envMode = process.env.LLM_MODE || '';
    if (envMode === 'anthropic') {
      providerMode = 'anthropic';
    } else if (savedConfig?.mode) {
      providerMode = savedConfig.mode;
    } else {
      console.log(chalk.cyan(''));
      const modeAnswer = (await prompt('API mode - openai (OpenAI-compatible) or anthropic (Anthropic-compatible)? (o/a): ')).trim().toLowerCase();
      providerMode = modeAnswer === 'a' ? 'anthropic' : 'openai';
    }
    console.log(chalk.green('Mode: ' + providerMode));
  }

  let endpoint = envBaseUrl || savedConfig?.baseUrl || '';
  if (!endpoint) {
    endpoint = await selectEndpoint(provider);
  } else {
    console.log(chalk.green(`Endpoint: ${endpoint}`));
  }

  let key = envApiKey || savedConfig?.apiKey || '';
  if (!key) {
    const keyPrompt = provider === 'anthropic'
      ? 'Enter your Anthropic API key: '
      : 'Enter your API key: ';
    key = (await prompt(keyPrompt)).trim();
  } else {
    const maskedKey = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '***';
    console.log(chalk.green(`API key: ${maskedKey}`));
  }

  let model = envModelName || savedConfig?.modelName || '';
  if (!model) {
    model = (await prompt('Enter model name (e.g., gpt-4o, claude-3-opus): ')).trim();
  } else {
    console.log(chalk.green(`Model: ${model}`));
  }

  const config: Config = { provider, apiKey: key, baseUrl: endpoint, modelName: model };

  if (provider === 'custom' && providerMode) config.mode = providerMode as 'openai' | 'anthropic';

  // Preserve existing judge config when saving
  if (savedConfig) {
    if (savedConfig.judgeProvider) config.judgeProvider = savedConfig.judgeProvider;
    if (savedConfig.judgeApiKey) config.judgeApiKey = savedConfig.judgeApiKey;
    if (savedConfig.judgeBaseUrl) config.judgeBaseUrl = savedConfig.judgeBaseUrl;
    if (savedConfig.judgeModelName) config.judgeModelName = savedConfig.judgeModelName;
  }
  
  // Save config if not from env
  if (!envProvider && !envApiKey && !envModelName) {
    await saveConfig(config);
  }

  return config;
}

async function selectBenchmarks(): Promise<Benchmark[]> {
  const available = Object.values(BENCHMARK_DEFINITIONS);

  const selection = await selectMulti(
    available,
    'Select benchmarks to run',
    (bench) => `(${bench.defaultSamples.toLocaleString()} tests) - ${bench.description}`
  );

  if (selection.length === 0) {
    console.log(chalk.yellow('No benchmarks selected, exiting'));
    process.exit(0);
  }

  console.log(chalk.green(`\nSelected ${selection.length} benchmark(s)\n`));

  const benchmarks: Benchmark[] = [];
  for (const bench of selection) {
    const pctStr = await prompt(`${bench.name}: Enter % to run (1-100, default 100): `);
    const pct = parseInt(pctStr) || 100;
    benchmarks.push({ ...bench, percentage: Math.min(100, Math.max(1, pct)) });
  }

  return benchmarks;
}

async function runBenchmarks() {
  const config: Config = await getConfig();
  const client: LLMClient = createLLMClient(config.provider, config.apiKey, config.baseUrl, config.modelName, config.mode);

  const benchmarks = await selectBenchmarks();

  // Ask about shuffling
  const shuffleAnswer = (await prompt('Shuffle samples for diverse distribution? (Y/n): ')).trim().toLowerCase();
  const shouldShuffle = shuffleAnswer !== 'n';
  benchmarks.forEach((b: Benchmark) => b.shuffle = shouldShuffle);

  // Check if any selected benchmark supports judge
  const judgeBenchmarks = benchmarks.filter(b => b.useJudge);

  let useJudge = false;
  let judgeClient: LLMClient | undefined;
  let judgeProvider: ProviderType = config.judgeProvider || 'openai';
  let judgeBaseUrl = config.judgeBaseUrl || '';
  let judgeModel = config.judgeModelName || '';

  if (judgeBenchmarks.length > 0) {
    const hasCritical = judgeBenchmarks.some(b => b.id === 'truthfulqa' || b.id === 'spider' || b.id === 'math');
    const label = hasCritical ? '(highly recommended)' : '(recommended)';
    const judgeAnswer = (await prompt(`Use judge for evaluation? (y/N) - ${label}: `)).trim().toLowerCase();
    useJudge = judgeAnswer === 'y';

    if (useJudge) {
      const useJudgeEnv = process.env.JUDGE_PROVIDER || config.judgeProvider || '';

      if (useJudgeEnv && PROVIDERS.some(p => p.id === useJudgeEnv)) {
        judgeProvider = useJudgeEnv as ProviderType;
      } else {
        const providerInfo = await selectProviderWithPrompt('Select judge provider:');
        judgeProvider = providerInfo.id;
      }

      judgeBaseUrl = process.env.JUDGE_BASE_URL || config.judgeBaseUrl || '';
      if (!judgeBaseUrl) {
        judgeBaseUrl = await selectEndpointWithPrompt(judgeProvider);
      }

      const judgeApiKey = process.env.JUDGE_API_KEY || config.judgeApiKey || '';
      const finalJudgeApiKey = judgeApiKey || (await prompt('Enter judge API key: ')).trim();

      judgeModel = process.env.JUDGE_MODEL || config.judgeModelName || '';
      if (!judgeModel) {
        const isOpenAI = judgeProvider === 'openai' || judgeBaseUrl.includes('openai.com');
        const isOpenRouter = judgeBaseUrl.includes('openrouter.ai') || judgeBaseUrl.includes('openrouter');
        const modelRecommendation = (isOpenAI || isOpenRouter) ? 'gpt-4o-mini' : '';
        const promptText = modelRecommendation
          ? `Enter judge model name (recommended: ${modelRecommendation}): `
          : 'Enter judge model name: ';
        judgeModel = (await prompt(promptText)).trim() || modelRecommendation;
      }

      judgeClient = createLLMClient(judgeProvider, finalJudgeApiKey, judgeBaseUrl, judgeModel);

      // Save judge config if not from env
      if (!process.env.JUDGE_PROVIDER && !process.env.JUDGE_API_KEY && !process.env.JUDGE_MODEL) {
        const fullConfig: Config = {
          ...config,
          judgeProvider,
          judgeApiKey: finalJudgeApiKey,
          judgeBaseUrl,
          judgeModelName: judgeModel
        };
        await saveConfig(fullConfig);
      }
    }
  }

  console.log(chalk.bold('\n=== Configuration ==='));
  console.log(`  Model: ${config.modelName}`);
  console.log(`  Provider: ${config.provider}`);
  console.log(`  Endpoint: ${config.baseUrl}`);
  if (useJudge) {
    console.log(chalk.cyan('  Judge: enabled'));
    console.log(`    Provider: ${judgeProvider}`);
    console.log(`    Endpoint: ${judgeBaseUrl}`);
    console.log(`    Model: ${judgeModel}`);
  } else {
    console.log(chalk.gray('  Judge: disabled'));
  }
  if (shouldShuffle) {
    console.log(chalk.green('  Shuffle: enabled'));
  } else {
    console.log(chalk.gray('  Shuffle: disabled'));
  }

  const proceed = (await prompt('\nProceed with running benchmarks? (Y/n): ')).trim().toLowerCase();
  if (proceed === 'n') {
    console.log(chalk.yellow('Exiting...'));
    process.exit(0);
  }

  const detailedLogsDir = getDetailedLogsDir();
  const progressDir = getProgressDir();

  await fs.ensureDir(detailedLogsDir);
  await fs.ensureDir(progressDir);

  console.log(chalk.gray(`\nResults: ${detailedLogsDir}`));

  const logger = new Logger(detailedLogsDir);
  const progress = new ProgressTracker(progressDir);

  const evaluator = new Evaluator(
    client,
    { timeout: 120, retries: 3, temperature: 0 },
    judgeClient
  );

  const results: EvaluationResult[] = [];

  for (const benchmark of benchmarks) {
    console.log(chalk.bold(`\n=== Running ${benchmark.name} ===`));

    const safeModelName = config.modelName.replace(/[^a-zA-Z0-9]/g, '_');
    const progressFile = `${safeModelName}_${benchmark.id}_progress.json`;
    const previousProgress = progress.load(progressFile);

    let startIdx = 0;
    let runSeed = Date.now();
    if (previousProgress && previousProgress.completed > 0) {
      console.log(chalk.yellow(`Found existing progress: ${previousProgress.completed}/${previousProgress.total} completed`));
      const resume = await prompt('Resume from where you left off? (y/N): ');
      if (resume.trim().toLowerCase() === 'y') {
        startIdx = previousProgress.completed;
        runSeed = previousProgress.seed || runSeed;
        console.log(chalk.cyan('Resuming...\n'));
      } else {
        console.log(chalk.cyan('Starting fresh...\n'));
        progress.clear(progressFile);
      }
    }

    let data: any[];
    try {
      data = await fetchBenchmark(benchmark.id, benchmark.percentage, benchmark.shuffle, runSeed);
    } catch (error) {
      console.log(chalk.red(`Failed to fetch ${benchmark.name}: ${error}`));
      continue;
    }

    let correct = 0;
    const runTimestamp = Date.now();
    const runLogEntries: any[] = [];

    for (let i = startIdx; i < data.length; i++) {
      const item = data[i];

      try {
        const pct = ((correct / (i + 1)) * 100).toFixed(1);
        process.stdout.write(`\r${benchmark.name}: ${i + 1}/${data.length} [solving...] ${pct}% correct`);
        const response = await evaluator.evaluate(benchmark, item);
        let isCorrect: boolean;
        let judgeResponse: string | undefined;

        if (benchmark.useJudge && judgeClient) {
          process.stdout.write(`\r${benchmark.name}: ${i + 1}/${data.length} [judging...] ${pct}% correct`);
          const result = await evaluator.evaluateAndCheckWithJudge(benchmark, item, response);
          isCorrect = result.correct;
          judgeResponse = result.judgeResponse;
        } else {
          isCorrect = evaluator.checkAnswer(benchmark, item, response);
        }

        if (isCorrect) correct++;

        runLogEntries.push({
          benchmark: benchmark.id,
          model: config.modelName,
          question: item,
          response,
          isCorrect,
          judgeResponse,
          timestamp: new Date().toISOString(),
          index: i,
        });

        progress.save(progressFile, { completed: i + 1, total: data.length, seed: runSeed });
      } catch (error) {
        console.log(chalk.red(`\nError on item ${i}: ${error}`));
      }
    }

    // Batch write all entries for this run
    logger.logBatch(runLogEntries, `${benchmark.id}_${config.modelName}_${runTimestamp}`);

    const result: EvaluationResult = {
      benchmark: benchmark.id,
      model: config.modelName,
      total: data.length,
      correct,
      accuracy: (correct / data.length) * 100,
      timestamp: new Date().toISOString(),
      seed: runSeed,
      judge: useJudge && judgeModel ? judgeModel : undefined,
    };

    results.push(result);
    console.log(chalk.green(`\n${benchmark.name}: ${correct}/${data.length} (${result.accuracy.toFixed(2)}%)`));

    progress.clear(progressFile);
  }

  const resultsFile = path.join(getResultsDir(), `eval_results_${Date.now()}.json`);
  await fs.ensureDir(getResultsDir());
  await fs.writeJson(resultsFile, { results, timestamp: new Date().toISOString() }, { spaces: 2 });
  console.log(chalk.bold(`\n=== Results saved to ${resultsFile} ===`));

  console.log(chalk.bold('\n=== Summary ==='));
  for (const r of results) {
    console.log(`${r.benchmark}: ${r.correct}/${r.total} (${r.accuracy.toFixed(2)}%)`);
  }
}

async function showMenu() {
  // Remove all existing keypress listeners first
  process.stdin.removeAllListeners('keypress');
  readline.emitKeypressEvents(process.stdin);
  
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let cursor = 0;
  const items = ['Run benchmarks', 'Explore past results'];

  const render = () => {
    process.stdout.write('\x1b[H\x1b[2J');
    console.log(chalk.bold.cyan('\n=== LLM Benchmark Runner ===\n'));
    items.forEach((item, i) => {
      const prefix = i === cursor ? chalk.cyan('> ') : '  ';
      console.log(`${prefix}${item}`);
    });
    console.log(chalk.gray('\nArrow keys, Enter to select, Esc to quit'));
  };

  render();

  return new Promise<void>((resolve) => {
    const handleKeypress = async (str: string, key: any) => {
      if (key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log(chalk.green('\nGoodbye!'));
        process.exit(0);
      }
      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key.name === 'down') {
        cursor = Math.min(items.length - 1, cursor + 1);
        render();
      } else if (key.name === 'escape') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log(chalk.green('\nGoodbye!'));
        process.exit(0);
      } else if (key.name === 'return') {
        process.stdin.removeListener('keypress', handleKeypress);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        
        if (cursor === 0) {
          runBenchmarks().then(() => showMenu()).then(() => resolve());
        } else if (cursor === 1) {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeAllListeners('keypress');
          process.stdout.write('\x1b[H\x1b[2J');
          const tuiPath = path.join(__dirname, '..', 'bin', 'tui.js');
          execFileSync('node', [tuiPath], { stdio: 'inherit' });
          showMenu().then(() => resolve());
        }
      }
    };

    process.stdin.on('keypress', handleKeypress);
  });
}

showMenu().catch(console.error);
