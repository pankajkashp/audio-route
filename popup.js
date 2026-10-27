/**
 * popup.js — Extension Popup Controller
 *
 * Permission model (corrected from Phase 2 draft):
 *
 * Microphone permission is NOT required for routing to work. Chrome always
 * returns audio output device IDs from enumerateDevices() — they are valid
 * for setSinkId() regardless of permission state. What changes with mic
 * permission is whether the label field is populated (e.g., "AirPods Pro"
 * vs. an empty string).
 *
 * Behaviour:
 *   1. The popup opens immediately and shows the routing UI.
 *   2. If device labels are not available, an info banner explains why and
 *      offers an optional "Show Names" button. The user can still route to
 *      unlabeled devices (shown as "Device 1", "Device 2", etc.).
 *   3. If the user clicks "Show Names", getUserMedia({audio:true}) is called
 *      briefly to unlock labels; tracks are stopped immediately.
 *   4. The mic permission is NOT requested on first open. It is NEVER
 *      required to use the extension.
 *
 * tabCapture flow:
 *   chrome.tabCapture.getMediaStreamId() is called HERE in the popup
 *   (a user-facing extension page). A button click provides the user-gesture
 *   context that the API requires. The resulting streamId is passed to the
 *   service worker, which forwards it to the offscreen audio engine.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screens = {
  loading: $('loading-screen'),
  routing: $('routing-screen'),
  error:   $('error-screen')
};

const statusBadge  = $('status-badge');
const infoBanner   = $('info-banner');
const showNamesBtn = $('show-names-btn');
const refreshBtn   = $('refresh-btn');
const errorMessage = $('error-message');

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
let allTabs            = [];        // filtered list of user-browsable tabs
let audioOutputDevices = [];        // [{deviceId, label}]
let hasDeviceLabels    = false;     // true when labels are populated

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

  // Load everything — no permission check gate
  try {
    await Promise.all([loadTabs(), loadDevices(), loadState()]);
  } catch (err) {
    showError(`Failed to load: ${err.message}`);
    return;
  }

  renderRouting();
  showScreen('routing');

  // Show optional banner if device labels are not available
  infoBanner.classList.toggle('hidden', hasDeviceLabels);

  bindEvents();
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  allTabs = tabs
    .filter(t =>
      t.id !== undefined &&
      t.url &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('about:') &&
      !t.url.startsWith('edge://')
    )
    .sort((a, b) => {
      // Audible tabs first — most likely what the user wants to route
      if (a.audible && !b.audible) return -1;
      if (!a.audible && b.audible) return  1;
      return 0;
    });
}

/**
 * Enumerate audio output devices.
 *
 * Chrome always returns device entries from enumerateDevices(), but labels
 * are empty strings unless microphone permission is granted. We assign
 * readable fallback labels so the UI is functional either way.
 *
 * The only device that is always identified by Chrome is deviceId "default",
 * which represents the current system default output.
 */
async function loadDevices() {
  let rawDevices;
  try {
    rawDevices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    throw new Error(`enumerateDevices() failed: ${err.message}`);
  }

  const outputs = rawDevices.filter(d => d.kind === 'audiooutput');

  // Labels are available when mic permission is granted (or was ever granted
  // for this extension origin in this browser session).
  hasDeviceLabels = outputs.some(d => d.label && d.label.length > 0);

  audioOutputDevices = outputs.map((d, idx) => ({
    deviceId: d.deviceId,
    label: d.label ||
      (d.deviceId === 'default'        ? 'Default Output' :
       d.deviceId === 'communications' ? 'Communications Device' :
       `Output Device ${idx + 1}`)
  }));
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  activeRoutes = new Map((response.routes ?? []).map(r => [r.tabId, r]));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderRouting() {
  const routeEntries = [...activeRoutes.values()];

  SLOTS.forEach(slot => renderSlot(slot, routeEntries[slot] ?? null));

  const n = activeRoutes.size;
  statusBadge.textContent = n > 0 ? `${n} Active` : 'Idle';
  statusBadge.className   = `status-badge ${n > 0 ? 'status-active' : 'status-idle'}`;
}

function renderSlot(slot, route) {
  const el = slotEl(slot);
  clearSlotError(slot);

  if (route) {
    // ── Active ─────────────────────────────────────────────────────────────
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
    // ── Idle ───────────────────────────────────────────────────────────────
    el.card.classList.remove('is-active');
    el.dot.classList.remove('dot-active');
    el.statusText.textContent = 'Not active';
    el.statusText.className   = 'slot-status-text';

    populateTabSelect(el.tabSelect);
    populateDeviceSelect(el.devSelect);
    el.tabSelect.disabled = false;
    el.devSelect.disabled = false;

    el.btn.textContent = 'Start Routing';
    el.btn.className   = 'btn btn-primary';
    updateStartButton(slot);
  }
}

function populateTabSelect(select) {
  const selectedBefore = select.value;
  const occupied  = new Set(activeRoutes.keys());
  const available = allTabs.filter(t => !occupied.has(t.id));

  const audible = available.filter(t =>  t.audible);
  const other   = available.filter(t => !t.audible);

  let html = '<option value="">Select a tab…</option>';

  if (audible.length > 0) {
    html += '<optgroup label="▶ Playing Audio">';
    audible.forEach(t => {
      html += `<option value="${t.id}">${escHtml(truncate(tabDisplayName(t), 50))}</option>`;
    });
    html += '</optgroup>';
  }

  if (other.length > 0) {
    html += '<optgroup label="Other Tabs">';
    other.forEach(t => {
      html += `<option value="${t.id}">${escHtml(truncate(tabDisplayName(t), 50))}</option>`;
    });
    html += '</optgroup>';
  }

  if (available.length === 0) {
    html = '<option value="">No available tabs</option>';
  }

  select.innerHTML = html;
  if (selectedBefore && available.some(t => String(t.id) === selectedBefore)) {
    select.value = selectedBefore;
  }
}

function populateDeviceSelect(select) {
  const selectedBefore = select.value;
  let html = '<option value="">Select device…</option>';
  audioOutputDevices.forEach(d => {
    html += `<option value="${d.deviceId}">${escHtml(truncate(d.label, 50))}</option>`;
  });
  if (audioOutputDevices.length === 0) {
    html = '<option value="">No output devices found</option>';
  }
  select.innerHTML = html;
  if (selectedBefore && audioOutputDevices.some(d => d.deviceId === selectedBefore)) {
    select.value = selectedBefore;
  }
}

// ─── Event Binding ────────────────────────────────────────────────────────────

function bindEvents() {
  // Optional: reveal device names by granting mic permission.
  // getUserMedia tracks are stopped IMMEDIATELY — no audio is recorded.
  showNamesBtn?.addEventListener('click', async () => {
    showNamesBtn.disabled    = true;
    showNamesBtn.textContent = 'Requesting…';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      // User declined — not fatal; the extension continues working with generic labels
      console.warn('[Popup] Mic permission declined:', err.message);
      showNamesBtn.disabled    = false;
      showNamesBtn.textContent = 'Show Names';
      return;
    } finally {
      // Always stop tracks immediately — we do not retain mic audio under any circumstances
      stream?.getTracks().forEach(t => t.stop());
    }

    await loadDevices();
    renderRouting();
    infoBanner.classList.toggle('hidden', hasDeviceLabels);
    // If we got labels, button is no longer needed (banner hides it)
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

function updateStartButton(slot) {
  const el = slotEl(slot);
  if (el.btn.classList.contains('btn-danger')) return; // active slot
  el.btn.disabled = !getSelectedTabId(slot) || !slotEl(slot).devSelect.value;
}

// ─── Routing Actions ──────────────────────────────────────────────────────────

/**
 * Start routing for a slot.
 *
 * IMPORTANT: chrome.tabCapture.getMediaStreamId() is called directly here,
 * inside a button-click handler on a user-facing extension page. This
 * satisfies Chrome's requirement that tabCapture API calls originate from
 * a user gesture in the extension's UI. Calling it from a service worker
 * in response to a message is less reliable; keeping it here is correct.
 */
async function handleStart(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  const tabId    = getSelectedTabId(slot);
  const deviceId = el.devSelect.value;

  if (!tabId || !deviceId) {
    showSlotError(slot, 'Select both a tab and an output device first.');
    return;
  }

  const tab         = allTabs.find(t => t.id === tabId);
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
    showSlotError(slot,
      `Could not capture audio from this tab: ${err.message}. ` +
      `Try clicking inside the tab first, then retry.`
    );
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
      tabUrl: tab?.url || ''
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
  activeRoutes.set(tabId, { tabId, streamId, deviceId, deviceLabel, tabTitle });
  renderRouting();
}

async function handleStop(slot) {
  const el = slotEl(slot);
  clearSlotError(slot);

  const routeEntries = [...activeRoutes.values()];
  const route = routeEntries[slot];
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
 * Must be called from a user-gesture handler.
 * targetTabId can be any tab (not just the active one).
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
