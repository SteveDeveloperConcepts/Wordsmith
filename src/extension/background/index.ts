/// <reference types="chrome" />
/**
 * The service worker. It keeps nothing in memory that matters, because the browser
 * stops it after 30 idle seconds: each check reads the settings afresh and makes
 * sure the offscreen document exists before handing the text over.
 */
import { CONTENT_SCRIPT, OFFSCREEN_PAGE } from '../manifest';
import type { AnalyzeMessage, AnalyzeReply, BackgroundMessage, OffscreenAnalyzeMessage } from '../shared/messages';
import { engineSettings, loadDictionary, loadSettings } from '../shared/settings';
import { DEFAULT_SITE_MATCHES } from '../shared/sites';

const GRANTED_SITES_SCRIPT = 'wordsmith-granted-sites';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  // Only one offscreen document may exist, and two tabs can ask at the same moment.
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PAGE,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the grammar and spelling engine in a worker, once for all tabs.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function analyze(message: AnalyzeMessage, sender: chrome.runtime.MessageSender): Promise<AnalyzeReply> {
  const [settings, dictionary] = await Promise.all([loadSettings(), loadDictionary()]);
  const forward: OffscreenAnalyzeMessage = {
    target: 'offscreen',
    type: 'analyze',
    key: `${sender.tab?.id}:${sender.frameId}:${message.fieldId}`,
    settings: engineSettings(settings, dictionary),
    request: message.request,
  };
  try {
    await ensureOffscreen();
    return (await chrome.runtime.sendMessage(forward)) as AnalyzeReply;
  } catch {
    // The document can close between the check and the send, so try once more with a new one.
    await ensureOffscreen();
    return (await chrome.runtime.sendMessage(forward)) as AnalyzeReply;
  }
}

chrome.runtime.onMessage.addListener(
  (message: BackgroundMessage, sender, sendResponse: (reply: AnalyzeReply) => void) => {
    if (message?.target !== 'background') return false;
    if (message.type === 'offscreen-idle') {
      chrome.offscreen.closeDocument().catch(() => undefined);
      return false;
    }
    analyze(message, sender).then(sendResponse, (error: unknown) =>
      sendResponse({ status: 'failed', message: String(error) }),
    );
    return true;
  },
);

/** Sites the writer granted get the same content script as the default ones. */
async function registerGrantedSites(): Promise<void> {
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = origins.filter((origin) => !DEFAULT_SITE_MATCHES.includes(origin));
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [GRANTED_SITES_SCRIPT] });
  if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [GRANTED_SITES_SCRIPT] });
  if (granted.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: GRANTED_SITES_SCRIPT,
      matches: granted,
      js: [CONTENT_SCRIPT],
      runAt: 'document_idle',
      allFrames: true,
      matchOriginAsFallback: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(() => void registerGrantedSites());

// This runs here and not in the popup, which the browser can close while the permission prompt is open.
chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await registerGrantedSites();
  // Pages already open for the new site would otherwise need a reload.
  const tabs = origins.length > 0 ? await chrome.tabs.query({ url: origins }) : [];
  for (const { id } of tabs) {
    if (id === undefined) continue;
    chrome.scripting
      .executeScript({ target: { tabId: id, allFrames: true }, files: [CONTENT_SCRIPT] })
      .catch(() => undefined);
  }
});

chrome.permissions.onRemoved.addListener(() => void registerGrantedSites());
