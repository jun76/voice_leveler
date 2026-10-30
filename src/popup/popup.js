const elements = {
  site: document.querySelector('#site'),
  status: document.querySelector('#status'),
  toggle: document.querySelector('#toggle'),
  error: document.querySelector('#error'),
  inputMeter: document.querySelector('#input-meter'),
  speechMeter: document.querySelector('#speech-meter'),
  gainMeter: document.querySelector('#gain-meter'),
  speechBar: document.querySelector('#speech-bar'),
  strength: document.querySelector('#strength'),
  sensitivity: document.querySelector('#sensitivity'),
  boost: document.querySelector('#boost'),
  cut: document.querySelector('#cut'),
  bgmSuppression: document.querySelector('#bgm-suppression'),
  strengthValue: document.querySelector('#strength-value'),
  sensitivityValue: document.querySelector('#sensitivity-value'),
  boostValue: document.querySelector('#boost-value'),
  cutValue: document.querySelector('#cut-value'),
};

let activeTab = null;
let currentSettings = null;

function formatDb(value) {
  if (!Number.isFinite(value)) return '-60.0 dB';
  return `${value.toFixed(1)} dB`;
}

function setError(message) {
  elements.error.textContent = message ?? '';
  elements.error.hidden = !message;
}

function renderSettings(settings) {
  currentSettings = settings;
  elements.strength.value = settings.strength;
  elements.sensitivity.value = settings.sensitivityDb;
  elements.boost.value = settings.maxBoostDb;
  elements.cut.value = settings.maxCutDb;
  elements.bgmSuppression.checked = Boolean(settings.bgmSuppression);
  elements.strengthValue.textContent = `${Math.round(settings.strength * 100)}%`;
  elements.sensitivityValue.textContent = `${settings.sensitivityDb} dB`;
  elements.boostValue.textContent = `${settings.maxBoostDb} dB`;
  elements.cutValue.textContent = `${settings.maxCutDb} dB`;
}

function renderState(state) {
  const running = Boolean(state?.running);
  elements.status.textContent = running ? '処理中' : '停止中';
  elements.status.classList.toggle('running', running);
  elements.toggle.textContent = running ? '処理を停止' : '処理を開始';
  elements.toggle.classList.toggle('stop', running);
  setError(state?.error);

  const metrics = state?.metrics;
  if (!metrics) return;
  elements.inputMeter.textContent = formatDb(metrics.inputDb);
  elements.speechMeter.textContent = metrics.speechDetected
    ? formatDb(metrics.speechLevelDb)
    : '未検出';
  elements.gainMeter.textContent = formatDb(metrics.gainDb);
  elements.speechBar.style.width = `${Math.round((metrics.speechScore ?? 0) * 100)}%`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function refresh() {
  activeTab = await getActiveTab();
  const hostname = activeTab?.url ? new URL(activeTab.url).hostname : '';
  elements.site.textContent = hostname || '対象タブを確認できません';
  const response = await chrome.runtime.sendMessage({ type: 'get-state', hostname });
  renderSettings(response.settings);
  renderState(response.state);
}

async function updateSettings() {
  if (!currentSettings || !activeTab?.url) return;
  currentSettings = {
    ...currentSettings,
    strength: Number(elements.strength.value),
    sensitivityDb: Number(elements.sensitivity.value),
    maxBoostDb: Number(elements.boost.value),
    maxCutDb: Number(elements.cut.value),
    bgmSuppression: elements.bgmSuppression.checked,
  };
  renderSettings(currentSettings);
  const hostname = new URL(activeTab.url).hostname;
  const response = await chrome.runtime.sendMessage({
    type: 'update-settings',
    hostname,
    settings: currentSettings,
  });
  if (!response?.ok) setError(response?.error ?? '設定を保存できませんでした。');
}

elements.toggle.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'get-state' });
  if (response.state?.running) {
    await chrome.runtime.sendMessage({ type: 'stop' });
  } else {
    const startResponse = await chrome.runtime.sendMessage({
      type: 'start',
      tabId: activeTab?.id,
    });
    if (!startResponse?.ok) setError(startResponse?.error ?? '処理を開始できませんでした。');
  }
  await refresh();
});

for (const input of [elements.strength, elements.sensitivity, elements.boost, elements.cut]) {
  input.addEventListener('input', updateSettings);
}

elements.bgmSuppression.addEventListener('change', updateSettings);

refresh().catch((error) => setError(error instanceof Error ? error.message : String(error)));
