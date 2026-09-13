import type { AiRuntimeEvent } from '../client/AiStatus';
import type { GameViewModel } from '../viewmodel/GameViewModel';
import './AiDebug.css';

type Status = { configured: Record<'gptLive' | 'responses' | 'liveAvatar' | 'liveKit', boolean> };

const label = { gptLive: 'GPT-Live', responses: 'Responses API', liveAvatar: 'LiveAvatar', liveKit: 'LiveKit' } as const;
const providers = Object.keys(label) as Array<keyof typeof label>;

type AiDebugToggleEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'> & { target: EventTarget | null };
type EditableTarget = { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown };

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as EditableTarget;
  const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || element.isContentEditable === true) return true;
  const editor = element.closest?.('[contenteditable]');
  return Boolean(editor && typeof editor === 'object' && (editor as EditableTarget).isContentEditable === true);
}

/** Pure guard so normal game typing and browser shortcuts never reveal development UI. */
export function shouldToggleAiDebug(event: AiDebugToggleEvent): boolean {
  return event.code === 'KeyD'
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.shiftKey
    && !event.repeat
    && !event.isComposing
    && !event.defaultPrevented
    && !isEditableTarget(event.target);
}

/** Development-only control; dynamically imported from main so production emits neither UI nor routes. */
export function mountAiDebug(model: GameViewModel): () => void {
  const root = document.createElement('details');
  root.className = 'ai-debug';
  root.hidden = true;
  root.innerHTML = `<summary>AI DEBUG</summary><div class="ai-debug-body"><p>Configuration and connection state only. Values never leave the server.</p><dl>${providers.map(provider => `<div><dt>${label[provider]}</dt><dd data-provider="${provider}">loading…</dd></div>`).join('')}</dl><button type="button">TEST RESPONSES CONNECTION</button></div>`;
  document.body.append(root);
  const button = root.querySelector<HTMLButtonElement>('button')!;
  const set = (provider: keyof typeof label, value: string) => {
    const row = root.querySelector<HTMLElement>(`[data-provider="${provider}"]`)!;
    row.textContent = value;
  };
  const state = model.subscribe(view => {
    for (const provider of ['gptLive', 'liveAvatar', 'liveKit'] as const) {
      set(provider, `${view.aiDebug.configured[provider] ? 'configured' : 'not configured'} · ${view.aiDebug.runtime[provider]}`);
    }
    set('responses', `${view.aiDebug.configured.responses ? 'configured' : 'not configured'} · ${view.aiDebug.responses}`);
    button.disabled = view.aiDebug.responses === 'connecting' || !view.aiDebug.configured.responses;
  });
  void fetch('/__dev/ai-debug/status', { cache: 'no-store' })
    .then(async response => response.ok ? await response.json() as Status : Promise.reject(new Error('debug_status_failed')))
    .then(status => model.setAiDebugConfiguration(status.configured))
    .catch(() => model.setAiDebugUnavailable());
  const testResponses = () => {
    model.setAiDebugResponses('connecting');
    void fetch('/__dev/ai-debug/responses-probe', { method: 'POST', cache: 'no-store' })
      .then(async response => response.ok ? await response.json() as { state: 'connected' | 'failed' | 'not_configured' } : { state: 'failed' as const })
      .then(result => model.setAiDebugResponses(result.state === 'not_configured' ? 'idle' : result.state))
      .catch(() => model.setAiDebugResponses('failed'));
  };
  const toggle = (event: KeyboardEvent) => {
    if (shouldToggleAiDebug(event)) root.hidden = !root.hidden;
  };
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    removeEventListener('keydown', toggle);
    removeEventListener('beforeunload', cleanup);
    button.removeEventListener('click', testResponses);
    state();
    root.remove();
  };
  button.addEventListener('click', testResponses);
  addEventListener('keydown', toggle);
  addEventListener('beforeunload', cleanup, { once: true });
  return cleanup;
}

export function forwardAiStatus(model: GameViewModel, event: AiRuntimeEvent): void {
  model.setAiDebugRuntime(event.provider, event.state);
}
