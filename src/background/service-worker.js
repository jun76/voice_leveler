import { DEFAULT_SETTINGS as AUDIO_DEFAULT_SETTINGS } from '../audio/heuristics.js';

const DEFAULT_SETTINGS = { ...AUDIO_DEFAULT_SETTINGS };

let runtimeState = {
  running: false,
  tabId: null,
  hostname: null,
  metrics: null,
  error: null,
};

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('src/offscreen/offscreen.html')],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: '配信タブの音声を処理して再生するため',
  });
}

async function getStoredSettings(hostname) {
  const stored = await chrome.storage.local.get('settingsByHostname');
  return {
    ...DEFAULT_SETTINGS,
    ...(stored.settingsByHostname?.[hostname] ?? {}),
  };
}

async function saveSettings(hostname, settings) {
  const stored = await chrome.storage.local.get('settingsByHostname');
  const settingsByHostname = stored.settingsByHostname ?? {};
  settingsByHostname[hostname] = { ...settings };
  await chrome.storage.local.set({ settingsByHostname });
}

async function startForTab(tab) {
  if (!tab?.id) throw new Error('対象タブを取得できませんでした。');
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error('httpまたはhttpsのページで実行してください。');
  }

  await ensureOffscreenDocument();
  const hostname = new URL(tab.url).hostname;
  const settings = await getStoredSettings(hostname);
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  runtimeState = {
    running: true,
    tabId: tab.id,
    hostname,
    metrics: null,
    error: null,
  };
  await chrome.storage.session.set({ runtimeState });
  await chrome.runtime.sendMessage({
    type: 'start-audio',
    streamId,
    settings,
  });
}

async function stopProcessing() {
  try {
    await chrome.runtime.sendMessage({ type: 'stop-audio' });
  } catch {
    // Offscreen Documentがすでに終了している場合は停止済みとして扱う。
  }
  runtimeState = {
    running: false,
    tabId: null,
    hostname: null,
    metrics: null,
    error: null,
  };
  await chrome.storage.session.set({ runtimeState });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ runtimeState });
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (runtimeState.running) {
      await stopProcessing();
      return;
    }
    await startForTab(tab);
  } catch (error) {
    runtimeState = {
      ...runtimeState,
      running: false,
      error: error instanceof Error ? error.message : String(error),
    };
    await chrome.storage.session.set({ runtimeState });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (runtimeState.running && runtimeState.tabId === tabId) {
    await stopProcessing();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'offscreen-meter') {
    runtimeState = { ...runtimeState, metrics: message.metrics };
    chrome.storage.session.set({ runtimeState });
    return false;
  }

  if (message.type === 'offscreen-status') {
    if (message.status === 'stopped') {
      runtimeState = {
        running: false,
        tabId: null,
        hostname: null,
        metrics: null,
        error: message.error ?? null,
      };
      chrome.storage.session.set({ runtimeState });
    }
    return false;
  }

  if (message.type === 'get-state') {
    Promise.resolve().then(async () => {
      const stored = await chrome.storage.session.get('runtimeState');
      sendResponse({
        state: stored.runtimeState ?? runtimeState,
        settings: message.hostname ? await getStoredSettings(message.hostname) : DEFAULT_SETTINGS,
      });
    });
    return true;
  }

  if (message.type === 'stop') {
    stopProcessing().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'start') {
    chrome.tabs.get(message.tabId)
      .then((tab) => startForTab(tab))
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        runtimeState = {
          ...runtimeState,
          running: false,
          error: error instanceof Error ? error.message : String(error),
        };
        await chrome.storage.session.set({ runtimeState });
        sendResponse({ ok: false, error: runtimeState.error });
      });
    return true;
  }

  if (message.type === 'update-settings') {
    const hostname = message.hostname ?? runtimeState.hostname;
    const settings = { ...DEFAULT_SETTINGS, ...(message.settings ?? {}) };
    saveSettings(hostname, settings)
      .then(async () => {
        if (runtimeState.running) {
          await chrome.runtime.sendMessage({ type: 'update-settings', settings });
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
