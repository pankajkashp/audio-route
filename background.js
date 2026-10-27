/**
 * background.js — Service Worker
 *
 * Responsibilities:
 * - Own in-memory routing state (tabId → route info)
 * - Manage the lifecycle of the single Offscreen Document
 * - Relay START_ROUTING / STOP_ROUTING to the offscreen audio engine
 * - Clean up state when tabs close or navigate away
 * - Handle ROUTING_STOPPED notifications from the offscreen engine
 *
 * NOTE: State is ephemeral. It is NOT persisted to chrome.storage.
 * If the service worker is terminated and restarted by the browser, the
 * routing state map resets. The offscreen document (and its live
 * AudioContexts) may survive SW restart — this is a known Phase 2
 * limitation tracked as UQ-6. The popup will show empty state in that
 * scenario, and the user can re-initiate routing. This will be addressed
 * in a future phase.
 */

'use strict';

const MAX_ROUTES = 2;

/**
 * In-memory routing state.
 * Key: tabId (number)
 * Value: { streamId, deviceId, deviceLabel, tabTitle, tabUrl, startedAt }
 */
const routingState = new Map();

// ─── Offscreen Document Management ───────────────────────────────────────────

/**
 * Ensures the offscreen document exists. Creates it if absent.
 * The offscreen document persists as long as there is at least one
 * active AudioContext inside it or until explicitly closed by the SW.
 */
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture and route tab audio to the selected physical output device.'
  });
}

/**
 * Send a message to the offscreen document (creates the doc if needed).
 * @param {object} message - Must include a `type` field.
 * @returns {Promise<any>} The response from the offscreen handler.
 */
async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  try {
    return await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  } catch (err) {
    // Offscreen document may have been closed or context invalidated
    throw new Error(`Offscreen message failed: ${err.message}`);
  }
}

// ─── Routing Operations ───────────────────────────────────────────────────────

/**
 * Start routing audio from a tab to a device.
 * The stream ID must already have been obtained by the popup (which has
 * user-gesture context for tabCapture.getMediaStreamId).
 *
 * @param {number}  tabId       - ID of the tab to route
 * @param {string}  streamId    - Stream ID from tabCapture.getMediaStreamId
 * @param {string}  deviceId    - Audio output device ID for setSinkId
 * @param {string}  deviceLabel - Human-readable device name (for UI)
 * @param {string}  tabTitle    - Tab title (for UI)
 * @param {string}  tabUrl      - Tab URL (for UI)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function startRouting(tabId, streamId, deviceId, deviceLabel, tabTitle, tabUrl) {
  if (routingState.size >= MAX_ROUTES) {
    return {
      success: false,
      error: `Maximum of ${MAX_ROUTES} routing slots are active. Stop one before adding another.`
    };
  }

  if (routingState.has(tabId)) {
    return { success: false, error: 'This tab is already being routed.' };
  }

  // Validate streamId and deviceId are non-empty strings (basic message validation)
  if (!streamId || typeof streamId !== 'string') {
    return { success: false, error: 'Invalid stream ID.' };
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return { success: false, error: 'Invalid device ID.' };
  }

  let result;
  try {
    result = await sendToOffscreen({
      type: 'START_ROUTING',
      tabId,
      streamId,
      deviceId
    });
  } catch (err) {
    return { success: false, error: err.message };
  }

  if (!result?.success) {
    return { success: false, error: result?.error ?? 'Unknown error from audio engine.' };
  }

  routingState.set(tabId, {
    streamId,
    deviceId,
    deviceLabel: deviceLabel || deviceId,
    tabTitle: tabTitle || `Tab ${tabId}`,
    tabUrl: tabUrl || '',
    startedAt: Date.now()
  });

  return { success: true };
}

/**
 * Stop routing audio for a tab and clean up all resources.
 * @param {number} tabId
 * @param {string} [reason] - Optional reason string for logging
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function stopRouting(tabId, reason = 'user_requested') {
  if (!routingState.has(tabId)) {
    return { success: false, error: 'Tab is not currently being routed.' };
  }

  // Remove from state first to prevent re-entrant calls
  routingState.delete(tabId);

  try {
    await sendToOffscreen({ type: 'STOP_ROUTING', tabId });
  } catch (err) {
    // Offscreen may already be gone (e.g., browser restart scenario).
    // Log the warning but do not surface as an error — state is already cleaned.
    console.warn(`[SW] stopRouting offscreen message failed (tab ${tabId}): ${err.message}`);
  }

  console.log(`[SW] Routing stopped for tab ${tabId}. Reason: ${reason}`);
  return { success: true };
}

/**
 * Return a serializable snapshot of the current routing state.
 * Called by the popup to render active routes.
 */
function getState() {
  const routes = [];
  for (const [tabId, info] of routingState) {
    routes.push({ tabId, ...info });
  }
  return { routes, maxRoutes: MAX_ROUTES };
}

// ─── Tab Event Listeners ──────────────────────────────────────────────────────

/** Clean up if a routed tab is closed. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (routingState.has(tabId)) {
    console.log(`[SW] Routed tab ${tabId} closed. Auto-stopping routing.`);
    stopRouting(tabId, 'tab_closed');
  }
});

/**
 * Clean up if a routed tab navigates to a new URL.
 * The captured MediaStream becomes invalid after navigation.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && routingState.has(tabId)) {
    console.log(`[SW] Routed tab ${tabId} navigated. Stopping routing.`);
    stopRouting(tabId, 'tab_navigated');
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages targeted at the offscreen document are routed by Chrome's
  // runtime — we must NOT intercept them here.
  if (message.target === 'offscreen') return false;

  const { type } = message;

  switch (type) {
    case 'GET_STATE': {
      sendResponse(getState());
      return false;
    }

    case 'START_ROUTING': {
      const { tabId, streamId, deviceId, deviceLabel, tabTitle, tabUrl } = message;
      startRouting(tabId, streamId, deviceId, deviceLabel, tabTitle, tabUrl)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // keep channel open for async response
    }

    case 'STOP_ROUTING': {
      const { tabId } = message;
      stopRouting(tabId)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    /**
     * Sent by the offscreen document when a MediaStreamTrack ends
     * unexpectedly (tab closed, stream revoked, device lost).
     * We update SW state to stay in sync.
     */
    case 'ROUTING_STOPPED': {
      const { tabId, reason } = message;
      if (routingState.has(tabId)) {
        routingState.delete(tabId);
        console.log(`[SW] Auto-routing-stop received for tab ${tabId}: ${reason}`);
      }
      sendResponse({ received: true });
      return false;
    }

    default:
      return false;
  }
});
