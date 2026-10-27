/**
 * popup.js — Extension Popup Controller
 *
 * Responsibilities:
 * - Detect and handle the first-run microphone permission grant
 * - Enumerate audio output devices for the device selectors
 * - Query all browser tabs and populate tab selectors
 * - Synchronise UI state with the service worker's routing state
 * - Initiate and stop audio routing via chrome.tabCapture + SW messages
 * - Display actionable errors per-slot and globally
 * - Auto-refresh device/tab lists on popup open
 *
 * Architecture note:
 * chrome.tabCapture.getMediaStreamId() is called HERE (in the popup),
 * not in the service worker. The popup is a user-facing window with
 * explicit user-gesture context (button click), which satisfies Chrome's
 * requirement for tabCapture API calls. The resulting streamId is then
 * passed to the SW, which forwards it to the offscreen audio engine.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screens = {
  loading:    $('loading-screen'),
  permission: $('permission-screen'),
  routing:    $('routing-screen'),
  error:      $('error-screen')
};

const statusBadge          = $('status-badge');
const grantPermissionBtn   = $('grant-permission-btn');
const permissionError      = $('permission-error');
const refreshBtn           = $('refresh-btn');
const errorMessage         = $('error-message');

// Per-slot elements (indexed 0 and 1)
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

/** tabId → route info map, mirrored from SW state */
let activeRoutes = new Map();

/** All browser tabs (non-extension) */
let allTabs = [];

/** Available audio output devices */
let audioOutputDevices = [];

/** Whether mic permission has been granted */
let hasPermission = false;

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    console.error('[Popup] Fatal init error:', err);
    showError(`Initialisation failed: ${err.message}`);
  });
});

async function init() {
  showScreen('loading');

  // ── Guard: minimum Chrome version ──────────────────────────────────────
  if (!chrome.offscreen || !chrome.tabCapture?.getMediaStreamId) {
    showError(
      'This extension requires Chrome 116 or later. ' +
      'Please update your browser and reload the extension.'
    );
    return;
  }

  // ── Check / request permission ─────────────────────────────────────────
  hasPermission = await checkPermission();

  if (!hasPermission) {
    showScreen('permission');
    return;
  }

  // ── Load data and render ───────────────────────────────────────────────
  await loadAll();
  renderRouting();
  showScreen('routing');

  // ── Wire up event listeners ────────────────────────────────────────────
  bindEvents();
}

// ─── Permission Handling ──────────────────────────────────────────────────────

/**
 * Check if microphone permission is already granted.
 * We detect this by calling enumerateDevices and checking whether
 * audio output device labels are populated (they're empty without permission).
 */
async function checkPermission() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some(d => d.kind === 'audiooutput' && d.label && d.label.length > 0);
  } catch (_) {
    return false;
  }
}

/**
 * Request microphone permission by calling getUserMedia.
 * Tracks are stopped immediately — we only need the permission grant.
 * This must be called from a user gesture handler (button click).
 */
async function requestPermission() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      throw new Error(
        'Permission was denied. Please click the 🔒 icon in Chrome\'s address bar ' +
        'and allow microphone access for this extension.'
      );
    }
    throw new Error(`Could not request permission: ${err.message}`);
  } finally {
    // Always stop tracks — we do not record or retain any microphone audio
    if (stream) stream.getTracks().forEach(t => t.stop());
  }
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadAll() {
  await Promise.all([loadTabs(), loadDevices(), loadState()]);
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  allTabs = tabs
    .filter(t =>
      // Exclude extension pages
      !t.url?.startsWith('chrome-extension://') &&
      !t.url?.startsWith('chrome://') &&
      !t.url?.startsWith('about:') &&
      t.id !== undefined
    )
    .sort((a, b) => {
      // Audible tabs first
      if (a.audible && !b.audible) return -1;
      if (!a.audible && b.audible) return 1;
      return 0;
    });
}

async function loadDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  audioOutputDevices = devices
    .filter(d => d.kind === 'audiooutput')
    .map(d => ({
      deviceId: d.deviceId,
      label:    d.label || `Output Device (${d.deviceId.slice(0, 8)}…)`
    }));
}

async function loadState() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  activeRoutes = new Map(state.routes.map(r => [r.tabId, r]));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Re-render the two route slots based on current activeRoutes state.
 */
function renderRouting() {
  const routeEntries = [...activeRoutes.values()];

  SLOTS.forEach(slot => {
    const route = routeEntries[slot] ?? null;
    renderSlot(slot, route);
  });

  // Update global status badge
  const activeCount = activeRoutes.size;
  if (activeCount > 0) {
    statusBadge.textContent = `${activeCount} Active`;
    statusBadge.className = 'status-badge status-active';
  } else {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'status-badge status-idle';
  }
}

/**
 * Render a single route slot.
 * @param {number} slot - 0 or 1
 * @param {object|null} route - Active route info, or null if slot is free
 */
function renderSlot(slot, route) {
  const el = slotEl(slot);
  clearSlotError(slot);

  if (route) {
    // ── Active state ────────────────────────────────────────────────────
    el.card.classList.add('is-active');
    el.dot.classList.add('dot-active');
    el.statusText.textContent = `Routing → ${truncate(route.deviceLabel, 22)}`;
    el.statusText.className = 'slot-status-text text-active';

    // Populate selects with the locked values and disable them
    el.tabSelect.innerHTML = `<option value="${route.tabId}">${escHtml(truncate(route.tabTitle, 38))}</option>`;
    el.devSelect.innerHTML = `<option value="${route.deviceId}">${escHtml(truncate(route.deviceLabel, 38))}</option>`;
    el.tabSelect.disabled = true;
    el.devSelect.disabled = true;

    el.btn.textContent = 'Stop Routing';
    el.btn.className = 'btn btn-danger';
    el.btn.disabled = false;

  } else {
    // ── Idle state ──────────────────────────────────────────────────────
    el.card.classList.remove('is-active');
    el.dot.classList.remove('dot-active');
    el.statusText.textContent = 'Not active';
    el.statusText.className = 'slot-status-text';

    // Populate tab select
    populateTabSelect(el.tabSelect, slot);

    // Populate device select
    populateDeviceSelect(el.devSelect);

    el.tabSelect.disabled = false;
    el.devSelect.disabled = false;

    el.btn.textContent = 'Start Routing';
    el.btn.className = 'btn btn-primary';
    updateStartButton(slot);
  }
}

function populateTabSelect(select, slot) {
  const occupiedTabIds = new Set([...activeRoutes.keys()]);

  let html = '<option value="">Select a tab…</option>';

  const audible = allTabs.filter(t => t.audible && !occupiedTabIds.has(t.id));
  const other   = allTabs.filter(t => !t.audible && !occupiedTabIds.has(t.id));

  if (audible.length > 0) {
    html += '<optgroup label="🔊 Playing Audio">';
    audible.forEach(t => {
      html += `<option value="${t.id}">${escHtml(truncate(t.title || t.url || `Tab ${t.id}`, 44))}</option>`;
    });
    html += '</optgroup>';
  }

  if (other.length > 0) {
    html += '<optgroup label="Other Tabs">';
    other.forEach(t => {
      html += `<option value="${t.id}">${escHtml(truncate(t.title || t.url || `Tab ${t.id}`, 44))}</option>`;
    });
    html += '</optgroup>';
  }

  if (allTabs.filter(t => !occupiedTabIds.has(t.id)).length === 0) {
    html = '<option value="">No available tabs</option>';
  }

  select.innerHTML = html;
}

function populateDeviceSelect(select) {
  let html = '<option value="">Select device…</option>';

  audioOutputDevices.forEach(d => {
    const label = d.label || d.deviceId;
    html += `<option value="${d.deviceId}">${escHtml(truncate(label, 44))}</option>`;
  });

  if (audioOutputDevices.length === 0) {
    html = '<option value="">No output devices found</option>';
  }

  select.innerHTML = html;
}

// ─── Event Binding ────────────────────────────────────────────────────────────

function bindEvents() {
  // Permission grant button (shown only on first-run screen)
  grantPermissionBtn.addEventListener('click', async () => {
    grantPermissionBtn.disabled = true;
    grantPermissionBtn.textContent = 'Requesting…';
    hideEl(permissionError);

    try {
      await requestPermission();
      hasPermission = true;
      await loadAll();
      renderRouting();
      showScreen('routing');
      bindEvents(); // Re-bind now that routing screen is visible
    } catch (err) {
      showEl(permissionError);
      permissionError.textContent = err.message;
    } finally {
      grantPermissionBtn.disabled = false;
      grantPermissionBtn.textContent = 'Grant Permission';
      grantPermissionBtn.querySelector('.btn-icon').textContent = '🔓';
    }
  });

  // Refresh button
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↺ Refreshing…';
    try {
      await loadAll();
      renderRouting();
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↺ Refresh';
    }
  });

  // Route/Stop buttons and select change handlers for both slots
  SLOTS.forEach(slot => {
    const el = slotEl(slot);

    el.tabSelect.addEventListener('change', () => updateStartButton(slot));
    el.devSelect.addEventListener('change', () => updateStartButton(slot));

    el.btn.addEventListener('click', async (e) => {
      const isActive = activeRoutes.has(getSelectedTabId(slot));
      if (isActive || el.btn.classList.contains('btn-danger')) {
        await handleStop(slot);
      } else {
        await handleStart(slot);
      }
    });
  });

  // Device change: re-enumerate and update selects
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await loadDevices();
    renderRouting();
  });
}

/**
 * Enable/disable the Start Routing button based on select values.
 */
function updateStartButton(slot) {
  const el = slotEl(slot);
  // Only relevant for idle slots
  if (el.btn.classList.contains('btn-danger')) return;
  const hasTab = !!getSelectedTabId(slot);
  const hasDev = !!el.devSelect.value;
  el.btn.disabled = !(hasTab && hasDev);
}

// ─── Routing Actions ──────────────────────────────────────────────────────────

/**
 * Start routing for the given slot.
 * Calls tabCapture.getMediaStreamId here (user gesture context).
 */
async function handleStart(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  const tabId   = getSelectedTabId(slot);
  const deviceId = el.devSelect.value;

  if (!tabId || !deviceId) {
    showSlotError(slot, 'Please select both a tab and an output device.');
    return;
  }

  // Look up metadata for the SW
  const tab         = allTabs.find(t => t.id === tabId);
  const device      = audioOutputDevices.find(d => d.deviceId === deviceId);
  const tabTitle    = tab?.title  || `Tab ${tabId}`;
  const deviceLabel = device?.label || deviceId;

  el.btn.disabled = true;
  el.btn.textContent = 'Capturing…';

  // ── Get stream ID (must be called in user gesture context) ─────────────
  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch (err) {
    showSlotError(slot,
      `Could not capture audio from this tab. ` +
      `Make sure the tab is loaded and try clicking inside it first. ` +
      `(${err.message})`
    );
    el.btn.disabled = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  // ── Send to service worker ─────────────────────────────────────────────
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'START_ROUTING',
      tabId,
      streamId,
      deviceId,
      deviceLabel,
      tabTitle,
      tabUrl: tab?.url || ''
    });
  } catch (err) {
    showSlotError(slot, `Extension error: ${err.message}`);
    el.btn.disabled = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  if (!result?.success) {
    showSlotError(slot, result?.error ?? 'Unknown error. Please try again.');
    el.btn.disabled = false;
    el.btn.textContent = 'Start Routing';
    return;
  }

  // ── Update local state and re-render ───────────────────────────────────
  activeRoutes.set(tabId, { tabId, streamId, deviceId, deviceLabel, tabTitle });
  renderRouting();
}

/**
 * Stop routing for the given slot.
 */
async function handleStop(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  // Find which tabId is in this slot
  const routeEntries = [...activeRoutes.values()];
  const route = routeEntries[slot];
  if (!route) return;

  el.btn.disabled = true;
  el.btn.textContent = 'Stopping…';

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'STOP_ROUTING',
      tabId: route.tabId
    });
  } catch (err) {
    showSlotError(slot, `Extension error: ${err.message}`);
    el.btn.disabled = false;
    el.btn.textContent = 'Stop Routing';
    return;
  }

  if (!result?.success) {
    showSlotError(slot, result?.error ?? 'Could not stop routing. Please try refreshing.');
    el.btn.disabled = false;
    el.btn.textContent = 'Stop Routing';
    return;
  }

  activeRoutes.delete(route.tabId);
  renderRouting();
}

// ─── tabCapture Helper ────────────────────────────────────────────────────────

/**
 * Wrap chrome.tabCapture.getMediaStreamId in a Promise.
 * MUST be called from a user-gesture handler (button click).
 * @param {number} tabId
 * @returns {Promise<string>} streamId
 */
function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(streamId);
      }
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function showScreen(name) {
  Object.keys(screens).forEach(k => {
    screens[k].classList.toggle('hidden', k !== name);
  });
}

function showError(msg) {
  errorMessage.textContent = msg;
  showScreen('error');
}

function showSlotError(slot, msg) {
  const el = slotEl(slot);
  el.error.textContent = msg;
  showEl(el.error);
}

function clearSlotError(slot) {
  const el = slotEl(slot);
  el.error.textContent = '';
  hideEl(el.error);
}

function showEl(el)  { el.classList.remove('hidden'); }
function hideEl(el)  { el.classList.add('hidden'); }

function getSelectedTabId(slot) {
  const val = slotEl(slot).tabSelect.value;
  return val ? parseInt(val, 10) : null;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
