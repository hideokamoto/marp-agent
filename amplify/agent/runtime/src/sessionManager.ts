/** セッション管理（会話履歴の保持）— Python版 session/manager.py の移植
 *
 * Strands版はAgentインスタンスごと（履歴込み）キャッシュしていたが、
 * Mastra版ではメッセージ履歴だけをセッションキーごとに保持し、
 * 古いメッセージを自動削除してトークンコストを削減する（スライディングウィンドウ）。
 */

import type { CoreMessage } from 'ai';

// 会話履歴のトリミング設定（Python版 SlidingWindowConversationManager(window_size=6) と同等）
const WINDOW_SIZE = 6;

const sessions = new Map<string, CoreMessage[]>();

/** セッションキーを生成（モデル・テーマ切り替え時は別履歴になる） */
export function sessionKey(sessionId: string | null, modelType: string, theme: string): string | null {
  return sessionId ? `${sessionId}:${modelType}:${theme}` : null;
}

/** セッションの会話履歴を取得（なければ空） */
export function getHistory(key: string | null): CoreMessage[] {
  if (!key) return [];
  return sessions.get(key) ?? [];
}

/** 会話のやり取りを履歴に追加し、ウィンドウサイズを超えた古いメッセージを削除 */
export function appendExchange(key: string | null, userMessage: string, assistantText: string): void {
  if (!key) return;
  const history = sessions.get(key) ?? [];
  history.push({ role: 'user', content: userMessage });
  if (assistantText) {
    history.push({ role: 'assistant', content: assistantText });
  }
  while (history.length > WINDOW_SIZE) {
    history.shift();
  }
  sessions.set(key, history);
}

/** セッション数（テスト・デバッグ用） */
export function sessionCount(): number {
  return sessions.size;
}

/** 全セッションをクリア（テスト用） */
export function clearSessions(): void {
  sessions.clear();
}
