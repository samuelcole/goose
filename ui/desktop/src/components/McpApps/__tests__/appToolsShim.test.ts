import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_TOOLS_CALL_METHOD, APP_TOOLS_SYNC_METHOD, injectAppToolsShim } from '../appToolsShim';

type Posted = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown };

const posted: Posted[] = [];

function runShim(): void {
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
    posted.push(message as Posted);
  });
  const html = injectAppToolsShim('<p></p>');
  const source = html.slice('<script>'.length, html.indexOf('</script>'));
  new Function(source)();
}

function fromHost(data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent('message', { data: { jsonrpc: '2.0', ...data }, source: window })
  );
}

interface ShimModelContext {
  registerTool: (
    tool: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
}

const shimModelContext = () =>
  (document as unknown as { modelContext: ShimModelContext }).modelContext;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The shim installs window listeners that can't be removed, so it runs once and
// each test uses its own tool names.
describe('app tools shim', () => {
  beforeAll(() => runShim());

  beforeEach(() => {
    posted.length = 0;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('syncs registrations once per microtask and drops aborted tools', async () => {
    const controller = new AbortController();
    const modelContext = shimModelContext();
    await Promise.all([
      modelContext.registerTool(
        { name: 'a', description: 'A', execute: () => 'a' },
        { signal: controller.signal }
      ),
      modelContext.registerTool({ name: 'b', description: 'B', execute: () => 'b' }),
    ]);
    await flush();

    const syncs = () => posted.filter((m) => m.method === APP_TOOLS_SYNC_METHOD);
    expect(syncs()).toHaveLength(1);
    expect(syncs()[0].params).toEqual({
      tools: [
        { name: 'a', description: 'A' },
        { name: 'b', description: 'B' },
      ],
    });

    controller.abort();
    await flush();
    expect(syncs().at(-1)?.params).toEqual({ tools: [{ name: 'b', description: 'B' }] });
  });

  it('rejects invalid tools', async () => {
    const modelContext = shimModelContext();
    await expect(
      modelContext.registerTool({ name: 'has space', description: 'x', execute: () => 1 })
    ).rejects.toThrow();
    await expect(modelContext.registerTool({ name: 'ok', description: ' ' })).rejects.toThrow();
  });

  it('runs calls and aborts them on notifications/cancelled', async () => {
    let seenSignal: AbortSignal | undefined;
    const modelContext = shimModelContext();
    await modelContext.registerTool({
      name: 'position',
      description: 'Where the reader is',
      execute: (input: { detail?: string }) => ({ chapter: 9, detail: input.detail }),
    });
    await modelContext.registerTool({
      name: 'slow',
      description: 'Never finishes on its own',
      execute: (_input: unknown, { signal }: { signal: AbortSignal }) => {
        seenSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by host')));
        });
      },
    });

    fromHost({
      id: 7,
      method: APP_TOOLS_CALL_METHOD,
      params: { name: 'position', arguments: { detail: 'x' } },
    });
    fromHost({ id: 8, method: APP_TOOLS_CALL_METHOD, params: { name: 'slow', arguments: {} } });
    await flush();
    fromHost({
      method: 'notifications/cancelled',
      params: { requestId: 8, reason: 'agent cancelled' },
    });
    await flush();

    expect(posted.find((m) => m.id === 7)?.result).toEqual({
      text: '{"chapter":9,"detail":"x"}',
      structuredContent: { chapter: 9, detail: 'x' },
    });
    expect(seenSignal?.aborted).toBe(true);
    expect(posted.find((m) => m.id === 8)?.result).toEqual({
      text: 'aborted by host',
      isError: true,
    });
  });

  it('keeps call requests away from the app but lets other messages through', async () => {
    const appListener = vi.fn();
    window.addEventListener('message', appListener);
    fromHost({ id: 9, method: APP_TOOLS_CALL_METHOD, params: { name: 'missing' } });
    fromHost({ method: 'ui/notifications/tool-result', params: {} });
    window.removeEventListener('message', appListener);

    expect(appListener).toHaveBeenCalledTimes(1);
    await flush();
    expect(posted.find((m) => m.id === 9)?.result).toMatchObject({ isError: true });
  });
});
