import { ArrowLeft, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  getWebPane,
  getWebPaneOriginPrompt,
  subscribeToWebPanes,
  closeWebPane,
} from '../../acp/webPane';
import { defineMessages, useIntl } from '../../i18n';
import { ConfirmationModal } from '../ui/ConfirmationModal';

const i18n = defineMessages({
  back: { id: 'webPane.back', defaultMessage: 'Back' },
  reload: { id: 'webPane.reload', defaultMessage: 'Reload' },
  close: { id: 'webPane.close', defaultMessage: 'Close web pane' },
  promptTitle: { id: 'webPane.promptTitle', defaultMessage: 'Open {origin}?' },
  promptMessage: {
    id: 'webPane.promptMessage',
    defaultMessage:
      'goose wants to show this site in a pane beside the chat. It will remember your answer for this site.',
  },
  promptAllow: { id: 'webPane.promptAllow', defaultMessage: 'Open' },
  promptDeny: { id: 'webPane.promptDeny', defaultMessage: 'Not now' },
});

function useWebPane(sessionId: string) {
  return useSyncExternalStore(subscribeToWebPanes, () => getWebPane(sessionId));
}

function useOriginPrompt() {
  return useSyncExternalStore(subscribeToWebPanes, getWebPaneOriginPrompt);
}

export function WebPaneOriginPrompt({ sessionId }: { sessionId: string }) {
  const intl = useIntl();
  const prompt = useOriginPrompt();
  if (!prompt || prompt.sessionId !== sessionId) return null;
  return (
    <ConfirmationModal
      isOpen
      title={intl.formatMessage(i18n.promptTitle, { origin: prompt.origin })}
      message={intl.formatMessage(i18n.promptMessage)}
      confirmLabel={intl.formatMessage(i18n.promptAllow)}
      cancelLabel={intl.formatMessage(i18n.promptDeny)}
      onConfirm={() => prompt.answer(true)}
      onCancel={() => prompt.answer(false)}
    />
  );
}

export default function WebPanePanel({ sessionId }: { sessionId: string }) {
  const intl = useIntl();
  const pane = useWebPane(sessionId);
  const prompt = useOriginPrompt();
  const bodyRef = useRef<HTMLDivElement>(null);
  const isOpen = pane !== undefined;

  // The page is a native view layered over this window, so it follows the body's
  // box and hides while a dialog needs the space.
  useEffect(() => {
    const body = bodyRef.current;
    if (!isOpen || !body) return;
    if (prompt) {
      void window.electron.webPane.setBounds(sessionId, null);
      return;
    }
    const update = () => {
      const { x, y, width, height } = body.getBoundingClientRect();
      void window.electron.webPane.setBounds(sessionId, { x, y, width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      void window.electron.webPane.setBounds(sessionId, null);
    };
  }, [sessionId, isOpen, prompt]);

  if (!pane) return null;

  const button =
    'no-drag rounded-md p-1.5 text-text-secondary hover:bg-black/10 hover:text-text-primary disabled:opacity-40 dark:hover:bg-white/10';

  return (
    <div className="flex h-full min-w-[360px] basis-1/2 flex-col border-l border-border-primary bg-background-primary">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border-primary px-2">
        <button
          className={button}
          disabled={!pane.canGoBack}
          onClick={() => void window.electron.webPane.navigate(sessionId, 'back')}
          title={intl.formatMessage(i18n.back)}
          aria-label={intl.formatMessage(i18n.back)}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className={button}
          onClick={() => void window.electron.webPane.navigate(sessionId, 'reload')}
          title={intl.formatMessage(i18n.reload)}
          aria-label={intl.formatMessage(i18n.reload)}
        >
          <RotateCw size={16} />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <div className="truncate text-sm text-text-primary">{pane.title || pane.url}</div>
          <div className="truncate text-xs text-text-secondary">{pane.url}</div>
        </div>
        <button
          className={button}
          onClick={() => void closeWebPane({ sessionId })}
          title={intl.formatMessage(i18n.close)}
          aria-label={intl.formatMessage(i18n.close)}
          data-testid="web-pane-close"
        >
          <X size={16} />
        </button>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1" data-testid="web-pane-body" />
    </div>
  );
}
