import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { createLLMClient, LLMClient, ProviderType } from './client.js';
import { fetchBenchmark, Benchmark, BENCHMARK_DEFINITIONS } from './benchmarks.js';
import { Evaluator, EvaluationResult } from './evaluator.js';
import { ProgressTracker } from './progress.js';
import { Logger } from './logger.js';
import { getAppDataDir, getDetailedLogsDir, getResultsDir, getProgressDir } from './paths.js';
import { Config, loadConfig, saveConfig, prompt } from './config.js';
import { selectOption, selectMulti } from './menu.js';

export const PROVIDERS: { id: ProviderType; name: string; defaultUrl: string }[] = [
  { id: 'openai', name: 'OpenAI', defaultUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', defaultUrl: 'https://api.anthropic.com' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', defaultUrl: '' },
];

export const COMMON_OPENAI_ENDPOINTS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'Together.ai', url: 'https://api.together.xyz/v1' },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { name: 'Fireworks AI', url: 'https://api.fireworks.ai/inference/v1' },
  { name: 'Perplexity', url: 'https://api.perplexity.ai' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'Custom URL', url: '' },
];

export async function selectProvider(): Promise<{ id: ProviderType; name: string; defaultUrl: string }> {
  return selectOption(PROVIDERS, 'Select your provider');
}

export async function selectProviderWithPrompt(message: string): Promise<{ id: ProviderType; name: string; defaultUrl: string }> {
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

export async function selectEndpoint(provider: ProviderType): Promise<string> {
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

export async function selectEndpointWithPrompt(provider: ProviderType): Promise<string> {
  if (provider === 'anthropic') { return 'https://api.anthropic.com'; }
  if (provider === 'custom') {
    const answer = await prompt('Enter custom endpoint URL: ');
    return answer.trim();
  }
  return PROVIDERS.find(p => p.id === provider)?.defaultUrl || '';
}

export async function getConfig(): Promise<Config> {
  const envProvider = process.env.LLM_PROVIDER || '';
  const envApiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const envBaseUrl = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || '';
  const envModelName = process.env.LLM_MODEL || process.env.MODEL_NAME || '';

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

  if (savedConfig) {
    if (savedConfig.judgeProvider) config.judgeProvider = savedConfig.judgeProvider;
    if (savedConfig.judgeApiKey) config.judgeApiKey = savedConfig.judgeApiKey;
    if (savedConfig.judgeBaseUrl) config.judgeBaseUrl = savedConfig.judgeBaseUrl;
    if (savedConfig.judgeModelName) config.judgeModelName = savedConfig.judgeModelName;
  }

  if (!envProvider && !envApiKey && !envModelName) {
    await saveConfig(config);
  }

  return config;
}

export async function selectBenchmarks(): Promise<Benchmark[]> {
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

export async function runBenchmarks(): Promise<void> {
  const config: Config = await getConfig();
  const client: LLMClient = createLLMClient(config.provider, config.apiKey, config.baseUrl, config.modelName, config.mode);

  const benchmarks = await selectBenchmarks();

  const shuffleAnswer = (await prompt('Shuffle samples for diverse distribution? (Y/n): ')).trim().toLowerCase();
  const shouldShuffle = shuffleAnswer !== 'n';
  benchmarks.forEach((b: Benchmark) => b.shuffle = shouldShuffle);

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

    let data: unknown[];
    try {
      data = await fetchBenchmark(benchmark.id, benchmark.percentage, benchmark.shuffle, runSeed);
    } catch (error) {
      console.log(chalk.red(`Failed to fetch ${benchmark.name}: ${error}`));
      continue;
    }

    let correct = 0;
    const runTimestamp = Date.now();
    const runLogEntries: { benchmark: string; model: string; question: unknown; response: string; isCorrect: boolean; judgeResponse?: string; timestamp: string; index: number }[] = [];

    for (let i = startIdx; i < data.length; i++) {
      const item = data[i];

      try {
        const pct = i === 0 ? '0.0' : ((correct / i) * 100).toFixed(1);
        process.stdout.write(`\r${benchmark.name}: [solving... ${i + 1}/${data.length}] ${pct}% correct`);
        const response = await evaluator.evaluate(benchmark, item);
        let isCorrect: boolean;
        let judgeResponse: string | undefined;

        if (benchmark.useJudge && judgeClient) {
          process.stdout.write(`\r${benchmark.name}: [judging... ${i + 1}/${data.length}] ${pct}% correct`);
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
          response: response.content,
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
