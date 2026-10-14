// Provider choices are released presets, not an online catalog or proof of key access.
// Keep this module free of Node APIs: the desktop form shares it with terminal setup.
export interface ProviderPreset {
  id: string;
  name: string;
  protocol?: 'openai' | 'anthropic';
  baseUrl: string;
  source: 'endpoint' | 'preset';
  models: readonly string[];
}
export const PROVIDER_PRESET_DATE = '2026-10-14';
const online = (
  id: string,
  name: string,
  baseUrl: string,
  protocol: 'openai' | 'anthropic' = 'openai',
): ProviderPreset => ({
  id,
  name,
  baseUrl,
  protocol,
  source: 'endpoint',
  models: [],
});
const preset = (
  id: string,
  name: string,
  baseUrl: string,
  models: string[],
  protocol: 'openai' | 'anthropic' = 'openai',
): ProviderPreset => ({
  id,
  name,
  baseUrl,
  protocol,
  source: 'preset',
  models,
});
// Sources and scope are recorded in docs/development/provider-presets.md.
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'custom', name: 'custom', baseUrl: '', source: 'endpoint', models: [] },
  online('openai', 'OpenAI', 'https://api.openai.com/v1'),
  online('anthropic', 'Anthropic', 'https://api.anthropic.com', 'anthropic'),
  online('groq', 'Groq', 'https://api.groq.com/openai/v1'),
  online(
    'gemini',
    'Gemini',
    'https://generativelanguage.googleapis.com/v1beta/openai',
  ),
  online('xai', 'xAI', 'https://api.x.ai/v1'),
  online('mistral', 'Mistral', 'https://api.mistral.ai/v1'),
  online('moonshot', 'Moonshot / Kimi', 'https://api.moonshot.cn/v1'),
  online('minimax-openai', 'MiniMax · OpenAI', 'https://api.minimax.cn/v1'),
  online(
    'minimax-anthropic',
    'MiniMax · Anthropic',
    'https://api.minimax.cn/anthropic',
    'anthropic',
  ),
  online('stepfun', 'StepFun', 'https://api.stepfun.com/v1'),
  online('siliconflow', 'SiliconFlow', 'https://api.siliconflow.cn/v1'),
  online('qianfan', 'Baidu Qianfan', 'https://qianfan.baidubce.com/v2'),
  online('deepseek', 'DeepSeek · OpenAI', 'https://api.deepseek.com'),
  online('together', 'Together', 'https://api.together.ai/v1'),
  preset(
    'zhipu',
    'Zhipu GLM · OpenAI',
    'https://open.bigmodel.cn/api/paas/v4',
    ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-4.7'],
  ),
  preset(
    'zhipu-anthropic',
    'Zhipu GLM · Anthropic',
    'https://open.bigmodel.cn/api/anthropic',
    ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-4.7'],
    'anthropic',
  ),
  preset(
    'bailian',
    'Alibaba Bailian · OpenAI',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-coder-flash'],
  ),
  preset(
    'bailian-anthropic',
    'Alibaba Bailian · Anthropic',
    'https://dashscope.aliyuncs.com/apps/anthropic',
    ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-coder-flash'],
    'anthropic',
  ),
  preset(
    'ark',
    'Volcengine Ark · OpenAI',
    'https://ark.cn-beijing.volces.com/api/v3',
    ['doubao-seed-2-1-pro-260915', 'doubao-seed-1-6-flash-250828'],
  ),
  preset(
    'ark-anthropic',
    'Volcengine Ark · Anthropic',
    'https://ark.cn-beijing.volces.com/api/compatible',
    ['doubao-seed-2-1-pro-260915', 'doubao-seed-1-6-flash-250828'],
    'anthropic',
  ),
  preset(
    'deepseek-anthropic',
    'DeepSeek · Anthropic',
    'https://api.deepseek.com/anthropic',
    ['deepseek-v4-pro', 'deepseek-v4-flash'],
    'anthropic',
  ),
  preset(
    'hunyuan',
    'Tencent Hunyuan',
    'https://api.hunyuan.cloud.tencent.com/v1',
    ['hunyuan-turbos-latest', 'hunyuan-t1-latest'],
  ),
  preset(
    'sensenova',
    'SenseNova',
    'https://api.sensenova.cn/compatible-mode/v2',
    ['SenseNova-V6.5-Pro', 'SenseChat-5', 'SenseChat-Turbo'],
  ),
  preset('cohere', 'Cohere', 'https://api.cohere.ai/compatibility/v1', [
    'command-a-plus-05-2026',
  ]),
  preset('fireworks', 'Fireworks', 'https://api.fireworks.ai/inference/v1', [
    'accounts/fireworks/models/gpt-oss-20b',
  ]),
  preset(
    'bedrock-anthropic',
    'Amazon Bedrock',
    'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic',
    ['us.anthropic.claude-sonnet-5', 'global.anthropic.claude-sonnet-5'],
    'anthropic',
  ),
  // Deployment names belong to the account: never substitute public model names for them.
  preset('azure', 'Azure OpenAI', '', []),
  preset(
    'foundry-anthropic',
    'Microsoft Foundry · Anthropic',
    '',
    [],
    'anthropic',
  ),
];
export function providerPreset(id: string): ProviderPreset {
  const provider = PROVIDER_PRESETS.find((item) => item.id === id);
  if (!provider) throw new Error('unknown provider');
  return provider;
}
