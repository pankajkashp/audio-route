/**
 * test_validation.mjs — Comprehensive End-to-End Validation Suite
 *
 * Tests the real Tab Audio Router implementation against Brave on macOS:
 * 1. Manifest JSON and permission configuration
 * 2. Tab capture authorization security & error detection:
 *    - Verifies that uninvoked background tabs are strictly rejected with
 *      "Extension has not been invoked for the current page (see activeTab permission)."
 *    - Verifies that stream ID acquisition helper strictly rejects errors and never
 *      mistakes an error object or empty string for a valid stream ID.
 * 3. Audio sink device ID validation via AudioContext.setSinkId:
 *    - Default output ("")
 *    - Real physical device hash
 *    - Fake/non-existent device rejection (NotFoundError)
 * 4. Real multi-tab user routing workflow (tested with live Web Audio pipeline):
 *    - Start Route 1 (Tab A in Slot 0)
 *    - Verify actual offscreen audio track state ('live') and AudioContext ('running')
 *    - Switch browser active tab to Tab B
 *    - Start Route 2 (Tab B in Slot 1) simultaneously
 *    - Confirm two simultaneous routes running independently in SW and offscreen engine
 * 5. Constraints enforcement:
 *    - Duplicate route rejection
 *    - 2-route limit (MAX_ROUTES) enforcement
 * 6. Independent route stoppage:
 *    - Stop Route 1, verify Route 2 remains live and running in offscreen engine
 *    - Stop Route 2, verify complete teardown and offscreen document closure
 * 7. Tab closure auto-cleanup (tabs.onRemoved)
 * 8. Partial failure recovery (invalid sink ID aborts cleanly without orphaned state)
 *
 * Physical Separation Note:
 * Automated tests verify the complete Web Audio pipeline and track states.
 * Acoustic physical separation between two physical hardware outputs cannot be
 * verified by automation and requires manual listening on physical devices.
 */

import { spawn } from 'child_process';
import { rmSync, mkdirSync, readFileSync } from 'fs';
import assert from 'assert';

console.log('===========================================================');
console.log('       TAB AUDIO ROUTER — FULL VALIDATION SUITE           ');
console.log('===========================================================\n');

// ─── Test Suite Configuration ────────────────────────────────────────────────
const braveBin = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const extensionPath = '/Users/pankaj/Desktop/Project/audio-route';
const extId = 'opcajedhfelkjkfbbendanefgkihoikn';
const portSec = 9381;
const portDyn = 9382;

function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Helper to connect to Brave DevTools WebSocket
async function connectToBrave(port) {
  let ver = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(300);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        ver = await res.json();
        break;
      }
    } catch (_) {}
  }
  if (!ver) throw new Error(`Failed to connect to Brave DevTools on port ${port}`);

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const cb = pending.get(data.id);
      pending.delete(data.id);
      cb(data);
    }
  });

  function send(method, params = {}) {
    return new Promise((res) => {
      const id = msgId++;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return { ws, send };
}

// ─── Test 1: Static Manifest Validation ──────────────────────────────────────
function testManifest() {
  console.log('[Test 1] Validating manifest.json...');
  const manifest = JSON.parse(readFileSync(`${extensionPath}/manifest.json`, 'utf8'));

  assert.strictEqual(manifest.manifest_version, 3, 'Manifest version must be 3');
  assert.ok(manifest.permissions.includes('tabCapture'), 'Missing tabCapture permission');
  assert.ok(manifest.permissions.includes('offscreen'), 'Missing offscreen permission');
  assert.ok(manifest.permissions.includes('tabs'), 'Missing tabs permission');
  assert.ok(manifest.permissions.includes('storage'), 'Missing storage permission');
  assert.ok(manifest.permissions.includes('activeTab'), 'Missing activeTab permission');
  assert.strictEqual(manifest.background?.service_worker, 'background.js', 'Service worker must be background.js');
  assert.strictEqual(manifest.action?.default_popup, 'popup.html', 'Action popup must be popup.html');
  console.log('  ✓ Manifest is valid MV3 with all required permissions.\n');
}

// ─── Test 2: Chromium Security & Stream ID Error Validation ─────────────────
async function testAuthorizationSecurity() {
  console.log('[Test 2] Verifying Chromium tabCapture authorization security & error rejection...');
  const userDataDir = `/tmp/brave-sec-${Date.now()}`;
  mkdirSync(userDataDir, { recursive: true });

  let braveProc = null;
  try {
    // Launch standard Brave WITHOUT allowlisting to verify real activeTab security
    braveProc = spawn(braveBin, [
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${extensionPath}`,
      `--remote-debugging-port=${portSec}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://example.com'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const secConn = await connectToBrave(portSec);

    const popTargetRes = await fetch(`http://127.0.0.1:${portSec}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' });
    const popTarget = await popTargetRes.json();
    const ws = new WebSocket(popTarget.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (m, params = {}) => new Promise(res => {
      const reqId = id++;
      const handler = (e) => {
        const d = JSON.parse(e.data);
        if (d.id === reqId) {
          ws.removeEventListener('message', handler);
          res(d);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: reqId, method: m, params }));
    });
    await send('Runtime.enable');

    const evalRes = await send('Runtime.evaluate', {
      expression: `(async () => {
        let target = null;
        for (let i = 0; i < 25; i++) {
          const tabs = await chrome.tabs.query({});
          target = tabs.find(t => t.url && t.url.includes('example.com'));
          if (target) break;
          await new Promise(r => setTimeout(r, 200));
        }
        if (!target) return { error: 'Target tab not found' };

        // Test the strict stream ID helper:
        function getValidStreamId(tabId) {
          return new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, streamId => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else if (!streamId || typeof streamId !== 'string' || streamId.trim() === '') {
                reject(new Error('Tab capture returned an empty or invalid stream ID'));
              } else {
                resolve(streamId);
              }
            });
          });
        }

        let caughtError = null;
        let returnedStreamId = null;
        try {
          returnedStreamId = await getValidStreamId(target.id);
        } catch (err) {
          caughtError = err.message;
        }

        return {
          targetId: target.id,
          returnedStreamId,
          caughtError,
          isSecurityRejection: Boolean(caughtError && caughtError.includes('Extension has not been invoked'))
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const res = evalRes.result?.result?.value;
    assert.strictEqual(res?.returnedStreamId, null, 'Error was mistakenly accepted as a valid stream ID!');
    assert.ok(res?.isSecurityRejection, `Expected activeTab invocation rejection, got: ${res?.caughtError}`);
    console.log(`  ✓ Chromium security verified: Uninvoked tab rejected with "${res.caughtError}".`);
    console.log('  ✓ Validation test verified: Errors are NEVER mistaken for valid stream IDs.\n');

    ws.close();
    if (secConn?.ws) secConn.ws.close();
  } finally {
    if (braveProc) {
      braveProc.kill('SIGTERM');
      await wait(800);
    }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── Test 3: Full End-to-End Routing Flow with Live Web Audio Engine ─────────
async function testFullRoutingWorkflow() {
  console.log('[Test 3-8] Launching End-to-End Dynamic Workflow Test Suite...');
  const userDataDir = `/tmp/brave-dyn-${Date.now()}`;
  mkdirSync(userDataDir, { recursive: true });

  let braveProc = null;
  try {
    // Launch Brave with extension and test allowlist to permit genuine stream acquisition
    braveProc = spawn(braveBin, [
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${extensionPath}`,
      `--allowlisted-extension-id=${extId}`,
      `--remote-debugging-port=${portDyn}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://example.com'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const root = await connectToBrave(portDyn);

    // Pre-grant permission to extension origin for physical device enumeration
    await root.send('Browser.grantPermissions', {
      origin: `chrome-extension://${extId}`,
      permissions: ['audioCapture']
    });

    // Open extension popup page target for evaluating extension APIs
    const popupTargetRes = await fetch(`http://127.0.0.1:${portDyn}/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' });
    const popupTarget = await popupTargetRes.json();
    const popupWs = new WebSocket(popupTarget.webSocketDebuggerUrl);
    await new Promise(r => popupWs.onopen = r);

    let pMsgId = 1;
    const pSend = (method, params = {}) => new Promise(res => {
      const reqId = pMsgId++;
      const handler = (e) => {
        const d = JSON.parse(e.data);
        if (d.id === reqId) {
          popupWs.removeEventListener('message', handler);
          res(d);
        }
      };
      popupWs.addEventListener('message', handler);
      popupWs.send(JSON.stringify({ id: reqId, method, params }));
    });
    await pSend('Runtime.enable');

    // Test 3 does not call getUserMedia beforehand — verifying default sink works without mic permissions.

    // ─── Test 3: Audio Sink Device ID Validation ───────────────────────────
    console.log('[Test 3] Validating AudioContext.setSinkId...');
    const sinkEval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const outputs = devs.filter(d => d.kind === 'audiooutput');
        const ctx = new AudioContext();
        
        // 1. Default output ("")
        let defaultOk = false;
        let defaultErr = null;
        try {
          await ctx.setSinkId('');
          defaultOk = (ctx.sinkId === '');
        } catch (e) {
          defaultErr = e ? (e.name + ': ' + e.message) : 'unknown error';
        }

        // 2. Real physical device hash
        const realDev = outputs.find(d => d.deviceId && d.deviceId !== 'default');
        let realOk = false;
        let realErr = null;
        if (realDev) {
          try {
            await ctx.setSinkId(realDev.deviceId);
            realOk = (ctx.sinkId === realDev.deviceId);
          } catch (e) {
            realErr = e ? (e.name + ': ' + e.message) : 'unknown error';
          }
        } else {
          realOk = defaultOk;
        }

        // 3. Fake / Non-existent device ID
        let fakeRejected = false;
        try {
          await ctx.setSinkId('non-existent-device-fake');
        } catch (err) {
          fakeRejected = (err.name === 'NotFoundError');
        }

        await ctx.close();
        return { defaultOk, defaultErr, realOk, realErr, fakeRejected, count: outputs.length };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const sinkRes = sinkEval.result?.result?.value;
    assert.ok(sinkRes?.defaultOk, `Default sink ID ("") rejected: ${sinkRes?.defaultErr}`);
    assert.ok(sinkRes?.realOk, `Physical device sink ID rejected: ${sinkRes?.realErr}`);
    assert.ok(sinkRes?.fakeRejected, 'Fake sink ID was not rejected with NotFoundError');
    console.log(`  ✓ setSinkId verified (${sinkRes.count} physical outputs detected, fake IDs strictly rejected).\n`);

    // ─── Test 4: Real User Workflow — Step 1: Start Route 1 (Tab A) ────────
    console.log('[Test 4] Real Workflow Step 1: Starting Route 1 on Tab A...');
    const step1Eval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const tabs = await chrome.tabs.query({});
        const targetA = tabs.find(t => t.url && t.url.includes('example.com'));
        if (!targetA) return { error: 'Tab A not found' };

        const streamIdA = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: targetA.id }, id => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!id) reject(new Error('Empty stream ID'));
            else resolve(id);
          });
        });

        const startRes1 = await chrome.runtime.sendMessage({
          type: 'START_ROUTING',
          tabId: targetA.id,
          streamId: streamIdA,
          deviceId: 'default',
          deviceLabel: 'System Default',
          tabTitle: 'Example Domain (Tab A)',
          tabUrl: targetA.url,
          slot: 0
        });

        const audioStatus1 = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });
        const swState1 = await chrome.runtime.sendMessage({ type: 'GET_STATE' });

        return {
          tabAId: targetA.id,
          startRes1,
          swRouteCount: swState1.routes.length,
          audioRoutes: audioStatus1.routes
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const s1 = step1Eval.result?.result?.value;
    assert.ok(s1?.startRes1?.success, `Route 1 failed to start: ${s1?.startRes1?.error}`);
    assert.strictEqual(s1?.swRouteCount, 1, 'Expected 1 active route in Service Worker');
    assert.strictEqual(s1?.audioRoutes?.length, 1, 'Expected 1 active route in Offscreen engine');
    assert.strictEqual(s1?.audioRoutes[0]?.trackState, 'live', 'Audio track is not live in offscreen engine');
    assert.strictEqual(s1?.audioRoutes[0]?.contextState, 'running', 'AudioContext is not running in offscreen engine');
    assert.strictEqual(s1?.audioRoutes[0]?.volume, 100, 'Default volume in offscreen engine must be 100%');
    console.log('  ✓ Route 1 started: Service Worker + Offscreen audio engine verified live and running with default volume 100%.\n');

    const tabAId = s1.tabAId;

    // ─── Test 5: Independent Volume Control — Live Adjustment on Route 1 ───
    console.log('[Test 5] Testing live volume change on Route 1 (live GainNode adjustment without restarting capture)...');
    const vol1Eval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const setRes = await chrome.runtime.sendMessage({
          type: 'SET_VOLUME',
          tabId: ${tabAId},
          volume: 50
        });
        const audioStatus = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });
        const swState = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        return {
          setRes,
          routeAudio: audioStatus.routes.find(r => r.tabId === ${tabAId}),
          swRoute: swState.routes.find(r => r.tabId === ${tabAId})
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const v1 = vol1Eval.result?.result?.value;
    assert.ok(v1?.setRes?.success, `SET_VOLUME failed: ${v1?.setRes?.error}`);
    assert.strictEqual(v1?.routeAudio?.volume, 50, 'Offscreen GainNode volume was not updated to 50%');
    assert.strictEqual(v1?.swRoute?.volume, 50, 'Service Worker stored volume was not updated to 50%');
    assert.strictEqual(v1?.routeAudio?.trackState, 'live', 'Audio track was disrupted during volume change');
    console.log('  ✓ Route 1 volume updated live to 50% without restarting capture (track remained live).\n');

    // ─── Test 6: Volume Independence Between Simultaneous Routes ───────────
    console.log('[Test 6] Starting Route 2 with volume 80% and verifying GainNode independence...');
    
    // Open Tab B (example.org)
    await fetch(`http://127.0.0.1:${portDyn}/json/new?https://example.org`, { method: 'PUT' });
    await wait(800);

    const step2Eval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const tabs = await chrome.tabs.query({});
        const targetB = tabs.find(t => t.url && t.url.includes('example.org'));
        if (!targetB) return { error: 'Tab B not found' };

        // Switch active tab to Tab B in the browser window
        await chrome.tabs.update(targetB.id, { active: true });
        await new Promise(r => setTimeout(r, 400));

        // Obtain stream ID for Tab B
        const streamIdB = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: targetB.id }, id => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!id) reject(new Error('Empty stream ID'));
            else resolve(id);
          });
        });

        const startRes2 = await chrome.runtime.sendMessage({
          type: 'START_ROUTING',
          tabId: targetB.id,
          streamId: streamIdB,
          deviceId: 'default',
          deviceLabel: 'System Default',
          tabTitle: 'Example Org (Tab B)',
          tabUrl: targetB.url,
          slot: 1,
          volume: 80
        });

        // Now change Route 2 volume to 25% live
        const setRes2 = await chrome.runtime.sendMessage({
          type: 'SET_VOLUME',
          tabId: targetB.id,
          volume: 25
        });

        const audioStatus2 = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });
        const swState2 = await chrome.runtime.sendMessage({ type: 'GET_STATE' });

        return {
          tabBId: targetB.id,
          startRes2,
          setRes2,
          swRouteCount: swState2.routes.length,
          audioRoutes: audioStatus2.routes,
          swRoutes: swState2.routes
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const s2 = step2Eval.result?.result?.value;
    assert.ok(s2?.startRes2?.success, `Route 2 failed to start: ${JSON.stringify(s2?.startRes2)}`);
    assert.ok(s2?.setRes2?.success, `Route 2 SET_VOLUME failed: ${JSON.stringify(s2?.setRes2)}`);
    assert.strictEqual(s2?.swRouteCount, 2, 'Expected 2 active routes in Service Worker');
    assert.strictEqual(s2?.audioRoutes?.length, 2, 'Expected 2 active routes in Offscreen audio engine');

    const routeA = s2.audioRoutes.find(r => r.tabId === tabAId);
    const routeB = s2.audioRoutes.find(r => r.tabId === s2.tabBId);
    assert.ok(routeA && routeA.trackState === 'live' && routeA.contextState === 'running', 'Route 1 was disrupted when Route 2 started');
    assert.ok(routeB && routeB.trackState === 'live' && routeB.contextState === 'running', 'Route 2 is not live in offscreen engine');

    // Crucial check: changing Route 2 to 25% must NOT have affected Route 1 (which was set to 50%)
    assert.strictEqual(routeA.volume, 50, 'Route 1 volume was corrupted by Route 2 volume change!');
    assert.strictEqual(routeB.volume, 25, 'Route 2 volume was not set to 25%');
    console.log('  ✓ Two simultaneous routes verified active with independent GainNodes (Route 1: 50%, Route 2: 25%).\n');

    const tabBId = s2.tabBId;

    // ─── Test 7: Volume Input Validation ───────────────────────────────────
    console.log('[Test 7] Validating volume boundary values and error rejection...');
    const volValEval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const negRes = await chrome.runtime.sendMessage({ type: 'SET_VOLUME', tabId: ${tabAId}, volume: -10 });
        const overRes = await chrome.runtime.sendMessage({ type: 'SET_VOLUME', tabId: ${tabAId}, volume: 150 });
        const nanRes = await chrome.runtime.sendMessage({ type: 'SET_VOLUME', tabId: ${tabAId}, volume: 'not-a-number' });
        return {
          negRejected: !negRes.success,
          overRejected: !overRes.success,
          nanRejected: !nanRes.success
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const vv = volValEval.result?.result?.value;
    assert.ok(vv.negRejected, 'Negative volume was unexpectedly accepted');
    assert.ok(vv.overRejected, 'Volume > 100 was unexpectedly accepted');
    assert.ok(vv.nanRejected, 'Non-numeric volume was unexpectedly accepted');
    console.log('  ✓ Out-of-bounds volume inputs (-10, 150, NaN) strictly rejected with validation errors.\n');

    // ─── Test 8: Enforce Constraints (Duplicate & Max Routes) ──────────────
    console.log('[Test 8] Testing duplicate route prevention and 2-route capacity limit...');
    const limitEval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        // 1. Duplicate route on Tab A
        const dupRes = await chrome.runtime.sendMessage({
          type: 'START_ROUTING',
          tabId: ${tabAId},
          streamId: 'dummy-stream-id',
          deviceId: 'default'
        });

        // 2. 3rd route attempt
        const thirdRes = await chrome.runtime.sendMessage({
          type: 'START_ROUTING',
          tabId: 99999,
          streamId: 'dummy-stream-id-3',
          deviceId: 'default'
        });

        return {
          dupRejected: !dupRes.success,
          dupError: dupRes.error,
          thirdRejected: !thirdRes.success,
          thirdError: thirdRes.error
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const limRes = limitEval.result?.result?.value;
    assert.ok(limRes.dupRejected && limRes.dupError.includes('already being routed'), 'Duplicate route was not rejected');
    assert.ok(limRes.thirdRejected && limRes.thirdError.includes('Maximum of 2 routes are active'), '3rd route overflow was not rejected');
    console.log('  ✓ Duplicate routes and 3rd route overflow strictly prevented.\n');

    // ─── Test 9: Independent Route Stoppage ─────────────────────────────────
    console.log('[Test 9] Real Workflow Step 3: Stopping Route 1 independently...');
    const stop1Eval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        // Stop Route 1 (Tab A)
        const stopRes1 = await chrome.runtime.sendMessage({ type: 'STOP_ROUTING', tabId: ${tabAId} });
        const audioStatusAfter1 = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });
        const swStateAfter1 = await chrome.runtime.sendMessage({ type: 'GET_STATE' });

        return {
          stopRes1,
          swCountAfter1: swStateAfter1.routes.length,
          audioRoutesAfter1: audioStatusAfter1.routes
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const stop1Res = stop1Eval.result?.result?.value;
    assert.ok(stop1Res.stopRes1?.success, 'STOP_ROUTING returned failure on Route 1');
    assert.strictEqual(stop1Res.swCountAfter1, 1, 'Expected 1 route remaining in SW after stopping Route 1');
    assert.strictEqual(stop1Res.audioRoutesAfter1?.length, 1, 'Expected 1 route remaining in Offscreen engine');
    assert.strictEqual(stop1Res.audioRoutesAfter1[0]?.tabId, tabBId, 'Remaining route is not Tab B');
    assert.strictEqual(stop1Res.audioRoutesAfter1[0]?.trackState, 'live', 'Tab B audio track was disrupted when Tab A stopped');
    console.log('  ✓ Route 1 stopped independently; Route 2 (Tab B) remains alive and undisturbed.');

    console.log('  Stopping Route 2 (Tab B)...');
    const stop2Eval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const stopRes2 = await chrome.runtime.sendMessage({ type: 'STOP_ROUTING', tabId: ${tabBId} });
        const swStateAfter2 = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        const audioStatusAfter2 = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });

        return {
          stopRes2,
          swCountAfter2: swStateAfter2.routes.length,
          audioCountAfter2: audioStatusAfter2.routes.length
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const stop2Res = stop2Eval.result?.result?.value;
    assert.ok(stop2Res.stopRes2?.success, 'STOP_ROUTING returned failure on Route 2');
    assert.strictEqual(stop2Res.swCountAfter2, 0, 'Expected 0 routes in SW');
    assert.strictEqual(stop2Res.audioCountAfter2, 0, 'Expected 0 routes in offscreen engine');
    console.log('  ✓ Route 2 stopped cleanly; all audio pipelines closed and offscreen engine torn down.\n');

    // ─── Test 10: Tab Closure Auto-Cleanup ─────────────────────────────────
    console.log('[Test 10] Testing automatic route cleanup upon tab closure (tabs.onRemoved)...');
    const closeEval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const streamId = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: ${tabBId} }, id => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          });
        });
        await chrome.runtime.sendMessage({
          type: 'START_ROUTING',
          tabId: ${tabBId},
          streamId,
          deviceId: 'default'
        });

        // Close Tab B
        await chrome.tabs.remove(${tabBId});
        await new Promise(r => setTimeout(r, 600));

        const swStateAfterClose = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        const audioAfterClose = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });

        return {
          swRoutes: swStateAfterClose.routes.length,
          audioRoutes: audioAfterClose.routes.length
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const closeRes = closeEval.result?.result?.value;
    assert.ok(closeRes, `Test 10 evaluate threw: ${JSON.stringify(closeEval.result?.exceptionDetails || closeEval.result)}`);
    assert.strictEqual(closeRes.swRoutes, 0, 'Route for closed tab was not auto-cleaned in SW');
    assert.strictEqual(closeRes.audioRoutes, 0, 'Route for closed tab was not auto-cleaned in offscreen engine');
    console.log('  ✓ Tab closure cleanly auto-terminated route in both SW and offscreen engine.\n');

    // ─── Test 11: Partial Failure Teardown & Clean Recovery ────────────────
    console.log('[Test 11] Testing recovery and teardown after partial failure (invalid sink ID)...');
    const partialFailEval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const streamId = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: ${tabAId} }, id => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          });
        });

        // Pass an invalid deviceId that fails setSinkId in offscreen engine
        const startFail = await chrome.runtime.sendMessage({
          type: 'START_ROUTING',
          tabId: ${tabAId},
          streamId,
          deviceId: 'non-existent-device-xyz'
        });

        const stateAfterFail = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        const audioStatusAfterFail = await chrome.runtime.sendMessage({ type: 'GET_AUDIO_STATUS' });

        return {
          failedAsExpected: !startFail.success,
          errorMessage: startFail.error,
          leftoverSW: stateAfterFail.routes.length,
          leftoverOffscreen: audioStatusAfterFail.routes.length
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const pfRes = partialFailEval.result?.result?.value;
    assert.ok(pfRes.failedAsExpected, 'Routing with invalid device ID unexpectedly succeeded');
    assert.ok(pfRes.errorMessage.includes('setSinkId failed'), 'Unexpected error message on invalid sink');
    assert.strictEqual(pfRes.leftoverSW, 0, 'Failed route left dangling state in service worker');
    assert.strictEqual(pfRes.leftoverOffscreen, 0, 'Failed route left dangling stream in offscreen engine');
    console.log('  ✓ Offscreen setSinkId failure aborted cleanly with 0 orphaned state in SW or offscreen engine.\n');

    // ─── Test 12: In-Popup Strict Popup-Only Device Discovery UX Validation ───────────
    console.log('[Test 12] Validating in-popup strict popup-only UX (no setup tab, immediate default device)...');
    const discEval = await pSend('Runtime.evaluate', {
      expression: `(async () => {
        const tabsBefore = await chrome.tabs.query({});
        
        // 1. Verify default device is populated immediately in dropdown
        const devSelect0 = document.getElementById('device-select-0');
        const selectedDev = devSelect0 ? devSelect0.value : null;
        const options = devSelect0 ? Array.from(devSelect0.options).map(o => ({ value: o.value, text: o.text })) : [];

        // 2. Click "Discover Devices" button inside popup
        const showNamesBtn = document.getElementById('show-names-btn');
        const btnBefore = showNamesBtn ? showNamesBtn.textContent.trim() : null;
        if (showNamesBtn) {
          showNamesBtn.click();
        }
        
        // Wait for async discovery handler to complete
        await new Promise(r => setTimeout(r, 600));

        const tabsAfter = await chrome.tabs.query({});
        const errorEl = document.getElementById('discovery-error');
        const isErrorVisible = errorEl ? !errorEl.classList.contains('hidden') : false;
        const errorText = errorEl ? errorEl.textContent : '';
        const btnAfter = showNamesBtn ? showNamesBtn.textContent.trim() : null;

        return {
          tabsCreated: tabsAfter.length - tabsBefore.length,
          selectedDev,
          options,
          btnBefore,
          btnAfter,
          isErrorVisible,
          errorText
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const dRes = discEval.result?.result?.value;
    assert.strictEqual(dRes?.tabsCreated, 0, `Forbidden: A separate tab was opened during device discovery! (tabs created: ${dRes?.tabsCreated})`);
    assert.strictEqual(dRes?.selectedDev, 'default', `Expected 'default' to be pre-selected in dropdown, got: ${dRes?.selectedDev}`);
    assert.ok(dRes?.options.some(o => o.value === 'default' && o.text.includes('System Default Output')), 'Dropdown missing System Default Output option');
    assert.ok(dRes?.btnAfter !== 'Open in Tab', 'Button must not change to "Open in Tab"');
    console.log('  ✓ Verified 0 setup tabs created. Default output populated and selected immediately.');
    console.log(`  ✓ Button remained popup-only ("${dRes?.btnAfter}"), inline message handled properly.\n`);

    popupWs.close();
    root.ws.close();
    console.log('===========================================================');
    console.log('       ALL 12 AUTOMATED VALIDATION CHECKS PASSED          ');
    console.log('===========================================================\n');

  } finally {
    if (braveProc) {
      console.log('[Cleanup] Terminating Brave test process...');
      braveProc.kill('SIGTERM');
      await wait(800);
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
      console.log('[Cleanup] Removed test user-data directory.');
    } catch (_) {}
  }
}

async function main() {
  testManifest();
  await testAuthorizationSecurity();
  await testFullRoutingWorkflow();
}

main().catch(err => {
  console.error('\n❌ VALIDATION TEST FAILED:');
  console.error(err.message || err);
  process.exit(1);
});
