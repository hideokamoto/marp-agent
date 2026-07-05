/** invoke（チャットループ）の統合テスト — モックモデル＋実ツールでSSEイベント列を検証 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';

// agentFactoryをモックし、モックモデルを差し込んだ実Mastraエージェントを返す
const agentHolder: { agent: Agent | null } = { agent: null };
vi.mock('../src/agentFactory.js', () => ({
  getOrCreateAgent: () => agentHolder.agent,
}));

import { invoke, type AgentEvent } from '../src/invoke.js';
import { executeOutputSlide } from '../src/tools/outputSlide.js';
import { resetFallbackState } from '../src/state.js';
import { clearSessions } from '../src/sessionManager.js';

interface MockStep {
  toolCall?: { name: string; args: Record<string, unknown> };
  text?: string;
}

/** LanguageModelV1のdoStreamモック: 指定ステップを順に返す */
function mockModel(steps: MockStep[]) {
  let call = 0;
  return {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock',
    defaultObjectGenerationMode: 'json',
    async doStream() {
      const step = steps[Math.min(call, steps.length - 1)];
      call++;
      const chunks: unknown[] = [];
      if (step.toolCall) {
        chunks.push({
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: `c${call}`,
          toolName: step.toolCall.name,
          args: JSON.stringify(step.toolCall.args),
        });
        chunks.push({ type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 1, completionTokens: 1 } });
      } else {
        for (const piece of (step.text ?? '').split(/(?<=。)/)) {
          if (piece) chunks.push({ type: 'text-delta', textDelta: piece });
        }
        chunks.push({ type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } });
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            chunks.forEach((c) => controller.enqueue(c));
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  };
}

function buildAgent(steps: MockStep[]) {
  const outputSlide = createTool({
    id: 'output_slide',
    description: 'スライド出力',
    inputSchema: z.object({ markdown: z.string() }),
    execute: async ({ context }) => executeOutputSlide(context.markdown),
  });
  agentHolder.agent = new Agent({
    name: 'test-agent',
    instructions: 'テスト',
    model: mockModel(steps) as never,
    tools: { output_slide: outputSlide },
  });
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
}

beforeEach(() => {
  resetFallbackState();
  clearSessions();
});

describe('invoke（チャット）', () => {
  it('テキストのみの応答はtextイベントとして流れ、doneで終わる', async () => {
    buildAgent([{ text: 'こんにちは。今日はどうしますか。' }]);
    const events = await collect(invoke({ prompt: 'やあ' }, null));

    const types = events.map((e) => e.type);
    expect(types.at(-1)).toBe('done');
    const text = events.filter((e) => e.type === 'text').map((e) => e.data).join('');
    expect(text).toBe('こんにちは。今日はどうしますか。');
  });

  it('output_slide実行でtool_use → markdownイベントが流れ、後続テキストは抑制される', async () => {
    const md = '---\nmarp: true\n---\n\n## Title\n\n- Item 1';
    buildAgent([
      { toolCall: { name: 'output_slide', args: { markdown: md } } },
      { text: 'スライドの説明をここでしますが送信されないはず。' },
    ]);
    const events = await collect(invoke({ prompt: 'スライド作って' }, null));

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_use');
    expect(types).toContain('markdown');
    expect(types.at(-1)).toBe('done');

    const markdownEvent = events.find((e) => e.type === 'markdown')!;
    expect(markdownEvent.data).toBe(md);

    // output_slide完了後のテキストは抑制される
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });

  it('export_pptx_editable はデッキソースならエラーを返す', async () => {
    const events = await collect(
      invoke(
        {
          action: 'export_pptx_editable',
          markdown: '<div class="deck-slide"><section></section></div>',
        },
        null
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(String(events[0].message)).toContain('未対応');
  });

  it('会話履歴がセッションに蓄積される', async () => {
    buildAgent([{ text: '一回目。' }]);
    await collect(invoke({ prompt: '最初' }, 'session-1'));

    const { getHistory, sessionKey } = await import('../src/sessionManager.js');
    const history = getHistory(sessionKey('session-1', 'sonnet', 'border'));
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('最初');
    expect(history[1].content).toBe('一回目。');
  });
});
