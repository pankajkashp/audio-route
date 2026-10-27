/**
 * background.js — Service Worker
 *
 * Responsibilities:
 * - Own routing state, persisted to chrome.storage.session so it survives
 *   service worker restarts (chrome.storage.session is cleared when the
 *   browser itself closes, which is the desired behaviour).
 * - On startup, reconcile stored state against the live offscreen document
 *   and open tabs to discard stale entries automatically.
 * - Manage the lifecycle of the Offscreen Document.
 * - Relay START_ROUTING / STOP_ROUTING to the offscreen audio engine.
 * - Clean up state when tabs close or navigate away.
 * - Handle ROUTING_STOPPED notifications from the offscreen engine.
 */

'use strict';

const MAX_ROUTES  = 2;
const SESSION_KEY = 'routingState'; // key used in chrome.storage.session

// Handle extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[SW] Tab Audio Router installed/updated: ${details.reason}`);
});

// ─── In-Memory State ──────────────────────────────────────────────────────────

/**
 * Primary runtime state.
 * Key: tabId (number)
 * Value: { streamId, deviceId, deviceLabel, tabTitle, tabUrl, startedAt }
 */
const routingState = new Map();

// ─── State Persistence ────────────────────────────────────────────────────────

/**
 * Write the current routingState to chrome.storage.session.
 * Called after every state mutation so that if the SW is killed by Chrome
 * and later restarted, we can restore the state exactly.
 */
async function persistState() {
  try {
    await chrome.storage.session.set({
      [SESSION_KEY]: [...routingState.entries()]
    });
  } catch (err) {
    console.warn('[SW] persistState failed:', err.message);
  }
}

async function clearPersistedState() {
  try {
    await chrome.storage.session.remove(SESSION_KEY);
  } catch (err) {
    console.warn('[SW] clearPersistedState failed:', err.message);
  }
}

// ─── SW Startup: State Reconciliation ────────────────────────────────────────

/**
 * stateReady resolves when the startup reconciliation is complete.
 * Message handlers that read/write routingState wait on this so they
 * never see a half-initialised state.
 */
const stateReady = initState();

async function initState() {
  let stored;
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    stored = result[SESSION_KEY]; // [[tabId, routeInfo], ...] | undefined
  } catch (err) {
    console.warn('[SW] Could not read session storage during init:', err.message);
    return;
  }

  if (!stored || stored.length === 0) return; // nothing to restore

  // If the offscreen document is gone, the AudioContexts inside it are gone too.
  // The stored state would be stale — discard it.
  const offscreenAlive = await isOffscreenAlive();
  if (!offscreenAlive) {
    console.log('[SW] Offscreen not found on startup; discarding stale persisted routes.');
    await clearPersistedState();
    return;
  }

  // The offscreen is alive. Validate that the referenced tabs still exist
  // (they might have been closed while the SW was sleeping).
  let openTabs;
  try {
    openTabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn('[SW] tabs.query failed during reconciliation:', err.message);
    return;
  }
  const openTabIds = new Set(openTabs.map(t => t.id));

  for (const [tabId, info] of stored) {
    if (openTabIds.has(tabId)) {
      // Tab still open and offscreen alive — restore this route.
      routingState.set(tabId, info);
    } else {
      // Tab was closed while SW was sleeping; tell offscreen to clean up.
      console.log(`[SW] Stale route for closed tab ${tabId}; sending cleanup to offscreen.`);
      sendToOffscreen({ type: 'STOP_ROUTING', tabId })
        .catch(err => console.warn(`[SW] Could not clean stale route for tab ${tabId}:`, err.message));
    }
  }

  // Persist the validated (possibly reduced) set.
  await persistState();

  if (routingState.size > 0) {
    console.log(`[SW] Restored ${routingState.size} route(s) from session storage after SW restart.`);
  }
}

// ─── Offscreen Document Management ───────────────────────────────────────────

async function isOffscreenAlive() {
  if (chrome.offscreen?.hasDocument) {
    return await chrome.offscreen.hasDocument();
  }
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return existing.length > 0;
}

/**
 * Creates the offscreen document if it does not already exist.
 * Declared reasons:
 *   USER_MEDIA    — we call getUserMedia(chromeMediaSource:'tab')
 *   AUDIO_PLAYBACK — we play audio back through AudioContext + setSinkId
 */
async function ensureOffscreenDocument() {
  if (await isOffscreenAlive()) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification:
      'Capture tab audio via getUserMedia (chromeMediaSource: tab) and play it ' +
      'through an AudioContext routed to a specific output device via setSinkId().'
  });
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    } catch (err) {
      lastErr = err;
      if (err.message && err.message.includes('Receiving end does not exist')) {
        await new Promise(r => setTimeout(r, 60));
        continue;
      }
      throw new Error(`Offscreen message failed (${message.type}): ${err.message}`);
    }
  }
  throw new Error(`Offscreen message failed (${message.type}): ${lastErr?.message || 'timeout'}`);
}

// ─── Routing Operations ───────────────────────────────────────────────────────

async function startRouting(tabId, streamId, deviceId, deviceLabel, tabTitle, tabUrl, slot) {
  await stateReady;

  if (routingState.has(tabId)) {
    return { success: false, error: 'This tab is already being routed.' };
  }

  if (routingState.size >= MAX_ROUTES) {
    return {
      success: false,
      error: `Maximum of ${MAX_ROUTES} routes are active. Stop one first.`
    };
  }

  // Basic input validation — these come from a trusted extension context,
  // but validate anyway to catch programming errors early.
  if (!streamId || typeof streamId !== 'string') {
    return { success: false, error: 'Invalid stream ID received.' };
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return { success: false, error: 'Invalid device ID received.' };
  }

  let result;
  try {
    result = await sendToOffscreen({ type: 'START_ROUTING', tabId, streamId, deviceId });
  } catch (err) {
    return { success: false, error: err.message };
  }

  if (!result?.success) {
    return { success: false, error: result?.error ?? 'Audio engine returned an unknown error.' };
  }

  routingState.set(tabId, {
    streamId,
    deviceId,
    deviceLabel: deviceLabel || 'Unknown Device',
    tabTitle:    tabTitle    || `Tab ${tabId}`,
    tabUrl:      tabUrl      || '',
    slot:        typeof slot === 'number' ? slot : undefined,
    startedAt:   Date.now()
  });

  await persistState();
  return { success: true };
}

async function stopRouting(tabId, reason = 'user_requested') {
  await stateReady;

  if (!routingState.has(tabId)) {
    return { success: false, error: 'Tab is not currently being routed.' };
  }

  // Remove from state FIRST so re-entrant calls (e.g., from onRemoved and
  // ROUTING_STOPPED arriving close together) are no-ops.
  routingState.delete(tabId);
  await persistState();

  try {
    await sendToOffscreen({ type: 'STOP_ROUTING', tabId });
  } catch (err) {
    // Offscreen may already be gone. State is already cleaned — not an error.
    console.warn(`[SW] stopRouting offscreen notify failed (tab ${tabId}): ${err.message}`);
  }

  // Close offscreen document when no routes remain to release OS audio resources
  if (routingState.size === 0 && (await isOffscreenAlive())) {
    try {
      await chrome.offscreen.closeDocument();
      console.log('[SW] All routes ended; closed offscreen document.');
    } catch (err) {
      console.warn('[SW] Could not close offscreen document:', err.message);
    }
  }

  console.log(`[SW] Route stopped for tab ${tabId}. Reason: ${reason}`);
  return { success: true };
}

function getState() {
  const routes = [...routingState.entries()].map(([tabId, info]) => ({ tabId, ...info }));
  return { routes, maxRoutes: MAX_ROUTES };
}

// ─── Tab Event Listeners ──────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (routingState.has(tabId)) {
    console.log(`[SW] Routed tab ${tabId} closed; auto-stopping route.`);
    stopRouting(tabId, 'tab_closed');
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A URL change means the page navigated. The captured MediaStream from the
  // previous page is invalid. Stop routing to avoid silence or errors.
  if (changeInfo.url && routingState.has(tabId)) {
    console.log(`[SW] Routed tab ${tabId} navigated; stopping route.`);
    stopRouting(tabId, 'tab_navigated');
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Pass-through: messages targeted at the offscreen doc. Chrome's runtime
  // delivers them; we must not consume them here.
  if (message.target === 'offscreen') return false;

  const { type } = message;

  switch (type) {
    case 'GET_STATE': {
      // Wait for reconciliation before returning state, so the popup never
      // sees a half-restored state immediately after a SW restart.
      stateReady
        .then(() => sendResponse(getState()))
        .catch(() => sendResponse(getState()));
      return true; // async
    }

    case 'START_ROUTING': {
      const { tabId, streamId, deviceId, deviceLabel, tabTitle, tabUrl, slot } = message;
      startRouting(tabId, streamId, deviceId, deviceLabel, tabTitle, tabUrl, slot)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_AUDIO_STATUS': {
      (async () => {
        if (!(await isOffscreenAlive())) {
          return { success: true, routes: [] };
        }
        return await sendToOffscreen({ type: 'GET_AUDIO_STATUS' });
      })()
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'STOP_ROUTING': {
      stopRouting(message.tabId)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'ROUTING_STOPPED': {
      // Offscreen notifies us when a track ends unexpectedly (tab closed,
      // stream revoked, device disconnected). Sync state and persist.
      const { tabId, reason } = message;
      stateReady.then(async () => {
        if (routingState.has(tabId)) {
          routingState.delete(tabId);
          await persistState();
          console.log(`[SW] Auto-stopped route for tab ${tabId}: ${reason}`);
          if (routingState.size === 0 && (await isOffscreenAlive())) {
            try {
              await chrome.offscreen.closeDocument();
              console.log('[SW] All routes ended; closed offscreen document.');
            } catch (_) {}
          }
        }
      }).catch(() => {});
      sendResponse({ received: true });
      return false;
    }

    default:
      return false;
  }
});
