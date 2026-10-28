/**
 * popup.js — Extension Popup Controller
 *
 * Responsibilities:
 * - Render and manage routing slots for up to 2 tabs.
 * - Enumerate and populate audio output devices (Default, Speakers, Bluetooth).
 * - Handle physical device discovery and permission unlock via modal popup.
 * - Live volume control (0-100%) without restarting audio capture.
 * - Validate Chromium tabCapture activeTab security model.
 */

'use strict';

// ─── Grant Window Mode (Modal Permission Prompt) ─────────────────────────────

if (window.location.search.includes('grant=1')) {
  initGrantWindow();
} else {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}

function initGrantWindow() {
  document.addEventListener('DOMContentLoaded', () => {
    // Show only the grant screen
    ['loading-screen', 'routing-screen', 'error-screen'].forEach(id => {
      document.getElementById(id)?.classList.add('hidden');
    });
    const grantScreen = document.getElementById('grant-screen');
    grantScreen?.classList.remove('hidden');

    const grantBtn = document.getElementById('grant-btn');
    const grantStatus = document.getElementById('grant-status');

    async function requestAccess() {
      if (grantBtn) {
        grantBtn.disabled = true;
        grantBtn.textContent = 'Requesting…';
      }
      if (grantStatus) grantStatus.textContent = 'Please click "Allow" on the browser prompt…';

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        if (grantStatus) grantStatus.textContent = '✓ Access granted! Detecting devices…';
        setTimeout(() => window.close(), 400);
      } catch (err) {
        if (grantStatus) grantStatus.textContent = 'Permission was dismissed. Click button above to retry.';
        if (grantBtn) {
          grantBtn.disabled = false;
          grantBtn.textContent = 'Allow & Detect Devices';
        }
      }
    }

    grantBtn?.addEventListener('click', requestAccess);
    // Automatically trigger prompt on load
    requestAccess();
  });
}

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screens = {
  loading: $('loading-screen'),
  routing: $('routing-screen'),
  error:   $('error-screen'),
  grant:   $('grant-screen')
};

const statusBadge      = $('status-badge');
const infoBanner       = $('info-banner');
const infoText         = $('info-text');
const unlockDevicesBtn = $('unlock-devices-btn');
const showNamesBtn     = $('show-names-btn');
const discoveryError   = $('discovery-error');
const refreshBtn       = $('refresh-btn');
const errorMessage     = $('error-message');

const SLOTS = [0, 1];

function slotEl(slot) {
  return {
    card:         $(`route-card-${slot}`),
    tabSelect:    $(`tab-select-${slot}`),
    devSelect:    $(`device-select-${slot}`),
    volumeSlider: $(`volume-slider-${slot}`),
    volumeValue:  $(`volume-value-${slot}`),
    btn:          $(`route-btn-${slot}`),
    dot:          $(`status-dot-${slot}`),
    statusText:   $(`slot-status-text-${slot}`),
    error:        $(`slot-error-${slot}`)
  };
}

// ─── Application State ────────────────────────────────────────────────────────

let activeRoutes       = new Map(); // tabId → route info
let allTabs            = [];        // all queryable tabs
let currentActiveTab   = null;      // active tab in current window
let audioOutputDevices = [];        // [{deviceId, label}] with verified physical IDs
let hasDeviceLabels    = false;     // true when real hardware labels are unlocked

// ─── Main Initialization ──────────────────────────────────────────────────────

async function initApp() {
  showScreen('loading');

  if (
    typeof chrome?.offscreen?.createDocument !== 'function' ||
    typeof chrome?.tabCapture?.getMediaStreamId !== 'function' ||
    typeof navigator?.mediaDevices?.enumerateDevices !== 'function'
  ) {
    showError('This extension requires Chrome 116 or later. Please update your browser.');
    return;
  }

  try {
    await Promise.all([loadTabs(), loadDevices(), loadState()]);
  } catch (err) {
    showError(`Failed to load: ${err.message}`);
    return;
  }

  renderRouting();
  showScreen('routing');
  bindEvents();
}

async function loadTabs() {
  const [tabs, activeTabsLastFocused, activeTabsCurrent] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);

  currentActiveTab = activeTabsLastFocused[0] || activeTabsCurrent[0] || null;

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
 * Extracts physical devices (e.g. MacBook Speakers, Bluetooth headphones)
 * and formats clean labels with system default fallback.
 */
async function loadDevices() {
  let rawDevices;
  try {
    rawDevices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    throw new Error(`enumerateDevices() failed: ${err.message}`);
  }

  const rawOutputs = rawDevices.filter(d => d.kind === 'audiooutput');
  const labeledOutputs = rawOutputs.filter(d => d.label && d.label.trim().length > 0);

  hasDeviceLabels = labeledOutputs.length > 0;

  if (hasDeviceLabels) {
    const physicalDevices = [];
    let defaultLabel = 'System Default Output';

    for (const dev of labeledOutputs) {
      if (dev.deviceId === 'default') {
        defaultLabel = dev.label.startsWith('Default - ')
          ? `System Default (${dev.label.replace('Default - ', '')})`
          : (dev.label || 'System Default Output');
      } else {
        if (!physicalDevices.some(p => p.deviceId === dev.deviceId)) {
          physicalDevices.push({
            deviceId: dev.deviceId,
            label: dev.label
          });
        }
      }
    }

    // Sort physical devices so Built-in Speakers come first, Bluetooth next
    physicalDevices.sort((a, b) => {
      const aIsSpeaker = /speaker|built-in|internal/i.test(a.label);
      const bIsSpeaker = /speaker|built-in|internal/i.test(b.label);
      if (aIsSpeaker && !bIsSpeaker) return -1;
      if (!aIsSpeaker && bIsSpeaker) return 1;
      return a.label.localeCompare(b.label);
    });

    audioOutputDevices = [
      ...physicalDevices,
      { deviceId: 'default', label: defaultLabel }
    ];
  } else {
    audioOutputDevices = [
      {
        deviceId: 'default',
        label: 'System Default Output'
      }
    ];
  }
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  activeRoutes = new Map((response?.routes ?? []).map(r => [r.tabId, r]));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function getRouteForSlot(slot) {
  for (const route of activeRoutes.values()) {
    if (route.slot === slot) return route;
  }
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
  if (statusBadge) {
    statusBadge.textContent = n > 0 ? `${n} Active` : 'Idle';
    statusBadge.className   = `status-badge ${n > 0 ? 'status-active' : 'status-idle'}`;
  }

  updateDeviceModeBanner();
}

function updateDeviceModeBanner() {
  if (!infoBanner || !infoText) return;

  if (hasDeviceLabels && audioOutputDevices.length > 1) {
    infoBanner.className = 'info-banner info-banner-success';
    infoText.textContent = `Multi-Device Mode: ${audioOutputDevices.length} outputs detected. Assign separate outputs to Route 1 and Route 2.`;
    unlockDevicesBtn?.classList.add('hidden');
    if (showNamesBtn) {
      showNamesBtn.classList.remove('hidden');
      showNamesBtn.textContent = '↺ Refresh';
    }
  } else {
    infoBanner.className = 'info-banner info-banner-warning';
    infoText.textContent = 'Default Output Mode: Audio routes to System Default. To route to MacBook Speakers & Bluetooth separately, click Show Connected Devices.';
    unlockDevicesBtn?.classList.remove('hidden');
    if (showNamesBtn) {
      showNamesBtn.classList.remove('hidden');
      showNamesBtn.textContent = '↺ Refresh Devices';
    }
  }
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

    const vol = (typeof route.volume === 'number' && !isNaN(route.volume)) ? route.volume : 100;
    el.volumeSlider.value = vol;
    el.volumeValue.textContent = `${vol}%`;
    el.volumeSlider.disabled = false;

    el.btn.textContent = 'Stop Routing';
    el.btn.className   = 'btn btn-danger';
    el.btn.disabled    = false;

  } else {
    // ── Idle Slot ──────────────────────────────────────────────────────────
    el.card.classList.remove('is-active');
    el.dot.classList.remove('dot-active');

    const targetIdleSlot = (!getRouteForSlot(0)) ? 0 : 1;
    const isTargetIdleSlot = (slot === targetIdleSlot);

    populateTabSelect(slot, el.tabSelect, isTargetIdleSlot);
    populateDeviceSelect(slot, el.devSelect);

    el.btn.textContent = 'Start Routing';
    el.btn.className   = 'btn btn-primary';
    el.devSelect.disabled = (audioOutputDevices.length === 0);

    if (isTargetIdleSlot) {
      const isAlreadyRouted = currentActiveTab && activeRoutes.has(currentActiveTab.id);
      if (isAlreadyRouted) {
        el.devSelect.disabled = true;
        el.statusText.textContent = 'Tab already routed';
      } else {
        el.statusText.textContent = 'Ready to route';
      }
      el.volumeSlider.disabled = false;
      if (!el.volumeSlider.dataset.userModified) {
        el.volumeSlider.value = 100;
        el.volumeValue.textContent = '100%';
      }
    } else {
      el.volumeSlider.disabled = true;
      el.statusText.textContent = `Waiting for Tab ${slot + 1}`;
    }
    el.statusText.className = 'slot-status-text';

    updateStartButton(slot);
  }
}

function populateTabSelect(slot, select, isTargetIdleSlot) {
  if (!isTargetIdleSlot) {
    select.innerHTML = `<option value="" disabled>Switch to another tab to route in Route ${slot + 1}</option>`;
    select.disabled = true;
    return;
  }

  if (!currentActiveTab || !currentActiveTab.id) {
    select.innerHTML = '<option value="" disabled>No active tab detected</option>';
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
    select.innerHTML = '<option value="" disabled>Internal browser page cannot be routed</option>';
    select.disabled = true;
    showSlotError(slot, 'Internal browser pages cannot be captured. Switch to a web page (e.g. YouTube) and click the extension icon.');
    return;
  }

  if (activeRoutes.has(currentActiveTab.id)) {
    const existingRoute = activeRoutes.get(currentActiveTab.id);
    select.innerHTML = `<option value="" disabled>Current tab already routed (${escHtml(truncate(existingRoute.deviceLabel, 20))})</option>`;
    select.disabled = true;
    showSlotError(slot, `This tab is already being routed. Switch to another tab to route Route ${slot + 1}.`);
    return;
  }

  clearSlotError(slot);
  select.innerHTML = `<option value="${currentActiveTab.id}" selected>Current Tab: ${escHtml(truncate(tabDisplayName(currentActiveTab), 42))}</option>`;
  select.value = String(currentActiveTab.id);
  select.disabled = true;
}

function populateDeviceSelect(slot, select) {
  const selectedBefore = select.value;
  let html = '';
  if (audioOutputDevices.length === 0) {
    html = '<option value="">No audio outputs detected</option>';
  } else {
    audioOutputDevices.forEach(d => {
      html += `<option value="${d.deviceId}">${escHtml(truncate(d.label, 50))}</option>`;
    });
  }
  select.innerHTML = html;

  if (selectedBefore && audioOutputDevices.some(d => d.deviceId === selectedBefore)) {
    select.value = selectedBefore;
  } else if (audioOutputDevices.length > 0) {
    if (slot === 1 && audioOutputDevices.length > 1) {
      // Slot 1 defaults to the bluetooth or second device
      const bluetoothDev = audioOutputDevices.find(d => /bluetooth|headphone|boult|airpods|buds/i.test(d.label));
      if (bluetoothDev && bluetoothDev.deviceId !== 'default') {
        select.value = bluetoothDev.deviceId;
      } else {
        select.value = audioOutputDevices[1].deviceId;
      }
    } else {
      // Slot 0 defaults to the first device (e.g. MacBook Air Speakers)
      select.value = audioOutputDevices[0].deviceId;
    }
  }
}

function updateStartButton(slot) {
  const el = slotEl(slot);
  if (el.btn.classList.contains('btn-danger')) return;
  const tabId = getSelectedTabId(slot);
  const deviceId = el.devSelect.value;
  const isAlreadyRouted = tabId ? activeRoutes.has(tabId) : false;
  el.btn.disabled = !tabId || isAlreadyRouted || !deviceId || audioOutputDevices.length === 0;
}

// ─── Modal Unlock Dialog ──────────────────────────────────────────────────────

async function openDeviceUnlockDialog() {
  if (typeof chrome?.windows?.create !== 'function') {
    await loadDevices();
    renderRouting();
    return;
  }

  if (unlockDevicesBtn) {
    unlockDevicesBtn.disabled = true;
    unlockDevicesBtn.textContent = 'Opening…';
  }

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?grant=1'),
      type: 'popup',
      width: 380,
      height: 260,
      focused: true
    });

    const timer = setInterval(async () => {
      try {
        const existing = await chrome.windows.get(win.id);
        if (!existing) throw new Error();
      } catch (_) {
        clearInterval(timer);
        await loadDevices();
        renderRouting();
      }
    }, 300);
  } catch (err) {
    console.warn('[Popup] Error opening unlock window:', err);
    await loadDevices();
    renderRouting();
  } finally {
    if (unlockDevicesBtn) {
      unlockDevicesBtn.disabled = false;
      unlockDevicesBtn.textContent = '🎧 Show Connected Devices';
    }
  }
}

// ─── Event Binding ────────────────────────────────────────────────────────────

function bindEvents() {
  unlockDevicesBtn?.addEventListener('click', openDeviceUnlockDialog);

  showNamesBtn?.addEventListener('click', async () => {
    showNamesBtn.disabled    = true;
    showNamesBtn.textContent = 'Refreshing…';
    try {
      await loadDevices();
      renderRouting();
    } catch (err) {
      console.warn('[Popup] Refresh note:', err);
    } finally {
      showNamesBtn.disabled    = false;
      showNamesBtn.textContent = hasDeviceLabels ? '↺ Refresh' : '↺ Refresh Devices';
    }
  });

  refreshBtn?.addEventListener('click', async () => {
    refreshBtn.disabled    = true;
    refreshBtn.textContent = '↺ Refreshing…';
    try {
      await Promise.all([loadTabs(), loadDevices(), loadState()]);
      renderRouting();
    } finally {
      refreshBtn.disabled    = false;
      refreshBtn.textContent = '↺ Refresh';
    }
  });

  SLOTS.forEach(slot => {
    const el = slotEl(slot);
    el.tabSelect.addEventListener('change', () => updateStartButton(slot));
    el.devSelect.addEventListener('change', () => updateStartButton(slot));

    el.volumeSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      el.volumeValue.textContent = `${val}%`;
      el.volumeSlider.dataset.userModified = 'true';
      const route = getRouteForSlot(slot);
      if (route && route.tabId) {
        chrome.runtime.sendMessage({
          type: 'SET_VOLUME',
          tabId: route.tabId,
          volume: val
        }).then(res => {
          if (res?.success) route.volume = val;
        }).catch(err => console.warn('[Popup] Volume error:', err));
      }
    });

    el.btn.addEventListener('click', () => {
      if (el.btn.classList.contains('btn-danger')) {
        handleStop(slot);
      } else {
        handleStart(slot);
      }
    });
  });

  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await loadDevices();
    renderRouting();
  });
}

// ─── Routing Actions ──────────────────────────────────────────────────────────

async function handleStart(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  const tabId    = getSelectedTabId(slot);
  const deviceId = el.devSelect.value;
  const volume   = parseInt(el.volumeSlider?.value ?? '100', 10);

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

  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch (err) {
    showSlotError(slot, `Could not capture audio [tabCapture stage]: ${err.message}`);
    el.btn.disabled    = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'START_ROUTING',
      tabId, streamId, deviceId, deviceLabel, tabTitle,
      tabUrl: tab?.url || '',
      slot,
      volume
    });
  } catch (err) {
    showSlotError(slot, `Extension error [handoff stage]: ${err.message}`);
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

  activeRoutes.set(tabId, { tabId, streamId, deviceId, deviceLabel, tabTitle, slot, volume });
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
    showSlotError(slot, result?.error ?? 'Could not stop routing.');
    el.btn.disabled    = false;
    el.btn.textContent = 'Stop Routing';
    return;
  }

  activeRoutes.delete(route.tabId);
  renderRouting();
}

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
  Object.keys(screens).forEach(k => screens[k]?.classList.toggle('hidden', k !== name));
}

function showError(msg) {
  if (errorMessage) errorMessage.textContent = msg;
  showScreen('error');
}

function showSlotError(slot, msg) {
  const el = slotEl(slot).error;
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

function clearSlotError(slot) {
  const el = slotEl(slot).error;
  if (el) {
    el.textContent = '';
    el.classList.add('hidden');
  }
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
