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
  console.log(`[Offscreen:startRouting] [Stage 1: getUserMedia] Starting tab capture stream for tab ${tabId}...`);
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
    console.log(`[Offscreen:startRouting] [Stage 1: getUserMedia] Success: Stream obtained with ${stream.getAudioTracks().length} track(s).`);
  } catch (err) {
    console.error(`[Offscreen:startRouting] [Stage 1: getUserMedia] FAILED for tab ${tabId}: ${err.name} — ${err.message}`);
    return {
      success: false,
      error: `[getUserMedia stage failed]: ${err.name} — ${err.message}`
    };
  }

  // ── Step 2: Create AudioContext ──────────────────────────────────────────
  console.log(`[Offscreen:startRouting] [Stage 2: AudioContext] Initialising AudioContext for tab ${tabId}...`);
  let audioContext;
  try {
    const trackSettings = stream.getAudioTracks()[0]?.getSettings();
    const contextOptions = (trackSettings?.sampleRate && trackSettings.sampleRate >= 8000 && trackSettings.sampleRate <= 96000)
      ? { sampleRate: trackSettings.sampleRate }
      : {};
    audioContext = new AudioContext(contextOptions);
    console.log(`[Offscreen:startRouting] [Stage 2: AudioContext] Created AudioContext (sampleRate: ${audioContext.sampleRate}Hz, state: ${audioContext.state}).`);
  } catch (err) {
    console.warn(`[Offscreen:startRouting] [Stage 2: AudioContext] Custom constructor failed (${err.message}); falling back to default constructor.`);
    try {
      audioContext = new AudioContext();
    } catch (ctxErr) {
      console.error(`[Offscreen:startRouting] [Stage 2: AudioContext] FAILED: ${ctxErr.name} — ${ctxErr.message}`);
      stream.getTracks().forEach(t => t.stop());
      return {
        success: false,
        error: `[AudioContext stage failed]: ${ctxErr.name} — ${ctxErr.message}`
      };
    }
  }

  // Ensure AudioContext is running; offscreen contexts may initialize as suspended
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
      console.log(`[Offscreen:startRouting] [Stage 2: AudioContext] Resumed context to state: ${audioContext.state}.`);
    } catch (err) {
      console.warn(`[Offscreen:startRouting] [Stage 2: AudioContext] Resume note: ${err.message}`);
    }
  }

  // ── Step 3: Route to the selected output device ──────────────────────────
  console.log(`[Offscreen:startRouting] [Stage 3: setSinkId] Configuring sink device "${deviceId}" for tab ${tabId}...`);
  if (typeof audioContext.setSinkId === 'function') {
    // 'default' or empty string represents system default output in W3C Audio Output spec
    const targetSinkId = (!deviceId || deviceId === 'default') ? '' : deviceId;
    try {
      await audioContext.setSinkId(targetSinkId);
      console.log(`[Offscreen:startRouting] [Stage 3: setSinkId] Success: AudioContext routed to sink "${audioContext.sinkId}".`);
    } catch (err) {
      console.error(`[Offscreen:startRouting] [Stage 3: setSinkId] FAILED for device "${deviceId}": ${err.name} — ${err.message}`);
      // Clean up before returning
      stream.getTracks().forEach(t => t.stop());
      try { await audioContext.close(); } catch (_) {}
      return {
        success: false,
        error: `[setSinkId stage failed]: setSinkId failed: ${err.name} — ${err.message}. The device may be unavailable or disconnected.`
      };
    }
  } else {
    console.warn(`[Offscreen:startRouting] [Stage 3: setSinkId] AudioContext.setSinkId is not available (tab ${tabId}). ` +
                 `Audio will route to the system default output.`);
  }

  // ── Step 4: Connect source → GainNode → destination ──────────────────────
  console.log(`[Offscreen:startRouting] [Stage 4: audioNodes] Connecting source → GainNode → destination for tab ${tabId}...`);
  const numVol = Number(volume);
  const initialPercent = (!isNaN(numVol) && numVol >= 0 && numVol <= 100) ? numVol : 100;
  const initialGain = initialPercent / 100;

  let sourceNode, gainNode;
  try {
    sourceNode = audioContext.createMediaStreamSource(stream);
    gainNode = audioContext.createGain();

    gainNode.gain.setValueAtTime(initialGain, audioContext.currentTime);

    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    console.log(`[Offscreen:startRouting] [Stage 4: audioNodes] Pipeline connected with initial volume ${initialPercent}%.`);
  } catch (err) {
    console.error(`[Offscreen:startRouting] [Stage 4: audioNodes] FAILED: ${err.name} — ${err.message}`);
    stream.getTracks().forEach(t => t.stop());
    try { await audioContext.close(); } catch (_) {}
    return {
      success: false,
      error: `[audioNodes stage failed]: ${err.name} — ${err.message}`
    };
  }

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
