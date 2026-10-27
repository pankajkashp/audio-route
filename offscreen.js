/**
 * offscreen.js — Audio Engine
 *
 * Responsibilities:
 * - Receive captured tab stream IDs from the service worker
 * - Materialise each stream via getUserMedia (chromeMediaSource: 'tab')
 * - Create one AudioContext per routed tab
 * - Route each AudioContext to the user-selected output device via setSinkId()
 * - Connect the MediaStreamSourceNode → AudioContext.destination
 * - Detect track termination and device removal; notify the service worker
 * - Clean up all resources (tracks, AudioContext) on stop or failure
 *
 * Security invariants:
 * - Audio is NEVER recorded, stored, or transmitted.
 * - No MediaRecorder is created. No data is written to disk or the network.
 * - All audio flows from tab → AudioContext → local output device only.
 * - Messages are validated before processing (type and target checks).
 * - Only messages with target === 'offscreen' are handled here.
 */

'use strict';

/**
 * Active routing state.
 * Key: tabId (number)
 * Value: { stream: MediaStream, audioContext: AudioContext, sourceNode: MediaStreamAudioSourceNode }
 */
const activeRoutes = new Map();

// ─── Audio Routing ────────────────────────────────────────────────────────────

/**
 * Start routing audio for a captured tab.
 *
 * @param {number} tabId     - Used as the key for this route
 * @param {string} streamId  - From chrome.tabCapture.getMediaStreamId
 * @param {string} deviceId  - Target audio output device ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function startRouting(tabId, streamId, deviceId) {
  // Idempotent: stop any existing route for this tab before creating a new one
  if (activeRoutes.has(tabId)) {
    await cleanup(tabId);
  }

  // ── Step 1: Materialise the captured stream ──────────────────────────────
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (err) {
    return {
      success: false,
      error: `getUserMedia failed: ${err.name} — ${err.message}`
    };
  }

  // ── Step 2: Create AudioContext ──────────────────────────────────────────
  // Match the stream's native sample rate to avoid unnecessary resampling,
  // with fallback to default constructor if specific sampleRate is unsupported.
  let audioContext;
  try {
    const trackSettings = stream.getAudioTracks()[0]?.getSettings();
    const contextOptions = (trackSettings?.sampleRate && trackSettings.sampleRate >= 8000 && trackSettings.sampleRate <= 96000)
      ? { sampleRate: trackSettings.sampleRate }
      : {};
    audioContext = new AudioContext(contextOptions);
  } catch (_) {
    audioContext = new AudioContext();
  }

  // Ensure AudioContext is running; offscreen contexts may initialize as suspended
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (err) {
      console.warn(`[Offscreen] AudioContext resume note: ${err.message}`);
    }
  }

  // ── Step 3: Route to the selected output device ──────────────────────────
  // setSinkId is supported since Chrome 110. We feature-detect defensively.
  if (typeof audioContext.setSinkId === 'function') {
    // 'default' is a valid sinkId meaning "system default output"
    const targetSinkId = deviceId === 'default' ? '' : deviceId;
    try {
      await audioContext.setSinkId(targetSinkId);
    } catch (err) {
      // Clean up before returning
      stream.getTracks().forEach(t => t.stop());
      await audioContext.close();
      return {
        success: false,
        error: `setSinkId failed: ${err.name} — ${err.message}. ` +
               `The device may be unavailable or permission was denied.`
      };
    }
  } else {
    // Browser too old — should not happen given minimum_chrome_version: 116
    // but handle gracefully: audio will play through system default.
    console.warn(`[Offscreen] AudioContext.setSinkId is not available (tab ${tabId}). ` +
                 `Audio will route to the system default output.`);
  }

  // ── Step 4: Connect source → destination ────────────────────────────────
  // This is what actually re-enables audio playback for the captured tab.
  // Without this connection, tabCapture's automatic suppression causes silence.
  const sourceNode = audioContext.createMediaStreamSource(stream);
  sourceNode.connect(audioContext.destination);

  // ── Step 5: Store state ──────────────────────────────────────────────────
  activeRoutes.set(tabId, { stream, audioContext, sourceNode });

  // ── Step 6: Register lifecycle listeners ────────────────────────────────
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.addEventListener('ended', () => {
      console.log(`[Offscreen] Audio track ended for tab ${tabId}. Auto-cleaning up.`);
      cleanup(tabId);
      notifyServiceWorker('ROUTING_STOPPED', { tabId, reason: 'track_ended' });
    }, { once: true });
  }

  console.log(`[Offscreen] Routing active for tab ${tabId} → device "${deviceId}"`);
  return { success: true };
}

/**
 * Stop routing audio for a tab and release all resources.
 * @param {number} tabId
 * @returns {Promise<{success: boolean}>}
 */
async function stopRouting(tabId) {
  if (!activeRoutes.has(tabId)) {
    // Already stopped — idempotent
    return { success: true };
  }
  await cleanup(tabId);
  console.log(`[Offscreen] Routing stopped for tab ${tabId}.`);
  return { success: true };
}

// ─── Resource Cleanup ─────────────────────────────────────────────────────────

/**
 * Release all audio resources associated with a tab route.
 * Safe to call multiple times; guards against double-cleanup.
 * @param {number} tabId
 */
async function cleanup(tabId) {
  const route = activeRoutes.get(tabId);
  if (!route) return;

  // Remove from map first to prevent re-entrant cleanup
  activeRoutes.delete(tabId);

  const { stream, audioContext, sourceNode } = route;

  // Disconnect Web Audio nodes
  try { sourceNode?.disconnect(); } catch (_) { /* ignore */ }

  // Stop all MediaStream tracks
  if (stream) {
    stream.getTracks().forEach(track => {
      try { track.stop(); } catch (_) { /* ignore */ }
    });
  }

  // Close AudioContext — releases OS-level audio hooks
  if (audioContext && audioContext.state !== 'closed') {
    try { await audioContext.close(); } catch (_) { /* ignore */ }
  }
}

// ─── Device Change Handling ───────────────────────────────────────────────────

/**
 * Handle audio device changes (e.g., Bluetooth headphones disconnect).
 * If the sink device for an active route is no longer available, stop
 * that route and notify the service worker so the popup can update.
 */
navigator.mediaDevices.addEventListener('devicechange', async () => {
  console.log('[Offscreen] Media device change detected.');

  if (activeRoutes.size === 0) return;

  let currentDevices;
  try {
    currentDevices = await navigator.mediaDevices.enumerateDevices();
  } catch (_) {
    return;
  }

  const availableOutputIds = new Set(
    currentDevices
      .filter(d => d.kind === 'audiooutput')
      .map(d => d.deviceId)
  );

  for (const [tabId, route] of activeRoutes) {
    // AudioContext.sinkId reflects the currently set device ID (Chrome 110+)
    const sinkId = route.audioContext.sinkId;

    // '' (empty string) or 'default' means system default — always present
    if (!sinkId || sinkId === '' || sinkId === 'default') continue;

    if (!availableOutputIds.has(sinkId)) {
      console.log(`[Offscreen] Sink device "${sinkId}" for tab ${tabId} is gone. Stopping route.`);
      await cleanup(tabId);
      notifyServiceWorker('ROUTING_STOPPED', { tabId, reason: 'device_disconnected' });
    }
  }
});

// ─── Service Worker Communication ────────────────────────────────────────────

/**
 * Send a notification message to the service worker.
 * Errors are suppressed — if the SW is not running, it will restart and
 * reconcile state on the next popup open.
 */
function notifyServiceWorker(type, payload) {
  chrome.runtime.sendMessage({ type, target: 'background', ...payload })
    .catch(err => {
      console.warn(`[Offscreen] Could not notify SW (${type}): ${err.message}`);
    });
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only handle messages explicitly targeted at this offscreen document
  if (message.target !== 'offscreen') return false;

  const { type, tabId } = message;

  // Basic validation — reject unknown or malformed messages
  if (!type || typeof type !== 'string') {
    sendResponse({ success: false, error: 'Invalid message type.' });
    return false;
  }
  if (tabId !== undefined && typeof tabId !== 'number') {
    sendResponse({ success: false, error: 'Invalid tabId.' });
    return false;
  }

  switch (type) {
    case 'START_ROUTING': {
      const { streamId, deviceId } = message;
      if (!streamId || typeof streamId !== 'string') {
        sendResponse({ success: false, error: 'Invalid streamId.' });
        return false;
      }
      if (!deviceId || typeof deviceId !== 'string') {
        sendResponse({ success: false, error: 'Invalid deviceId.' });
        return false;
      }
      startRouting(tabId, streamId, deviceId)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async response
    }

    case 'STOP_ROUTING': {
      stopRouting(tabId)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    default:
      sendResponse({ success: false, error: `Unknown message type: ${type}` });
      return false;
  }
});
