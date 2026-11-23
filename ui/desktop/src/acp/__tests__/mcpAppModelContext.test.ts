import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types/message';
import {
  MAX_MCP_APP_CONTEXT_CHARS,
  resetMcpAppModelContextForTests,
  setMcpAppModelContext,
  takePendingMcpAppModelContext,
} from '../mcpAppModelContext';

const request = vi.fn();
vi.mock('../acpConnection', () => ({
  getAcpClient: async () => ({ connection: { agent: { request } } }),
}));

const reader = { extensionName: 'tale', resourceUri: 'ui://tale/reader' };

function userMessage(text: string): Message {
  return {
    id: 'message-1',
    role: 'user',
    created: 1,
    content: [{ type: 'text', text }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

describe('MCP app model context', () => {
  beforeEach(() => {
    resetMcpAppModelContextForTests();
    request.mockReset();
  });

  afterEach(() => {
    resetMcpAppModelContextForTests();
  });

  it('delivers only the latest update once, as an assistant-only resource', () => {
    setMcpAppModelContext('s1', 'app-1', reader, {
      content: [{ type: 'text', text: 'Chapter 1' }],
    });
    setMcpAppModelContext('s1', 'app-1', reader, {
      content: [{ type: 'text', text: 'Chapter 2' }],
      structuredContent: { chapter: 2 },
    });

    const blocks = takePendingMcpAppModelContext('s1');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'resource',
      annotations: { audience: ['assistant'] },
      resource: { uri: 'ui://tale/reader', mimeType: 'text/plain' },
    });
    const text = (blocks[0] as { resource: { text: string } }).resource.text;
    expect(text).toContain('"tale" app');
    expect(text).toContain('not instructions');
    expect(text).toContain('Chapter 2\n\n{"chapter":2}');
    expect(text).not.toContain('Chapter 1');

    expect(takePendingMcpAppModelContext('s1')).toEqual([]);
  });

  it('keeps apps and sessions separate', () => {
    setMcpAppModelContext('s1', 'app-1', reader, { content: [{ type: 'text', text: 'a' }] });
    setMcpAppModelContext('s1', 'app-2', reader, { content: [{ type: 'text', text: 'b' }] });
    setMcpAppModelContext('s2', 'app-3', reader, { content: [{ type: 'text', text: 'c' }] });

    expect(takePendingMcpAppModelContext('s1')).toHaveLength(2);
    expect(takePendingMcpAppModelContext('s2')).toHaveLength(1);
  });

  it('drops the context when an app clears it', () => {
    setMcpAppModelContext('s1', 'app-1', reader, { content: [{ type: 'text', text: 'a' }] });
    setMcpAppModelContext('s1', 'app-1', reader, { content: [] });

    expect(takePendingMcpAppModelContext('s1')).toEqual([]);
  });

  it('truncates oversized context', () => {
    setMcpAppModelContext('s1', 'app-1', reader, {
      content: [{ type: 'text', text: 'x'.repeat(MAX_MCP_APP_CONTEXT_CHARS + 500) }],
    });

    const text = (takePendingMcpAppModelContext('s1')[0] as { resource: { text: string } }).resource
      .text;
    expect(text.endsWith('[truncated]')).toBe(true);
    expect(text.length).toBeLessThan(MAX_MCP_APP_CONTEXT_CHARS + 300);
  });

  it('prepends pending context to the next prompt only', async () => {
    const { acpPromptSession } = await import('../prompt');
    setMcpAppModelContext('s1', 'app-1', reader, {
      content: [{ type: 'text', text: 'Chapter 3' }],
    });

    await acpPromptSession('s1', userMessage('what does this word mean?'));
    await acpPromptSession('s1', userMessage('thanks'));

    const firstPrompt = request.mock.calls[0][1].prompt;
    expect(firstPrompt).toHaveLength(2);
    expect(firstPrompt[0].type).toBe('resource');
    expect(firstPrompt[1]).toEqual({ type: 'text', text: 'what does this word mean?' });

    expect(request.mock.calls[1][1].prompt).toEqual([{ type: 'text', text: 'thanks' }]);
  });
});
