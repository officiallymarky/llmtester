import { LLMClient } from './client.js';
import { Benchmark } from './benchmarks.js';
import { execSync } from 'child_process';

export interface EvaluationResponse {
  content: string;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface EvaluationResult {
  benchmark: string;
  model: string;
  total: number;
  correct: number;
  accuracy: number;
  timestamp: string;
  seed?: number;
  judge?: string;
}

interface EvaluatorOptions {
  timeout: number;
  retries: number;
  temperature: number;
  judgeTemperature?: number;
}

export class Evaluator {
  private client: LLMClient;
  private judgeClient: LLMClient | null;
  private model: string;
  private options: EvaluatorOptions;

  constructor(client: LLMClient, options: Partial<EvaluatorOptions> = {}, judgeClient?: LLMClient) {
    this.client = client;
    this.judgeClient = judgeClient || null;
    this.model = client.model;
    this.options = {
      timeout: options.timeout ?? 120,
      retries: options.retries ?? 3,
      temperature: options.temperature ?? 0,
      judgeTemperature: options.judgeTemperature ?? 0,
    };
  }

  private buildPrompt(benchmark: Benchmark, item: any): string {
    const template = benchmark.promptTemplate || '{question}';

    // Replace common placeholders
    let prompt = template
      .replace('{question}', item.question || item.problem || item.prompt || '')
      .replace('{text}', item.text || item.question || item.problem || item.prompt || '')
      .replace('{prompt}', item.prompt || item.question || item.problem || '');

    if (item.choices) {
      const choices = Array.isArray(item.choices)
        ? item.choices
        : Object.values(item.choices);
      const choicesText = choices
        .map((c: string, i: number) => `${String.fromCharCode(65 + i)}. ${c}`)
        .join('\n');
      prompt = prompt.replace('{choices}', choicesText);
    }

    return prompt;
  }

  private stripThinkingTags(content: string): string {
    return content
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*?<\/thinking>/gi, '')
      .trim();
  }

  async evaluate(benchmark: Benchmark, item: any): Promise<EvaluationResponse> {
    const prompt = this.buildPrompt(benchmark, item);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      try {
        const response = await this.client.chat(
          [{ role: 'user', content: prompt }],
          {
            temperature: this.options.temperature,
            maxTokens: this.getMaxTokens(benchmark),
          }
        );

        return {
          content: response.content,
          finishReason: response.finishReason,
          usage: response.usage,
        };
      } catch (error: any) {
        lastError = error;
        if (attempt < this.options.retries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Evaluation failed');
  }

  checkAnswer(benchmark: Benchmark, item: any, response: EvaluationResponse): boolean {
    const answerField = benchmark.answerField || 'answer';
    const correctAnswer = item[answerField];

    if (correctAnswer === undefined || correctAnswer === null) return false;

    const responseText = response.content.trim();

    switch (benchmark.type) {
      case 'math_reasoning':
        return this.checkMathAnswer(responseText, correctAnswer);
      case 'code':
        return this.checkCodeAnswer(responseText, correctAnswer);
      case 'typescript':
        return this.checkTypeScriptAnswer(responseText, correctAnswer);
      case 'sql':
        return this.checkSqlAnswer(responseText, correctAnswer);
      case 'truthfulqa':
        return this.checkTruthfulQA(responseText, correctAnswer, item);
      case 'commonsense':
      case 'reasoning':
      case 'knowledge':
        return this.checkMultipleChoice(responseText, correctAnswer, item);
      case 'bbh':
        return this.checkBBHAnswer(responseText, correctAnswer);
      case 'terminal':
        return this.checkBashAnswer(responseText, correctAnswer);
      default:
        return responseText.toLowerCase().includes(correctAnswer.toLowerCase());
    }
  }

  async evaluateAndCheckWithJudge(
    benchmark: Benchmark,
    item: any,
    modelResponse: EvaluationResponse
  ): Promise<{ correct: boolean; judgeResponse?: string }> {
    if (!benchmark.useJudge || !this.judgeClient) {
      const correct = this.checkAnswer(benchmark, item, modelResponse);
      return { correct, judgeResponse: undefined };
    }

    let judgePrompt = benchmark.judgePromptTemplate || '';
    const cleanResponse = this.stripThinkingTags(modelResponse.content);

    // Build prompt based on benchmark type
    switch (benchmark.id) {
      case 'truthfulqa': {
        const labeledChoices = item.labeled_choices || [];
        judgePrompt = judgePrompt
          .replace('{question}', item.question || '')
          .replace('{all_choices}', labeledChoices.join('\n'))
          .replace('{model_response}', cleanResponse);
        break;
      }
      case 'humaneval':
      case 'mbpp': {
        const question = item.question || item.text || item.prompt || '';
        const testCases = item.test_cases || item.test_list || [];
        const testStr = Array.isArray(testCases)
          ? testCases.map((tc: any, i: number) => {
              const input = tc.split('===')[0]?.trim() || '';
              const expected = tc.split('===')[1]?.trim() || '';
              return `Test ${i + 1}: Input: ${input} Expected: ${expected}`;
            }).join('\n')
          : JSON.stringify(testCases);
        judgePrompt = judgePrompt
          .replace('{question}', question)
          .replace('{test_cases}', testStr)
          .replace('{model_response}', cleanResponse);
        break;
      }
      case 'nl2bash': {
        const answerField = benchmark.answerField || 'cmd';
        judgePrompt = judgePrompt
          .replace('{question}', item.question || '')
          .replace('{correct_answer}', item[answerField] || '')
          .replace('{model_response}', cleanResponse);
        break;
      }
      case 'spider': {
        const answerField = benchmark.answerField || 'query';
        judgePrompt = judgePrompt
          .replace('{question}', item.question || '')
          .replace('{correct_answer}', item[answerField] || '')
          .replace('{model_response}', cleanResponse);
        break;
      }
      case 'math': {
        const answerField = benchmark.answerField || 'answer';
        judgePrompt = judgePrompt
          .replace('{question}', item.question || '')
          .replace('{correct_answer}', item[answerField] || '')
          .replace('{model_response}', cleanResponse);
        break;
      }
      default: {
        judgePrompt = judgePrompt
          .replace('{question}', item.question || '')
          .replace('{model_response}', cleanResponse);
      }
    }

    try {
      const judgeResponse = await this.judgeClient.chat(
        [{ role: 'user', content: judgePrompt }],
        { temperature: this.options.judgeTemperature ?? 0, maxTokens: 2000 }
      );

      const judgeAnswer = judgeResponse.content.trim().toUpperCase();
      const isCorrect = judgeAnswer.includes('YES');

      return {
        correct: isCorrect,
        judgeResponse: judgeResponse.content
      };
    } catch (error) {
      console.error('Judge evaluation failed:', error);
      return { correct: false, judgeResponse: `Error: ${error}` };
    }
  }

  private checkMathAnswer(response: string, correctAnswer: string): boolean {
    const extractedResponse = this.extractFinalAnswer(response);
    const extractedAnswer = this.extractFinalAnswer(correctAnswer);

    const responseNum = this.extractNumber(extractedResponse);
    const answerNum = this.extractNumber(extractedAnswer);

    if (responseNum !== null && answerNum !== null) {
      return Math.abs(responseNum - answerNum) < 0.01;
    }

    return extractedResponse.toLowerCase() === extractedAnswer.toLowerCase();
  }

  private extractFinalAnswer(text: string): string {
    if (text.includes('####')) {
      return text.split('####').pop()?.trim() || text;
    }
    const numbers = text.match(/-?\d+\.?\d*/g);
    if (numbers && numbers.length > 0) {
      return numbers[numbers.length - 1];
    }
    return text.trim();
  }

  private extractNumber(text: string): number | null {
    const match = text.match(/-?\d+\.?\d*/);
    return match ? parseFloat(match[0]) : null;
  }

  private checkCodeAnswer(response: string, correctAnswer: string): boolean {
    const responseCode = this.extractCode(response);

    if (!responseCode || responseCode.length === 0) {
      return false;
    }

    try {
      const encoded = Buffer.from(responseCode).toString('base64');
      execSync(`python3 -c "import base64; code=base64.b64decode('${encoded}').decode(); compile(code,'<string>','exec')"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private checkTypeScriptAnswer(response: string, correctAnswer: string): boolean {
    // For TypeScript, check if response contains TypeScript-like code
    // (function declaration with types)
    const hasFunction = /function\s+\w+/.test(response);
    const hasArrowFunction = /=>\s*{/.test(response);
    const hasTypeScriptTypes = /:\s*(number|string|boolean|any|void|never)/.test(response);
    const hasExport = /export\s+/.test(response);

    return hasFunction || hasArrowFunction;
  }

  private checkSqlAnswer(response: string, correctAnswer: string): boolean {
    // For SQL, check if response contains SQL keywords
    const hasSelect = /SELECT/i.test(response);
    const hasFrom = /FROM/i.test(response);

    // Extract SQL query from response if it's in a code block
    const sqlMatch = response.match(/```sql\n?([\s\S]*?)```/i) ||
                     response.match(/```\n?([\s\S]*?)```/i);

    if (sqlMatch) {
      const extractedSql = sqlMatch[1].trim().toUpperCase();
      return /SELECT/.test(extractedSql) && /FROM/.test(extractedSql);
    }

    return hasSelect && hasFrom;
  }

  private extractCode(text: string): string {
    // Try to find code blocks first
    const codeBlockMatch = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();

    // Try to find Python function definitions and extract from there
    const funcMatch = text.match(/(?:^|\n)(def \w+.*?(?=\n(?:[^\s]|$)))/);
    if (funcMatch) {
      return text.slice(text.indexOf(funcMatch[1])).trim();
    }

    // If no code block or function found, try to find a line that looks like Python code
    const lines = text.split('\n');
    const codeStartIdx = lines.findIndex(line =>
      line.trim().startsWith('def ') ||
      line.trim().startsWith('class ') ||
      line.trim().startsWith('import ') ||
      line.trim().startsWith('from ')
    );

    if (codeStartIdx >= 0) {
      return lines.slice(codeStartIdx).join('\n').trim();
    }

    return text.trim();
  }

  private checkMultipleChoice(response: string, correctAnswer: any, item: any): boolean {
    const normalizedResponse = response.toUpperCase().trim();

    // Handle numeric answer (e.g., MMLU returns 0, 1, 2, 3 as numbers)
    let answerStr = String(correctAnswer);
    let answerIndex: number;

    if (/^[0-3]$/.test(answerStr)) {
      // Numeric index (0-3)
      answerIndex = parseInt(answerStr);
      answerStr = String.fromCharCode(65 + answerIndex); // Convert to A, B, C, D
    } else {
      // Letter answer (A, B, C, D)
      answerStr = answerStr.toUpperCase().trim();
      answerIndex = answerStr.charCodeAt(0) - 65;
    }

    const normalizedAnswer = answerStr;

    // Direct match
    if (normalizedResponse === normalizedAnswer) return true;

    // Single letter response (e.g., "A")
    if (normalizedResponse.length === 1 && /^[A-D]$/.test(normalizedResponse)) {
      return normalizedResponse === normalizedAnswer;
    }

    // Extract letter from various patterns
    // "Choice A", "choice A", "Option B", "option B"
    let letterMatch = normalizedResponse.match(/\b(CHOICE|OPTION)\s+([A-D])\b/);
    if (letterMatch) return letterMatch[2] === normalizedAnswer;

    // "Answer is A", "answer is A", "is A"
    letterMatch = normalizedResponse.match(/\b(ANSWER|IS)\s+([A-D])\b/);
    if (letterMatch) return letterMatch[2] === normalizedAnswer;

    // "The correct answer is B"
    letterMatch = normalizedResponse.match(/\bCORRECT\b.*?\b([A-D])\b/);
    if (letterMatch) return letterMatch[1] === normalizedAnswer;

    // Single letter A, B, C, or D surrounded by word boundaries
    letterMatch = normalizedResponse.match(/\b([A-D])\b/);
    if (letterMatch) return letterMatch[1] === normalizedAnswer;

    const choices = Array.isArray(item.choices)
      ? item.choices
      : item.choices
        ? Object.values(item.choices)
        : [];

    if (answerIndex >= 0 && answerIndex < choices.length) {
      const expectedChoice = String(choices[answerIndex]).toUpperCase().trim();
      // Check if response contains the expected choice or vice versa
      return normalizedResponse.includes(expectedChoice) || expectedChoice.includes(normalizedResponse);
    }

    return false;
  }

  private checkTruthfulQA(response: string, correctAnswer: any, item: any): boolean {
    const normalizedResponse = response.toUpperCase().trim();

    // Get correct choice text
    const answerIndex = typeof correctAnswer === 'number' ? correctAnswer : parseInt(correctAnswer);
    const choices = Array.isArray(item.choices) ? item.choices : [];
    if (answerIndex < 0 || answerIndex >= choices.length) return false;

    const correctChoice = choices[answerIndex].toUpperCase().trim();

    // Check if response contains the correct answer or vice versa
    if (normalizedResponse.includes(correctChoice) || correctChoice.includes(normalizedResponse)) {
      return true;
    }

    // Check if it's the same first 20+ characters
    if (normalizedResponse.slice(0, 20) === correctChoice.slice(0, 20)) {
      return true;
    }

    return false;
  }

  private checkBashAnswer(response: string, correctAnswer: string): boolean {
    const normalizedResponse = response.toLowerCase().trim();
    const normalizedAnswer = correctAnswer.toLowerCase().trim();

    // Exact match
    if (normalizedResponse === normalizedAnswer) return true;

    // Check if main command is present (partial credit)
    const answerParts = normalizedAnswer.split(/\s+/);
    if (answerParts.length > 0) {
      const mainCmd = answerParts[0];
      if (mainCmd && normalizedResponse.includes(mainCmd)) {
        return true; // Partial credit - main command matches
      }
    }

    return false;
  }

  private checkBBHAnswer(response: string, correctAnswer: string): boolean {
    // Strip thinking tags
    const strippedResponse = response
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*?<\/thinking>/gi, '')
      .trim();

    // Extract final answer after #### if present
    let finalAnswer = strippedResponse;
    if (strippedResponse.includes('####')) {
      finalAnswer = strippedResponse.split('####').pop()?.trim() || strippedResponse;
    }

    const normalizedResponse = finalAnswer.toLowerCase().trim();
    const normalizedAnswer = correctAnswer.toLowerCase().trim();

    // Exact match
    if (normalizedResponse === normalizedAnswer) return true;

    // Handle True/False style answers
    if (normalizedAnswer === 'true' || normalizedAnswer === 'false') {
      if (normalizedResponse === 'true' || normalizedResponse === 'false') {
        return normalizedResponse === normalizedAnswer;
      }
    }

    // Handle Yes/No style answers
    if (normalizedAnswer === 'yes' || normalizedAnswer === 'no') {
      if (normalizedResponse === 'yes' || normalizedResponse === 'no') {
        return normalizedResponse === normalizedAnswer;
      }
    }

    // Handle A/B/C/D style answers (multiple choice)
    if (/^[a-d]$/i.test(normalizedAnswer)) {
      const answerChar = normalizedAnswer.toUpperCase();
      if (normalizedResponse === answerChar) return true;
      // Check if response contains the letter
      if (new RegExp(`\\b${answerChar}\\b`).test(normalizedResponse)) return true;
    }

    // Handle numeric answers
    const responseNum = normalizedResponse.match(/-?\d+\.?\d*/);
    const answerNum = normalizedAnswer.match(/-?\d+\.?\d*/);
    if (responseNum && answerNum) {
      return parseFloat(responseNum[0]) === parseFloat(answerNum[0]);
    }

    // Handle comma-separated lists (like word sorting)
    if (normalizedAnswer.includes(',') && normalizedResponse.includes(',')) {
      const respSet = new Set(normalizedResponse.split(',').map(s => s.trim()));
      const ansSet = new Set(normalizedAnswer.split(',').map(s => s.trim()));
      // Check if sets are equal
      if (respSet.size === ansSet.size && [...respSet].every(x => ansSet.has(x))) {
        return true;
      }
    }

    // Partial match - check if the answer appears in the response
    if (normalizedResponse.includes(normalizedAnswer) || normalizedAnswer.includes(normalizedResponse)) {
      return true;
    }

    return false;
  }

  private getMaxTokens(benchmark: Benchmark): number {
    return 100000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
