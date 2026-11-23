import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebPaneEvent } from '../../webPaneMain';

const syncAppTools = vi.fn().mockResolvedValue(undefined);
const unregister = vi.fn();
const registerAppToolHandler = vi.fn(() => unregister);
vi.mock('../appTools', () => ({ syncAppTools, registerAppToolHandler }));

const register = vi.fn().mockResolvedValue(undefined);
vi.mock('../acpConnection', () => ({
  getAcpClient: async () => ({ goose: { sessionWebPaneRegister_unstable: register } }),
  subscribeToAcpRecovery: () => () => {},
}));

let emit: (event: WebPaneEvent) => void = () => {};
const electronWebPane = {
  open: vi.fn(async (_sessionId: string, url: string) => ({ url, title: 'Tale' })),
  close: vi.fn(async () => emit({ type: 'closed', sessionId: 's1' })),
  callTool: vi.fn(),
  cancelTool: vi.fn(),
  onEvent: vi.fn((callback: (event: WebPaneEvent) => void) => {
    emit = callback;
    return () => {};
  }),
};
Object.defineProperty(window, 'electron', { value: { webPane: electronWebPane }, writable: true });

const webPane = await import('../webPane');

async function answerPrompt(allowed: boolean) {
  await vi.waitFor(() => expect(webPane.getWebPaneOriginPrompt()).not.toBeNull());
  webPane.getWebPaneOriginPrompt()!.answer(allowed);
}

describe('web pane', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('asks once per origin and remembers an approval', async () => {
    const first = webPane.openWebPane({ sessionId: 's1', url: 'https://tale.fyi/all-quiet' });
    await answerPrompt(true);
    await expect(first).resolves.toEqual({ url: 'https://tale.fyi/all-quiet', title: 'Tale' });
    expect(webPane.getWebPane('s1')).toBeDefined();

    await webPane.openWebPane({ sessionId: 's1', url: 'https://tale.fyi/dracula' });
    expect(webPane.getWebPaneOriginPrompt()).toBeNull();
    expect(electronWebPane.open).toHaveBeenCalledTimes(2);
  });

  it('refuses to open a declined origin', async () => {
    const opening = webPane.openWebPane({ sessionId: 's1', url: 'https://example.com/' });
    await answerPrompt(false);
    await expect(opening).rejects.toThrow('declined');
    expect(electronWebPane.open).not.toHaveBeenCalled();
  });

  it('offers page tools per document and withdraws them on navigation and close', async () => {
    await webPane.registerWebPaneSession('s1');
    expect(register).toHaveBeenCalledWith({ sessionId: 's1' });

    emit({ type: 'document', sessionId: 's1', documentId: 'doc-1', host: 'tale.fyi' });
    emit({
      type: 'tools',
      sessionId: 's1',
      documentId: 'doc-1',
      tools: [{ name: 'go_to', description: 'Go to a passage' }],
    });
    expect(syncAppTools).toHaveBeenLastCalledWith('s1', 'doc-1', 'tale.fyi', [
      { name: 'go_to', description: 'Go to a passage' },
    ]);
    expect(registerAppToolHandler).toHaveBeenCalledWith('doc-1', expect.any(Object));

    emit({ type: 'tools', sessionId: 's1', documentId: 'stale-doc', tools: [] });
    expect(syncAppTools).toHaveBeenCalledTimes(1);

    emit({ type: 'document', sessionId: 's1', documentId: 'doc-2', host: 'tale.fyi' });
    expect(syncAppTools).toHaveBeenLastCalledWith('s1', 'doc-1', 'tale.fyi', []);
    expect(unregister).toHaveBeenCalledTimes(1);

    emit({ type: 'closed', sessionId: 's1' });
    expect(syncAppTools).toHaveBeenLastCalledWith('s1', 'doc-2', 'tale.fyi', []);
  });
});
