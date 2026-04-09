import axios, { AxiosInstance } from 'axios';

export type ProviderType = 'openai' | 'anthropic' | 'custom';

export interface LLMClient {
  provider: ProviderType;
  baseUrl: string;
  mode?: 'openai' | 'anthropic';
  model: string;
  chat(messages: { role: string; content: string }[], options?: {
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    content: string;
    finishReason: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }>;
}

export class OpenAICompatibleClient implements LLMClient {
  public provider: ProviderType = 'openai';
  public mode: 'openai' = 'openai';
  public baseUrl: string;
  public model: string;
  private apiKey: string;
  private httpClient: AxiosInstance;

  constructor(apiKey: string, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.httpClient = axios.create({
      baseURL: baseUrl,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });
  }

  async chat(messages: { role: string; content: string }[], options?: {
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    content: string;
    finishReason: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const response = await this.httpClient.post('/chat/completions', {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 512,
    });

    const choice = response.data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      finishReason: choice?.finish_reason || '',
      usage: response.data.usage ? {
        promptTokens: response.data.usage.prompt_tokens || 0,
        completionTokens: response.data.usage.completion_tokens || 0,
        totalTokens: response.data.usage.total_tokens || 0,
      } : undefined,
    };
  }
}

export class AnthropicClient implements LLMClient {
  public provider: ProviderType = 'anthropic';
  public mode: 'anthropic' = 'anthropic';
  public baseUrl: string;
  public model: string;
  private apiKey: string;
  private httpClient: AxiosInstance;

  constructor(apiKey: string, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    const baseURL = baseUrl || 'https://api.anthropic.com';
    this.httpClient = axios.create({
      baseURL,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      timeout: 120000,
    });
  }

  async chat(messages: { role: string; content: string }[], options?: {
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    content: string;
    finishReason: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const requestBody: any = {
      model: this.model,
      messages: chatMessages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 1024,
    };

    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

        // For custom URLs (e.g. MiniMax), use /messages instead of /v1/messages
    const path = this.baseUrl && !this.baseUrl.includes('api.anthropic.com') ? 'v1/messages' : '/v1/messages';
    const response = await this.httpClient.post(path, requestBody);

    return {
      content: response.data.content?.[0]?.text || '',
      finishReason: response.data.stop_reason || '',
      usage: response.data.usage ? {
        promptTokens: response.data.usage.input_tokens || 0,
        completionTokens: response.data.usage.output_tokens || 0,
        totalTokens: (response.data.usage.input_tokens || 0) + (response.data.usage.output_tokens || 0),
      } : undefined,
    };
  }
}

export function createLLMClient(
  provider: ProviderType,
  apiKey: string,
  baseUrl: string,
  model: string,
  mode?: string
): LLMClient {
  if (provider === 'anthropic') {
    return new AnthropicClient(apiKey, baseUrl, model);
  }
  if (provider === 'custom' && mode === 'anthropic') {
    return new AnthropicClient(apiKey, baseUrl, model);
  }
  return new OpenAICompatibleClient(apiKey, baseUrl, model);
}
