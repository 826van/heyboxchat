const DEBUGGER_VERSION = "1.3";

function targetFor(tabId) {
  return { tabId };
}

function chromeApiCall(run) {
  return new Promise((resolve, reject) => {
    try {
      run((result) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function attachDebugger(tabId) {
  const target = targetFor(tabId);
  try {
    await chromeApiCall((done) => chrome.debugger.attach(target, DEBUGGER_VERSION, done));
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!/attached/i.test(message)) throw error;
  }
  return target;
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  const target = await attachDebugger(tabId);
  return chromeApiCall((done) => chrome.debugger.sendCommand(target, method, params, done));
}

async function detachDebugger(tabId) {
  try {
    await chromeApiCall((done) => chrome.debugger.detach(targetFor(tabId), done));
  } catch {
    // The tab may already be detached or gone.
  }
}

async function clickAt(tabId, point) {
  const { x, y } = point;
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none"
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: "No sender tab." });
    return false;
  }

  (async () => {
    if (message?.type === "xhs-debugger-click") {
      await clickAt(tabId, message.point);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "xhs-debugger-insert-text") {
      await sendDebuggerCommand(tabId, "Input.insertText", {
        text: String(message.text || "")
      });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "xhs-debugger-detach") {
      await detachDebugger(tabId);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown debugger command." });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});
