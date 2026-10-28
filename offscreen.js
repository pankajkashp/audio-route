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
async function startRouting(tabId, streamId, deviceId, volume = 100) {
  // Idempotent: stop any existing route for this tab before creating a new one
  if (activeRoutes.has(tabId)) {
    await cleanup(tabId);
  }

  // ── Step 1: Materialise the captured stream ──────────────────────────────
  // Bounded retry (1 retry after 100ms) only for transient initialization races (AbortError/NotReadableError)
  let stream;
  let lastGUMError;
  for (let attempt = 0; attempt < 2; attempt++) {
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
      break;
    } catch (err) {
      lastGUMError = err;
      if (attempt === 0 && (err.name === 'AbortError' || err.name === 'NotReadableError')) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      return {
        success: false,
        error: `getUserMedia failed: ${err.name} — ${err.message}`
      };
    }
  }

  if (!stream) {
    return {
      success: false,
      error: `getUserMedia failed: ${lastGUMError?.name ?? 'UnknownError'} — ${lastGUMError?.message ?? 'No stream produced'}`
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
      try { await audioContext.close(); } catch (_) {}
      return {
        success: false,
        error: `setSinkId failed: ${err.name} — ${err.message}. ` +
               `The device may be unavailable or permission was denied.`
      };
    }
  } else {
    console.warn(`[Offscreen] AudioContext.setSinkId is not available (tab ${tabId}). ` +
                 `Audio will route to the system default output.`);
  }

  // ── Step 4: Connect source → GainNode → destination ──────────────────────
  // An independent GainNode per route controls volume live without restarting capture.
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const gainNode = audioContext.createGain();

  // Validate and apply initial gain (0.0 to 1.0)
  const numVol = Number(volume);
  const initialPercent = (!isNaN(numVol) && numVol >= 0 && numVol <= 100) ? numVol : 100;
  const initialGain = initialPercent / 100;
  gainNode.gain.setValueAtTime(initialGain, audioContext.currentTime);

  sourceNode.connect(gainNode);
  gainNode.connect(audioContext.destination);

  // Resume again if AudioContext entered suspended state during node connections
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (_) {}
  }

  // ── Step 5: Store state ──────────────────────────────────────────────────
  activeRoutes.set(tabId, {
    stream,
    audioContext,
    sourceNode,
    gainNode,
    volume: initialPercent
  });

  // ── Step 6: Register lifecycle listeners ────────────────────────────────
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.addEventListener('ended', () => {
      console.log(`[Offscreen] Audio track ended for tab ${tabId}. Auto-cleaning up.`);
      cleanup(tabId);
      notifyServiceWorker('ROUTING_STOPPED', { tabId, reason: 'track_ended' });
    }, { once: true });
  }

  console.log(`[Offscreen] Routing active for tab ${tabId} → device "${deviceId}" (vol: ${initialPercent}%)`);
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

  const { stream, audioContext, sourceNode, gainNode } = route;

  // Disconnect Web Audio nodes
  try { sourceNode?.disconnect(); } catch (_) { /* ignore */ }
  try { gainNode?.disconnect(); } catch (_) { /* ignore */ }

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

/**
 * Set live volume for an active route without restarting capture.
 * @param {number} tabId
 * @param {number} volume - Percentage (0 to 100)
 * @returns {{success: boolean, error?: string, volume?: number}}
 */
function setVolume(tabId, volume) {
  const route = activeRoutes.get(tabId);
  if (!route) {
    return { success: false, error: 'Route not found for tab.' };
  }

  const num = Number(volume);
  if (isNaN(num) || num < 0 || num > 100) {
    return { success: false, error: 'Volume must be a number between 0 and 100.' };
  }

  const gainValue = num / 100;
  try {
    route.gainNode.gain.setValueAtTime(gainValue, route.audioContext.currentTime);
    route.volume = num;
    console.log(`[Offscreen] Live volume updated for tab ${tabId} → ${num}% (gain: ${gainValue})`);
    return { success: true, volume: num };
  } catch (err) {
    return { success: false, error: `Failed to set volume: ${err.message}` };
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
      const { streamId, deviceId, volume } = message;
      if (!streamId || typeof streamId !== 'string') {
        sendResponse({ success: false, error: 'Invalid streamId.' });
        return false;
      }
      if (!deviceId || typeof deviceId !== 'string') {
        sendResponse({ success: false, error: 'Invalid deviceId.' });
        return false;
      }
      startRouting(tabId, streamId, deviceId, volume)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async response
    }

    case 'SET_VOLUME': {
      const { volume } = message;
      const res = setVolume(tabId, volume);
      sendResponse(res);
      return false;
    }

    case 'STOP_ROUTING': {
      stopRouting(tabId)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_AUDIO_STATUS': {
      const routesStatus = [];
      for (const [id, route] of activeRoutes.entries()) {
        const track = route.stream?.getAudioTracks()[0];
        routesStatus.push({
          tabId: id,
          streamActive: Boolean(route.stream?.active),
          trackState: track?.readyState ?? 'none',
          contextState: route.audioContext?.state ?? 'none',
          sinkId: route.audioContext?.sinkId ?? '',
          volume: route.volume ?? 100
        });
      }
      sendResponse({ success: true, routes: routesStatus });
      return false;
    }

    default:
      sendResponse({ success: false, error: `Unknown message type: ${type}` });
      return false;
  }
});
