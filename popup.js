/**
 * popup.js — Extension Popup Controller
 *
 * Permission and Authorization Semantics (verified against Chromium C++ source):
 *
 * 1. Output Device Discovery:
 *    - In Chromium/Brave, an extension popup is an anchored dialog bubble.
 *      Calling getUserMedia() directly inside a toolbar popup triggers
 *      `NotAllowedError: Permission dismissed` because Chromium's PermissionRequestManager
 *      refuses to anchor a permission prompt bubble to another popup dialog.
 *    - To discover physical device names without rejection, clicking "Setup Devices"
 *      opens popup.html in a tab context where the prompt bubble renders cleanly.
 *    - Once granted, permission is permanent for the extension origin
 *      (chrome-extension://<id>) across all future toolbar popups.
 *    - If permission is not yet granted, no fake devices or synthetic IDs are generated.
 *
 * 2. Tab Capture Authorization:
 *    - Under Chromium's activeTab security model (tab_capture_api.cc),
 *      chrome.tabCapture.getMediaStreamId({ targetTabId }) requires the internal
 *      permission `kTabCaptureForTab`, which is only granted to a tab when the user
 *      invokes the extension on that specific tab (e.g. clicking the toolbar action).
 *    - Capturing background tabs that have never been invoked on is strictly forbidden
 *      by Chromium and rejects with:
 *      "Extension has not been invoked for the current page (see activeTab permission)."
 *    - The UI truthfully pre-selects and routes the Current Active Tab.
 *    - To route two tabs, the user opens the extension on Tab 1 to route it,
 *      then opens the extension on Tab 2 to route it. Both run simultaneously
 *      in the offscreen audio engine (up to MAX_ROUTES = 2).
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screens = {
  loading: $('loading-screen'),
  routing: $('routing-screen'),
  error:   $('error-screen')
};

const statusBadge    = $('status-badge');
const infoBanner     = $('info-banner');
const infoText       = $('info-text');
const showNamesBtn   = $('show-names-btn');
const discoveryError = $('discovery-error');
const refreshBtn     = $('refresh-btn');
const errorMessage   = $('error-message');

function showDiscoveryError(msg) {
  if (discoveryError) {
    discoveryError.textContent = msg;
    discoveryError.classList.remove('hidden');
  }
}

function clearDiscoveryError() {
  if (discoveryError) {
    discoveryError.textContent = '';
    discoveryError.classList.add('hidden');
  }
}

const SLOTS = [0, 1];

function slotEl(slot) {
  return {
    card:       $(`route-card-${slot}`),
    tabSelect:  $(`tab-select-${slot}`),
    devSelect:  $(`device-select-${slot}`),
    btn:        $(`route-btn-${slot}`),
    dot:        $(`status-dot-${slot}`),
    statusText: $(`slot-status-text-${slot}`),
    error:      $(`slot-error-${slot}`)
  };
}

// ─── Application State ────────────────────────────────────────────────────────

let activeRoutes       = new Map(); // tabId → route info (mirrored from SW)
let allTabs            = [];        // all queryable tabs
let currentActiveTab   = null;      // active tab in current window
let isStandalonePage   = false;     // true if running as a standalone tab, false if popup
let audioOutputDevices = [];        // [{deviceId, label}] with verified physical IDs
let hasDeviceLabels    = false;     // true when real hardware labels are unlocked

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    console.error('[Popup] Fatal error during init:', err);
    showError(`Failed to initialise: ${err.message}`);
  });
});

async function init() {
  showScreen('loading');

  // Verify required APIs exist (Chrome 116+ needed for offscreen + tabCapture)
  if (
    typeof chrome?.offscreen?.createDocument !== 'function' ||
    typeof chrome?.tabCapture?.getMediaStreamId !== 'function' ||
    typeof navigator?.mediaDevices?.enumerateDevices !== 'function'
  ) {
    showError(
      'This extension requires Chrome 116 or later. ' +
      'Update at chrome://settings/help and reload.'
    );
    return;
  }

  try {
    await Promise.all([loadTabs(), loadDevices(), loadState()]);
  } catch (err) {
    showError(`Failed to load: ${err.message}`);
    return;
  }

  // Handle ?setup=1 query parameter if opened from setup button
  const urlParams = new URLSearchParams(window.location.search);
  const isSetupMode = urlParams.get('setup') === '1';

  renderRouting();
  showScreen('routing');

  if (isSetupMode) {
    if (hasDeviceLabels) {
      infoBanner.classList.remove('hidden');
      if (infoText) {
        infoText.textContent = '✓ Audio devices discovered! You can close this tab and route audio from any tab using the toolbar icon.';
      }
      showNamesBtn.classList.add('hidden');
    } else {
      infoBanner.classList.remove('hidden');
      if (infoText) {
        infoText.textContent = 'Click "Grant Access" below to allow Brave to discover your physical audio output devices.';
      }
      showNamesBtn.textContent = 'Grant Access';
    }
  } else {
    infoBanner.classList.toggle('hidden', hasDeviceLabels);
  }

  bindEvents();
}

async function loadTabs() {
  const [tabs, activeTabs, currentTab] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true }),
    new Promise(res => chrome.tabs.getCurrent(res))
  ]);

  isStandalonePage = Boolean(currentTab);
  currentActiveTab = activeTabs[0] ?? null;

  allTabs = tabs.filter(t =>
    t.id !== undefined &&
    t.url &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('chrome-extension://') &&
    !t.url.startsWith('about:') &&
    !t.url.startsWith('edge://') &&
    !t.url.startsWith('brave://')
  );
}

/**
 * Enumerate audio output devices.
 * Browsers intentionally hide device labels and output IDs until permission
 * is granted to the origin. Only actual physical devices with real hardware
 * labels and valid non-empty deviceIds are populated.
 */
async function loadDevices() {
  let rawDevices;
  try {
    rawDevices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    throw new Error(`enumerateDevices() failed: ${err.message}`);
  }

  // Filter for audio outputs that have non-empty labels.
  // In Chromium/Brave, device labels and IDs are blank until permission is granted to the origin.
  const validOutputs = rawDevices.filter(d => d.kind === 'audiooutput' && d.label && d.label.trim().length > 0);

  hasDeviceLabels = validOutputs.length > 0;

  if (hasDeviceLabels) {
    audioOutputDevices = validOutputs.map(d => ({
      deviceId: d.deviceId || 'default',
      label: d.label
    }));
  } else {
    // Permission not yet granted — browser has stripped all device IDs and labels for privacy.
    // Never create fake device IDs or generic placeholders.
    audioOutputDevices = [];
  }
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  activeRoutes = new Map((response.routes ?? []).map(r => [r.tabId, r]));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function getRouteForSlot(slot) {
  for (const route of activeRoutes.values()) {
    if (route.slot === slot) return route;
  }
  // Fallback for any legacy route that did not have slot explicitly recorded
  const unassigned = [...activeRoutes.values()].filter(r => r.slot === undefined);
  if (unassigned.length > 0) {
    const otherSlot = slot === 0 ? 1 : 0;
    const otherHasRoute = [...activeRoutes.values()].some(r => r.slot === otherSlot);
    if (slot === 0 && !otherHasRoute) return unassigned[0];
    if (slot === 1 && otherHasRoute) return unassigned[0];
  }
  return null;
}

function renderRouting() {
  SLOTS.forEach(slot => {
    const route = getRouteForSlot(slot);
    renderSlot(slot, route);
  });

  const n = activeRoutes.size;
  statusBadge.textContent = n > 0 ? `${n} Active` : 'Idle';
  statusBadge.className   = `status-badge ${n > 0 ? 'status-active' : 'status-idle'}`;
}

function renderSlot(slot, route) {
  const el = slotEl(slot);
  clearSlotError(slot);

  if (route) {
    // ── Active Slot ────────────────────────────────────────────────────────
    el.card.classList.add('is-active');
    el.dot.classList.add('dot-active');
    el.statusText.textContent = `→ ${truncate(route.deviceLabel, 24)}`;
    el.statusText.className   = 'slot-status-text text-active';

    el.tabSelect.innerHTML = `<option value="${route.tabId}">${escHtml(truncate(route.tabTitle, 44))}</option>`;
    el.devSelect.innerHTML = `<option value="${route.deviceId}">${escHtml(truncate(route.deviceLabel, 44))}</option>`;
    el.tabSelect.disabled  = true;
    el.devSelect.disabled  = true;

    el.btn.textContent = 'Stop Routing';
    el.btn.className   = 'btn btn-danger';
    el.btn.disabled    = false;

  } else {
    // ── Idle Slot ──────────────────────────────────────────────────────────
    el.card.classList.remove('is-active');
    el.dot.classList.remove('dot-active');

    // Target the first idle slot to route currentActiveTab (Slot 0 if idle, else Slot 1)
    const targetIdleSlot = (!getRouteForSlot(0)) ? 0 : 1;
    const isTargetIdleSlot = (slot === targetIdleSlot);

    populateTabSelect(slot, el.tabSelect, isTargetIdleSlot);
    populateDeviceSelect(el.devSelect);

    el.btn.textContent = 'Start Routing';
    el.btn.className   = 'btn btn-primary';

    if (isTargetIdleSlot) {
      const isAlreadyRouted = currentActiveTab && activeRoutes.has(currentActiveTab.id);
      if (isAlreadyRouted) {
        el.devSelect.disabled = true;
        el.statusText.textContent = 'Tab already routed';
        el.statusText.className   = 'slot-status-text';
      } else {
        el.devSelect.disabled = (audioOutputDevices.length === 0);
        el.statusText.textContent = 'Ready to route';
        el.statusText.className   = 'slot-status-text';
      }
    } else {
      // Secondary idle slot: waiting for user to switch tabs
      el.devSelect.disabled = true;
      el.statusText.textContent = `Waiting for Tab ${slot + 1}`;
      el.statusText.className   = 'slot-status-text';
    }

    updateStartButton(slot);
  }
}

/**
 * Populate the tab selector according to Chromium's authorization model.
 * In Manifest V3 with activeTab, only the currently active tab where the
 * extension was invoked has kTabCaptureForTab authorization.
 * Background tabs are NEVER displayed as selectable options because the
 * browser will reject them with "Extension has not been invoked".
 */
function populateTabSelect(slot, select, isTargetIdleSlot) {
  let html = '';

  if (isStandalonePage) {
    html = '<option value="" disabled>To route, open extension on the target tab</option>';
    select.innerHTML = html;
    select.disabled = true;
    if (isTargetIdleSlot) {
      showSlotError(slot, 'This page is for device setup. To route audio, open any tab and click the extension icon in your toolbar.');
    }
    return;
  }

  if (!isTargetIdleSlot) {
    html = `<option value="" disabled>Switch to another tab to route in Route ${slot + 1}</option>`;
    select.innerHTML = html;
    select.disabled = true;
    return;
  }

  if (!currentActiveTab || !currentActiveTab.id) {
    html = '<option value="" disabled>No active tab detected</option>';
    select.innerHTML = html;
    select.disabled = true;
    return;
  }

  const isInternalUrl = !currentActiveTab.url ||
    currentActiveTab.url.startsWith('chrome://') ||
    currentActiveTab.url.startsWith('chrome-extension://') ||
    currentActiveTab.url.startsWith('about:') ||
    currentActiveTab.url.startsWith('brave://') ||
    currentActiveTab.url.startsWith('edge://');

  if (isInternalUrl) {
    html = '<option value="" disabled>Internal browser page cannot be routed</option>';
    select.innerHTML = html;
    select.disabled = true;
    showSlotError(slot, 'Internal browser pages cannot be captured. Switch to a web page (e.g. YouTube) and click the extension icon.');
    return;
  }

  // Check if current active tab is already routed
  if (activeRoutes.has(currentActiveTab.id)) {
    const existingRoute = activeRoutes.get(currentActiveTab.id);
    html = `<option value="" disabled>Current tab already routed (${escHtml(truncate(existingRoute.deviceLabel, 20))})</option>`;
    select.innerHTML = html;
    select.disabled = true;
    showSlotError(slot, `This tab is already being routed. Switch to another tab to route Route ${slot + 1}.`);
    return;
  }

  // The current active tab is available and authorized
  clearSlotError(slot);
  html = `<option value="${currentActiveTab.id}" selected>Current Tab: ${escHtml(truncate(tabDisplayName(currentActiveTab), 42))}</option>`;

  select.innerHTML = html;
  select.value = String(currentActiveTab.id);
  select.disabled = true; // Pre-selected and locked to current tab; user cannot select unroutable background tabs
}

function populateDeviceSelect(select) {
  const selectedBefore = select.value;
  let html = '<option value="">Select device…</option>';
  if (audioOutputDevices.length === 0) {
    html = '<option value="">Click "Setup Devices" above</option>';
  } else {
    audioOutputDevices.forEach(d => {
      html += `<option value="${d.deviceId}">${escHtml(truncate(d.label, 50))}</option>`;
    });
  }
  select.innerHTML = html;
  if (selectedBefore && audioOutputDevices.some(d => d.deviceId === selectedBefore)) {
    select.value = selectedBefore;
  }
}

function updateStartButton(slot) {
  const el = slotEl(slot);
  if (el.btn.classList.contains('btn-danger')) return; // active slot with Stop Routing
  const tabId = getSelectedTabId(slot);
  const deviceId = el.devSelect.value;
  const isAlreadyRouted = tabId ? activeRoutes.has(tabId) : false;
  el.btn.disabled = !tabId || isAlreadyRouted || !deviceId || audioOutputDevices.length === 0;
}

// ─── Event Binding ────────────────────────────────────────────────────────────

function bindEvents() {
  showNamesBtn?.addEventListener('click', async () => {
    clearDiscoveryError();

    // If running in a popup and selectAudioOutput is not available, open setup in a tab
    // to avoid Chromium's PERMISSION_DISMISSED rejection on popup bubbles.
    if (!isStandalonePage && typeof navigator?.mediaDevices?.selectAudioOutput !== 'function') {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?setup=1') });
      return;
    }

    showNamesBtn.disabled    = true;
    showNamesBtn.textContent = 'Discovering…';

    // 1. Prefer explicit audio output selection if supported
    if (typeof navigator?.mediaDevices?.selectAudioOutput === 'function') {
      try {
        await navigator.mediaDevices.selectAudioOutput();
        await loadDevices();
        renderRouting();
        showNamesBtn.disabled    = false;
        showNamesBtn.textContent = 'Setup Devices';
        infoBanner.classList.toggle('hidden', hasDeviceLabels);
        return;
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          showNamesBtn.disabled    = false;
          showNamesBtn.textContent = 'Setup Devices';
          showDiscoveryError(`Audio output selection dismissed: ${err.message}`);
          return;
        }
        console.warn('[Popup] selectAudioOutput unsupported or failed, falling back:', err);
      }
    }

    // 2. getUserMedia in tab context to unlock enumerateDevices() labels
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      console.error('[Popup] Audio permission error:', err);
      showNamesBtn.disabled    = false;
      showNamesBtn.textContent = 'Setup Devices';
      const exactErr = `${err.name}: ${err.message || 'Permission denied or dismissed'}`;
      let guidance = exactErr;
      if (err.name === 'NotAllowedError') {
        guidance += '. Permission was dismissed. Check brave://settings/content/microphone.';
      }
      showDiscoveryError(guidance);
      return;
    } finally {
      stream?.getTracks().forEach(t => t.stop());
    }

    try {
      await loadDevices();
    } catch (err) {
      console.error('[Popup] loadDevices error:', err);
      showNamesBtn.disabled    = false;
      showNamesBtn.textContent = 'Setup Devices';
      showDiscoveryError(`Device enumeration error: ${err.name} — ${err.message}`);
      return;
    }

    showNamesBtn.disabled    = false;
    showNamesBtn.textContent = 'Setup Devices';

    renderRouting();
    if (isStandalonePage && hasDeviceLabels) {
      infoBanner.classList.remove('hidden');
      if (infoText) {
        infoText.textContent = '✓ Audio devices discovered! You can now close this tab and route audio from any tab using the toolbar icon.';
      }
      showNamesBtn.classList.add('hidden');
    } else {
      infoBanner.classList.toggle('hidden', hasDeviceLabels);
    }
  });

  refreshBtn?.addEventListener('click', async () => {
    refreshBtn.disabled    = true;
    refreshBtn.textContent = '↺ Refreshing…';
    try {
      await Promise.all([loadTabs(), loadDevices(), loadState()]);
      renderRouting();
      infoBanner.classList.toggle('hidden', hasDeviceLabels);
    } finally {
      refreshBtn.disabled    = false;
      refreshBtn.textContent = '↺ Refresh';
    }
  });

  SLOTS.forEach(slot => {
    const el = slotEl(slot);
    el.tabSelect.addEventListener('change', () => updateStartButton(slot));
    el.devSelect.addEventListener('change', () => updateStartButton(slot));
    el.btn.addEventListener('click', () => {
      if (el.btn.classList.contains('btn-danger')) {
        handleStop(slot);
      } else {
        handleStart(slot);
      }
    });
  });

  // Re-enumerate when a device is plugged/unplugged
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await loadDevices();
    renderRouting();
    infoBanner.classList.toggle('hidden', hasDeviceLabels);
  });
}

// ─── Routing Actions ──────────────────────────────────────────────────────────

async function handleStart(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  const tabId    = getSelectedTabId(slot);
  const deviceId = el.devSelect.value;

  if (!tabId || !deviceId) {
    showSlotError(slot, 'Select both a tab and an output device first.');
    return;
  }

  const tab         = allTabs.find(t => t.id === tabId) || currentActiveTab;
  const device      = audioOutputDevices.find(d => d.deviceId === deviceId);
  const tabTitle    = tab?.title    || `Tab ${tabId}`;
  const deviceLabel = device?.label || `Device (${deviceId.slice(0, 8)}…)`;

  el.btn.disabled    = true;
  el.btn.textContent = 'Capturing…';

  // Step 1: obtain the stream ID from the tab capture API
  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch (err) {
    if (err.message && err.message.includes('Extension has not been invoked')) {
      showSlotError(slot,
        `Browser security requires opening the extension directly on "${truncate(tabTitle, 22)}". ` +
        `Switch to that tab and click the extension icon to route it.`
      );
    } else {
      showSlotError(slot,
        `Could not capture audio: ${err.message}. Ensure the tab is playing audio and retry.`
      );
    }
    el.btn.disabled    = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  // Step 2: hand off to service worker → offscreen audio engine
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'START_ROUTING',
      tabId, streamId, deviceId, deviceLabel, tabTitle,
      tabUrl: tab?.url || '',
      slot
    });
  } catch (err) {
    showSlotError(slot, `Extension error: ${err.message}`);
    el.btn.disabled    = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  if (!result?.success) {
    showSlotError(slot, result?.error ?? 'Unknown error. Please try again.');
    el.btn.disabled    = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  // Update local mirror and re-render
  activeRoutes.set(tabId, { tabId, streamId, deviceId, deviceLabel, tabTitle, slot });
  renderRouting();
}

async function handleStop(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  const route = getRouteForSlot(slot);
  if (!route) return;

  el.btn.disabled    = true;
  el.btn.textContent = 'Stopping…';

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'STOP_ROUTING', tabId: route.tabId });
  } catch (err) {
    showSlotError(slot, `Extension error: ${err.message}`);
    el.btn.disabled    = false;
    el.btn.textContent = 'Stop Routing';
    return;
  }

  if (!result?.success) {
    showSlotError(slot, result?.error ?? 'Could not stop routing. Try clicking Refresh.');
    el.btn.disabled    = false;
    el.btn.textContent = 'Stop Routing';
    return;
  }

  activeRoutes.delete(route.tabId);
  renderRouting();
}

// ─── tabCapture Helper ────────────────────────────────────────────────────────

/**
 * Wrap chrome.tabCapture.getMediaStreamId in a Promise.
 * Must be called from a user-gesture handler on an invoked tab.
 */
function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, streamId => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!streamId) {
        reject(new Error('Tab capture was denied or returned an empty stream ID'));
      } else {
        resolve(streamId);
      }
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function showScreen(name) {
  Object.keys(screens).forEach(k => screens[k].classList.toggle('hidden', k !== name));
}

function showError(msg) {
  if (errorMessage) errorMessage.textContent = msg;
  showScreen('error');
}

function showSlotError(slot, msg) {
  const el = slotEl(slot).error;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearSlotError(slot) {
  const el = slotEl(slot).error;
  el.textContent = '';
  el.classList.add('hidden');
}

function getSelectedTabId(slot) {
  const val = slotEl(slot).tabSelect.value;
  return val ? parseInt(val, 10) : null;
}

function tabDisplayName(tab) {
  return tab.title || tab.url || `Tab ${tab.id}`;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function escHtml(str) {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
