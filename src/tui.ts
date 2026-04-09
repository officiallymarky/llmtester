#!/usr/bin/env node
import blessed from 'blessed';
import fs from 'fs-extra';
import path from 'path';
import { getAppDataDir, getConfigDir, getDetailedLogsDir, getResultsDir } from './paths.js';

type ScreenState = 'runs' | 'entries' | 'detail';

interface Run { file: string; timestamp: string; results: any[] }
interface Entry { benchName: string; index: number; question: any; response: any; isCorrect: boolean; judgeResponse?: string }

const resultsDir = getAppDataDir();
const detailedLogsDir = getDetailedLogsDir();
const evalResultsDir = getResultsDir();
const configDir = getConfigDir();
const configPath = path.join(configDir, 'tui_config.json');

let runs: Run[] = [];
let allEntries: Entry[] = [];
let currentRun = 0;
let currentEntry = 0;
let state: ScreenState = 'runs';
let showThinking = true;
let showFailedOnly = false;

function loadConfig() {
  try {
    const config = fs.readJsonSync(configPath);
    showFailedOnly = config.showFailedOnly ?? false;
    showThinking = config.showThinking ?? true;
  } catch (e) {}
}

function saveConfig() {
  try {
    fs.ensureDirSync(configDir);
    fs.writeJsonSync(configPath, { showFailedOnly, showThinking }, { spaces: 2 });
  } catch (e) {}
}

let screen: any = null;
let runsList: any = null;
let entriesList: any = null;
let detailBox: any = null;
let header: any = null;
let footer: any = null;

function formatDate(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getResponseText(r: any): string {
  const text = typeof r === 'object' ? (r.content || JSON.stringify(r)) : r;
  let str = text.toString();
  
  if (!showThinking) {
    str = str.replace(/<think>[\s\S]*?<\/think>/gi, '');
    str = str.replace(/<think>[\s\S]*?<\/thinking>/gi, '');
  } else {
    str = str.replace(/<think>/g, '{gray-fg}<think>{/gray-fg}');
    str = str.replace(/<\/think>/g, '{/gray-fg}</think>{/gray-fg}');
    str = str.replace(/<\/thinking>/g, '{/gray-fg}</thinking>{/gray-fg}');
  }
  
  str = str.replace(/```(\w*)\n?([\s\S]*?)```/g, (match: string, lang: string, code: string) => {
    return '{gray-fg}```{/gray-fg}' + lang + '\n{cyan-fg}' + code + '{/cyan-fg}{gray-fg}```{/gray-fg}';
  });
  
  return str;
}

async function loadData(): Promise<boolean> {
  let resultFiles: string[] = [];
  try {
    const files = await fs.readdir(evalResultsDir);
    resultFiles = files.filter(f => f.startsWith('eval_results_') && f.endsWith('.json')).sort().reverse();
  } catch (e) { return false; }
  if (resultFiles.length === 0) return false;

  runs = [];
  for (const file of resultFiles) {
    try {
      const data = await fs.readJson(path.join(evalResultsDir, file));
      runs.push({ file, timestamp: data.timestamp, results: data.results || [] });
    } catch (e) {}
  }
  return runs.length > 0;
}

async function loadAllEntries(): Promise<Entry[]> {
  const run = runs[currentRun];
  const runResults = run.results; // Array of { benchmark, model, timestamp, ... }
  
  let logFiles: string[] = [];
  try { logFiles = await fs.readdir(detailedLogsDir); } catch (e) {}

  // For each result in this run, find the matching log file
  const matchingLogsByResult: Map<number, string> = new Map();

  for (let r = 0; r < runResults.length; r++) {
    const result = runResults[r];
    const benchLower = result.benchmark.toLowerCase();
    const modelLower = result.model.toLowerCase();

    // Filter log files that match this benchmark and model
    const candidates = logFiles.filter(f => {
      const lowerF = f.toLowerCase();
      return lowerF.startsWith(benchLower + '_') && lowerF.includes('_' + modelLower + '_');
    });

    if (candidates.length === 0) continue;

    // Parse timestamps from candidate filenames (format: benchmark_model_timestamp.jsonl)
    const candidatesWithTs = candidates.map(f => {
      const parts = f.split('_');
      const tsStr = parts[parts.length - 1]?.replace('.jsonl', '') || '0';
      return { file: f, ts: parseInt(tsStr) };
    }).sort((a, b) => b.ts - a.ts); // Sort descending by timestamp

    // Use the result's timestamp to find the closest matching log file
    const resultTsMs = new Date(result.timestamp).getTime();
    
    // Find the log file whose timestamp is closest to (but not after) the result timestamp
    // Log timestamp is from start of run, result timestamp is from end of run, so log <= result
    let bestMatch = candidatesWithTs[0].file;
    for (const c of candidatesWithTs) {
      if (c.ts <= resultTsMs) {
        bestMatch = c.file;
        break;
      }
    }

    matchingLogsByResult.set(r, bestMatch);
  }

  if (matchingLogsByResult.size === 0) return [];

  try {
    const allEntries: Entry[] = [];
    for (const logFile of matchingLogsByResult.values()) {
      const content = await fs.readFile(path.join(detailedLogsDir, logFile), 'utf-8');
      const entries = content.trim().split('\n').map((line: string) => JSON.parse(line));
      allEntries.push(...entries.map((e: any, i: number) => ({
        benchName: e.benchmark,
        index: i,
        question: e.question,
        response: e.response,
        isCorrect: e.isCorrect,
        judgeResponse: e.judgeResponse
      })));
    }
    return allEntries;
  } catch (e) { return []; }
}

function showRuns() {
  state = 'runs';
  runsList.show();
  entriesList.hide();
  if (detailBox) detailBox.hide();
  header.setContent('{center}{bold}{cyan-fg}LLM Benchmark Explorer{/cyan-fg}{/bold}{/center}');
  footer.setContent('{center}Enter: Select | Q: Quit{/center}');
  runsList.focus();
  render();
}

async function showEntries() {
  state = 'entries';
  allEntries = await loadAllEntries();
  
  runsList.hide();
  if (detailBox) detailBox.hide();
  
  if (allEntries.length === 0) {
    header.setContent('{center}{yellow-fg}No Detailed Entries{/yellow-fg}{/center}');
    entriesList.setItems(['No detailed entries for this run']);
    entriesList.show();
    footer.setContent('{center}Esc: Back | Q: Quit{/center}');
    render();
    return;
  }

  currentEntry = 0;
  renderEntries();
}

function renderEntries() {
  const run = runs[currentRun];
  const filteredEntries = showFailedOnly ? allEntries.filter(e => !e.isCorrect) : allEntries;
  const correct = allEntries.filter(e => e.isCorrect).length;
  const pct = ((correct / allEntries.length) * 100).toFixed(1);
  const filterLabel = showFailedOnly ? ' (failed only)' : '';
  header.setContent('{center}' + run.results.map(r => r.benchmark).join(', ') + filterLabel + ' | ' + pct + '% (' + correct + ' of ' + allEntries.length + '){/center}');
  
  const items = filteredEntries.map((e, i) => {
    const snippet = getQuestionSnippet(e.question);
    const status = e.isCorrect ? '{green-fg}[OK]{/green-fg}' : '{red-fg}[X]{/red-fg}';
    return status + ' [' + e.benchName + '] ' + snippet;
  });
  entriesList.setItems(items);
  entriesList.show();
  footer.setContent('{center}F: ' + (showFailedOnly ? 'Show All' : 'Show Failed') + ' | Enter: View Detail | Esc: Back | Q: Quit{/center}');
  entriesList.focus();
  render();
}

function showDetail() {
  state = 'detail';
  const entry = allEntries[currentEntry];
  if (!entry) return;

  entriesList.hide();

  const responseText = getResponseText(entry.response);
  const status = entry.isCorrect ? '{green-fg}[CORRECT]{/green-fg}' : '{red-fg}[INCORRECT]{/red-fg}';
  const thinkStatus = showThinking ? '{yellow-fg}[Thinking: ON]{/yellow-fg}' : '{gray-fg}[Thinking: OFF]{/gray-fg}';
  
  let content = '{center}{bold}Entry ' + (currentEntry + 1) + '/' + allEntries.length + ' | ' + entry.benchName.toUpperCase() + '{/bold}{/center}\n\n';
  content += '{center}' + status + '{/center}\n\n';
  content += '{bold}Question:{/bold}\n';
  content += getQuestionText(entry.question) + '\n\n';
  content += '{bold}Model Response ' + thinkStatus + ':{/bold}\n';
  content += responseText + '\n';
  if (entry.judgeResponse) {
    const judgeColor = entry.judgeResponse.toUpperCase().includes('YES') ? 'green-fg' : 'red-fg';
    content += '\n{bold}Judge Feedback:{/bold}\n';
    content += '{' + judgeColor + '}' + entry.judgeResponse + '{/' + judgeColor + '}';
  }

  if (detailBox) {
    detailBox.setContent(content);
    detailBox.show();
    detailBox.focus();
  }
  footer.setContent('{center}Up/Down: Scroll | T: Toggle Thinking | Esc: Back | Q: Quit{/center}');
  render();
}

function getQuestionSnippet(q: any): string {
  const text = typeof q === 'object' ? (q.question || q.target || '') : q;
  return text.toString().replace(/\n/g, ' ').trim().substring(0, 200);
}

function getQuestionText(q: any): string {
  const text = typeof q === 'object' ? (q.question || q.target || JSON.stringify(q)) : q;
  return text.toString();
}

function render() {
  if (screen) screen.render();
}

function cleanup() {
  if (screen) {
    screen.destroy();
    screen = null;
  }
}

async function main() {
  const hasData = await loadData();
  
  if (!hasData) {
    console.log('No results found.');
    process.exit(0);
  }
  
  screen = blessed.screen({ smartCSR: true, fullUnicode: true });
  screen.title = 'LLM Benchmark Explorer';

  const container = blessed.box({
    parent: screen,
    width: '100%', height: '100%',
    style: { fg: 'white', bg: 'black' }
  });

  header = blessed.text({
    parent: container,
    top: 0, left: 0, width: '100%', height: 1,
    align: 'center', valign: 'middle',
    tags: true,
    style: { fg: 'white', bg: 'black', bold: true, tags: true }
  });

  runsList = blessed.list({
    parent: container,
    top: 2, left: 0, right: 0, bottom: 1,
    border: { type: 'line' as any, fg: 'cyan' as any },
    style: { fg: 'white', border: { fg: 'cyan' }, selected: { bg: 'cyan', fg: 'black' } },
    items: runs.map(r => {
      const summary = r.results.map((x: any) => x.benchmark + ' - ' + x.correct + ' of ' + x.total + ' (' + x.accuracy.toFixed(0) + '%)').join(' | ');
      return formatDate(r.timestamp) + ' | ' + summary;
    }),
    keys: true, vi: true, mouse: true
  });

  entriesList = blessed.list({
    parent: container,
    top: 2, left: 0, right: 0, bottom: 1,
    border: { type: 'line' as any, fg: 'yellow' as any },
    style: { fg: 'white', border: { fg: 'yellow' }, selected: { bg: 'yellow', fg: 'black' } },
    tags: true,
    keys: true, vi: true, mouse: true,
    hidden: true
  });

  detailBox = blessed.scrollabletext({
    parent: container,
    top: 2, left: 0, right: 0, bottom: 1,
    border: { type: 'line' as any, fg: 'magenta' as any },
    style: { fg: 'white', border: { fg: 'magenta' }, tags: true },
    tags: true,
    scrollable: true, alwaysScroll: true,
    mouse: true, keys: true, vi: true,
    scrollbar: { ch: '|' as any, track: { bg: 'gray' }, style: { fg: 'cyan' } },
    wrap: true, hidden: true
  });

  footer = blessed.text({
    parent: container,
    bottom: 0, left: 0, width: '100%', height: 1,
    align: 'center', tags: true,
    style: { fg: 'gray' }
  });

  runsList.on('select', (_: any, i: number) => {
    currentRun = i;
    currentEntry = 0;
    showEntries();
  });

  entriesList.on('select', (_: any, i: number) => {
    currentEntry = i;
    showDetail();
  });

  screen.key(['b', 'B'], () => {
    if (state === 'detail') showEntries();
    else if (state === 'entries') showRuns();
  });

  screen.key(['escape'], () => {
    if (state === 'detail') showEntries();
    else if (state === 'entries') showRuns();
    else { cleanup(); process.exit(0); }
  });

  screen.key(['q', 'Q', 'C-c'], () => {
    cleanup();
    process.exit(0);
  });

  screen.key(['t', 'T'], () => {
    showThinking = !showThinking;
    saveConfig();
    if (state === 'detail') showDetail();
  });

  screen.key(['f', 'F'], () => {
    if (state === 'entries') {
      showFailedOnly = !showFailedOnly;
      saveConfig();
      currentEntry = 0;
      renderEntries();
    }
  });

  loadConfig();
  showRuns();
}

export async function launchTUI() {
  try { await main(); }
  catch (e) { console.error('Error:', e); cleanup(); process.exit(1); }
}

if (require.main === module) {
  main().catch(e => { console.error('Error:', e); cleanup(); process.exit(1); });
}
