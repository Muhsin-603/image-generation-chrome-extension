const STATE = {
  promptQueue: [],
  currentIndex: 0,
  downloadFolder: "generated-images",
  isPaused: false,
  isRunning: false,
  chatGptTabId: null,
  runId: 0
};

const DELAYS = {
  BETWEEN_PROMPTS: 5000,
  RETRY_INTERVAL: 3000,
  MAX_RETRIES: 3
};

// Rehydrate state from chrome.storage.local
async function rehydrateState() {
  try {
    const data = await chrome.storage.local.get([
      "promptQueue",
      "currentIndex",
      "downloadFolder",
      "isPaused",
      "isRunning",
      "runId"
    ]);
    if (data.promptQueue !== undefined) STATE.promptQueue = data.promptQueue;
    if (data.currentIndex !== undefined) STATE.currentIndex = data.currentIndex;
    if (data.downloadFolder !== undefined) STATE.downloadFolder = data.downloadFolder;
    if (data.isPaused !== undefined) STATE.isPaused = data.isPaused;
    if (data.isRunning !== undefined) STATE.isRunning = data.isRunning;
    if (data.runId !== undefined) STATE.runId = data.runId;

    // If the process was active and not paused, attempt auto-resume on startup
    if (STATE.isRunning && !STATE.isPaused && STATE.promptQueue.length > 0 && STATE.currentIndex < STATE.promptQueue.length) {
      findChatGptTab().then(tabId => {
        STATE.chatGptTabId = tabId;
        processNextPrompt(STATE.runId);
      }).catch(error => {
        console.error("Failed to auto-resume on wakeup:", error);
        STATE.isRunning = false;
        saveState();
      });
    }
  } catch (error) {
    console.error("Failed to rehydrate state:", error);
  }
}

// Save state back to chrome.storage.local
async function saveState() {
  try {
    await chrome.storage.local.set({
      promptQueue: STATE.promptQueue,
      currentIndex: STATE.currentIndex,
      downloadFolder: STATE.downloadFolder,
      isPaused: STATE.isPaused,
      isRunning: STATE.isRunning,
      runId: STATE.runId
    });
  } catch (error) {
    console.error("Failed to save state to storage:", error);
  }
}

// Kick off initialization
const initializationPromise = rehydrateState();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(error => console.error("Failed to set panel behavior:", error));


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  initializationPromise.then(() => {
    const handlers = {
      START_GENERATION: () => handleStartGeneration(message),
      PAUSE_GENERATION: () => handlePauseGeneration(),
      RESUME_GENERATION: () => handleResumeGeneration(),
      CANCEL_GENERATION: () => handleCancelGeneration(),
      GET_STATUS: () => handleGetStatus(sendResponse),
      SCRAPE_CHAT: () => handleScrapeChatRequest(sendResponse),
      DOWNLOAD_SCRAPED: () => handleDownloadScraped(message, sendResponse),
      ADD_PROMPT: () => handleAddPrompt(message.prompt),
      REMOVE_PROMPT: () => sendResponse({ success: handleRemovePrompt(message.index) }),
      PROMPT_COMPLETED: () => handlePromptCompleted(message, sendResponse),
      DOWNLOAD_VIA_BACKGROUND: () => handleDownloadViaBackground(message, sendResponse)
    };

    const handler = handlers[message.type];
    if (handler) {
      handler();
      const exclusions = ["GET_STATUS", "SCRAPE_CHAT", "DOWNLOAD_SCRAPED", "REMOVE_PROMPT", "PROMPT_COMPLETED", "DOWNLOAD_VIA_BACKGROUND"];
      if (!exclusions.includes(message.type)) {
        sendResponse({ received: true });
      }
    }
  });
  return true;
});


function handleStartGeneration(message) {
  STATE.promptQueue = message.prompts;
  STATE.downloadFolder = message.downloadFolder || "generated-images";
  STATE.currentIndex = 0;
  STATE.isPaused = false;
  STATE.isRunning = true;
  STATE.runId = Date.now();

  saveState();

  findChatGptTab().then(tabId => {
    STATE.chatGptTabId = tabId;
    processNextPrompt(STATE.runId);
  }).catch(error => {
    broadcastProgress({
      status: "error",
      message: "Please open ChatGPT (chat.openai.com) in a tab first: " + error.message
    });
    STATE.isRunning = false;
    saveState();
  });
}

function handlePauseGeneration() {
  STATE.isPaused = true;
  STATE.runId = Date.now(); // Cancel any running loop
  saveState();
  broadcastProgress({ status: "paused", currentIndex: STATE.currentIndex });
}

function handleResumeGeneration() {
  STATE.isPaused = false;
  STATE.runId = Date.now();
  saveState();
  broadcastProgress({ status: "resumed", currentIndex: STATE.currentIndex });
  processNextPrompt(STATE.runId);
}

function handleCancelGeneration() {
  STATE.isRunning = false;
  STATE.isPaused = false;
  STATE.currentIndex = 0;
  STATE.runId = Date.now(); // Cancel any running loop
  saveState();

  if (STATE.chatGptTabId) {
    chrome.tabs.sendMessage(STATE.chatGptTabId, { type: "CANCEL" }).catch(() => {});
  }

  broadcastProgress({ status: "cancelled" });
}

function handleGetStatus(sendResponse) {
  sendResponse({
    isRunning: STATE.isRunning,
    isPaused: STATE.isPaused,
    currentIndex: STATE.currentIndex,
    totalPrompts: STATE.promptQueue.length,
    promptQueue: STATE.promptQueue
  });
}


async function findChatGptTab() {
  // Try common ChatGPT/OpenAI hosts first, then fall back to scanning all tabs.
  const patterns = ["*://chat.openai.com/*", "*://chatgpt.com/*", "*://*.openai.com/*"];
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (tabs && tabs.length > 0) return tabs[0].id;
    } catch (e) {
      // ignore and try next pattern
    }
  }

  // Final fallback: scan all tabs and match by hostname substring
  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    try {
      const url = tab.url || "";
      if (url.includes("chat.openai.com") || url.includes("chatgpt.com") || url.includes(".openai.com")) {
        return tab.id;
      }
    } catch (e) {
      // ignore
    }
  }

  throw new Error("No ChatGPT tab found");
}

async function ensureContentScriptReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "CHECK_READY" });
    return response && response.ready;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    });
    await delay(1000);
    return true;
  }
}


async function processNextPrompt(capturedRunId) {
  if (capturedRunId !== STATE.runId) {
    console.log("processNextPrompt: Run ID mismatch, terminating old loop.");
    return;
  }

  if (!STATE.isRunning || STATE.isPaused) return;

  if (STATE.currentIndex >= STATE.promptQueue.length) {
    STATE.isRunning = false;
    await saveState();
    broadcastProgress({
      status: "completed",
      message: "All prompts processed successfully",
      totalProcessed: STATE.promptQueue.length
    });
    return;
  }

  const currentPrompt = STATE.promptQueue[STATE.currentIndex];
  const promptNumber = STATE.currentIndex + 1;
  const totalPrompts = STATE.promptQueue.length;

  broadcastProgress({
    status: "processing",
    currentIndex: STATE.currentIndex,
    totalPrompts: totalPrompts,
    currentPrompt: currentPrompt,
    message: `Processing prompt ${promptNumber} of ${totalPrompts}`
  });

  try {
    await ensureContentScriptReady(STATE.chatGptTabId);
    if (capturedRunId !== STATE.runId) return;

    const ack = await sendStartPromptToContentScript(currentPrompt, STATE.currentIndex, capturedRunId);
    if (!ack || !ack.success) {
      throw new Error(ack ? ack.error : "Failed to start prompt processing in content script");
    }

    console.log(`Prompt ${promptNumber} started successfully. Background worker going to sleep.`);

  } catch (error) {
    if (capturedRunId !== STATE.runId) return;

    broadcastProgress({
      status: "error",
      currentIndex: STATE.currentIndex,
      message: `Error on prompt ${promptNumber}: ${error.message}`
    });

    STATE.currentIndex++;
    await saveState();
    await delay(DELAYS.BETWEEN_PROMPTS);
    if (capturedRunId !== STATE.runId) return;

    processNextPrompt(capturedRunId);
  }
}

function sendStartPromptToContentScript(promptText, index, runId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      STATE.chatGptTabId,
      {
        type: "START_PROMPT",
        promptText: promptText,
        index: index,
        runId: runId
      },
      response => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: true });
        }
      }
    );
  });
}

async function handlePromptCompleted(message, sendResponse) {
  sendResponse({ received: true });

  if (message.runId !== STATE.runId) {
    console.log(`handlePromptCompleted: Run ID mismatch (${message.runId} vs ${STATE.runId}). Ignoring.`);
    return;
  }
  if (message.index !== STATE.currentIndex) {
    console.log(`handlePromptCompleted: Index mismatch (${message.index} vs ${STATE.currentIndex}). Ignoring.`);
    return;
  }
  if (!STATE.isRunning || STATE.isPaused) {
    console.log("handlePromptCompleted: Generation is not running or is paused. Ignoring.");
    return;
  }

  const promptNumber = STATE.currentIndex + 1;
  const totalPrompts = STATE.promptQueue.length;
  const currentPrompt = STATE.promptQueue[STATE.currentIndex];

  try {
    if (message.success) {
      if (message.downloadTriggered) {
        console.log(`Image ${promptNumber} was downloaded natively by content script. Skipping background download.`);
        broadcastProgress({
          status: "downloaded",
          currentIndex: STATE.currentIndex,
          totalPrompts: totalPrompts,
          message: `Downloaded image ${promptNumber} of ${totalPrompts} (native)`
        });
      } else if (message.dataUrl) {
        let finalDataUrl = message.dataUrl;

        if (finalDataUrl.startsWith("blob:")) {
          try {
            finalDataUrl = await fetchScrapedDataUrl(STATE.chatGptTabId, finalDataUrl);
          } catch (err) {
            console.error("Failed to resolve blob URL:", err);
            throw new Error("Failed to resolve blob URL: " + err.message);
          }
        }

        await downloadGeneratedImage(finalDataUrl, STATE.currentIndex, currentPrompt);

        broadcastProgress({
          status: "downloaded",
          currentIndex: STATE.currentIndex,
          totalPrompts: totalPrompts,
          message: `Downloaded image ${promptNumber} of ${totalPrompts}`
        });
      } else {
        broadcastProgress({
          status: "warning",
          currentIndex: STATE.currentIndex,
          message: `Prompt ${promptNumber}: Completed successfully but no image URL was found.`
        });
      }
    } else {
      broadcastProgress({
        status: "warning",
        currentIndex: STATE.currentIndex,
        message: `Prompt ${promptNumber}: ${message.error || "No image generated"}`
      });
    }

    STATE.currentIndex++;
    await saveState();
    await delay(DELAYS.BETWEEN_PROMPTS);
    if (message.runId !== STATE.runId) return;

    processNextPrompt(STATE.runId);

  } catch (error) {
    if (message.runId !== STATE.runId) return;

    broadcastProgress({
      status: "error",
      currentIndex: STATE.currentIndex,
      message: `Error on prompt ${promptNumber}: ${error.message}`
    });

    STATE.currentIndex++;
    await saveState();
    await delay(DELAYS.BETWEEN_PROMPTS);
    if (message.runId !== STATE.runId) return;

    processNextPrompt(STATE.runId);
  }
}


async function downloadGeneratedImage(imageUrl, promptIndex, promptText, customFolder = null) {
  const sanitizedName = sanitizeFileName(promptText);
  const paddedIndex = String(promptIndex + 1).padStart(3, "0");
  const folder = customFolder || STATE.downloadFolder;
  const fileName = `${folder}/${paddedIndex}_${sanitizedName}.png`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: imageUrl,
        filename: fileName,
        saveAs: false,
        conflictAction: "uniquify"
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

function sanitizeFileName(text) {
  // Removes only characters strictly forbidden by Windows/Unix file systems
  return text.substring(0, 50).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}


function broadcastProgress(progressData) {
  chrome.runtime.sendMessage(progressData).catch(() => {});
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleScrapeChatRequest(sendResponse) {
  try {
    const tabId = await findChatGptTab();
    await ensureContentScriptReady(tabId);
    chrome.tabs.sendMessage(tabId, { type: "SCRAPE_CHAT" }, response => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response || { success: false, error: "No response from page" });
      }
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleDownloadScraped(message, sendResponse) {
  sendResponse({ success: true, message: "Download started" });

  try {
    const tabId = await findChatGptTab();
    await ensureContentScriptReady(tabId);
    chrome.tabs.sendMessage(tabId, {
      type: "DOWNLOAD_SCRAPED_IMAGES",
      items: message.items,
      downloadFolder: message.downloadFolder || "generated-images"
    });
  } catch (error) {
    console.error("Failed to start download in page:", error);
    broadcastProgress({
      status: "error",
      currentIndex: 0,
      message: "Failed to download: " + error.message
    });
  }
}

async function handleDownloadViaBackground(message, sendResponse) {
  try {
    await downloadGeneratedImage(message.imageUrl, message.index, message.promptText, message.downloadFolder);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

function fetchScrapedDataUrl(tabId, imageUrl) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "FETCH_DATA_URL", url: imageUrl }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.success && response.dataUrl) {
        resolve(response.dataUrl);
      } else {
        reject(new Error(response ? response.error : "Failed to fetch image"));
      }
    });
  });
}

function handleAddPrompt(prompt) {
  STATE.promptQueue.push(prompt);
  saveState();
}

function handleRemovePrompt(index) {
  if (index > STATE.currentIndex) {
    STATE.promptQueue.splice(index, 1);
    saveState();
    return true;
  }
  return false;
}
