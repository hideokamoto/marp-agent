/** Mastraエージェントの生成（モデル・テーマごと） */

import { Agent, type ToolsInput } from '@mastra/core/agent';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getModelConfig, getSystemPrompt } from './config.js';
import { outputSlideTool } from './tools/outputSlide.js';
import { outputDeckTool } from './tools/outputDeck.js';
import { webSearchTool } from './tools/webSearch.js';
import { generateTweetUrlTool } from './tools/generateTweet.js';
import { httpRequestTool } from './tools/httpRequest.js';

const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION ?? 'us-west-2',
  credentialProvider: fromNodeProviderChain(),
});

/** テーマに応じたツールセットを返す（折衷はHTMLデッキ、それ以外はMarp） */
function getTools(theme: string): ToolsInput {
  if (theme === 'eclectic') {
    return {
      web_search: webSearchTool,
      output_deck: outputDeckTool,
      generate_tweet_url: generateTweetUrlTool,
      http_request: httpRequestTool,
    };
  }
  return {
    web_search: webSearchTool,
    output_slide: outputSlideTool,
    generate_tweet_url: generateTweetUrlTool,
    http_request: httpRequestTool,
  };
}

// モデル×テーマごとにAgentを使い回す（会話履歴はsessionManagerが別管理）
const agentCache = new Map<string, Agent>();

export function getOrCreateAgent(modelType: string = 'sonnet', theme: string = 'border'): Agent {
  const cacheKey = `${modelType}:${theme}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const config = getModelConfig(modelType);
  const agent = new Agent({
    name: 'marp-agent',
    instructions: getSystemPrompt(theme),
    model: bedrock(config.modelId),
    tools: getTools(theme),
  });
  agentCache.set(cacheKey, agent);
  return agent;
}
