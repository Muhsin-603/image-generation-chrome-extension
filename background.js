const STATE = {
  promptQueue: [],
  currentIndex: 0,
  downloadFolder: "generated-images",
  isPaused: false,
  isRunning: false,
  chatGptTabId: null
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
      "isRunning"
    ]);
    if (data.promptQueue !== undefined) STATE.promptQueue = data.promptQueue;
    if (data.currentIndex !== undefined) STATE.currentIndex = data.currentIndex;
    if (data.downloadFolder !== undefined) STATE.downloadFolder = data.downloadFolder;
    if (data.isPaused !== undefined) STATE.isPaused = data.isPaused;
    if (data.isRunning !== undefined) STATE.isRunning = data.isRunning;

    // If the process was active and not paused, attempt auto-resume on startup
    if (STATE.isRunning && !STATE.isPaused && STATE.promptQueue.length > 0 && STATE.currentIndex < STATE.promptQueue.length) {
      findChatGptTab().then(tabId => {
        STATE.chatGptTabId = tabId;
        processNextPrompt();
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
      isRunning: STATE.isRunning
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
      REMOVE_PROMPT: () => handleRemovePrompt(message.index)
    };

    const handler = handlers[message.type];
    if (handler) {
      handler();
      const exclusions = ["GET_STATUS", "SCRAPE_CHAT", "DOWNLOAD_SCRAPED"];
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

  saveState();

  findChatGptTab().then(tabId => {
    STATE.chatGptTabId = tabId;
    processNextPrompt();
  }).catch(error => {
    broadcastProgress({
      status: "error",
      message: "Please open chatgpt.com in a tab first: " + error.message
    });
    STATE.isRunning = false;
    saveState();
  });
}

function handlePauseGeneration() {
  STATE.isPaused = true;
  saveState();
  broadcastProgress({ status: "paused", currentIndex: STATE.currentIndex });
}

function handleResumeGeneration() {
  STATE.isPaused = false;
  saveState();
  broadcastProgress({ status: "resumed", currentIndex: STATE.currentIndex });
  processNextPrompt();
}

function handleCancelGeneration() {
  STATE.isRunning = false;
  STATE.isPaused = false;
  STATE.currentIndex = 0;
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
    totalPrompts: STATE.promptQueue.length
  });
}


async function findChatGptTab() {
  const tabs = await chrome.tabs.query({ url: "*://chatgpt.com/*" });

  if (tabs.length === 0) {
    throw new Error("No ChatGPT tab found");
  }

  return tabs[0].id;
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


async function processNextPrompt() {
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

    const result = await sendPromptToContentScript(currentPrompt);

    if (result.success && result.dataUrl) {
      await downloadGeneratedImage(result.dataUrl, STATE.currentIndex, currentPrompt);

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
        message: `Prompt ${promptNumber}: ${result.error || "No image generated"}`
      });
    }

    STATE.currentIndex++;
    await saveState();
    await delay(DELAYS.BETWEEN_PROMPTS);
    processNextPrompt();

  } catch (error) {
    broadcastProgress({
      status: "error",
      currentIndex: STATE.currentIndex,
      message: `Error on prompt ${promptNumber}: ${error.message}`
    });

    STATE.currentIndex++;
    await saveState();
    await delay(DELAYS.BETWEEN_PROMPTS);
    processNextPrompt();
  }
}

function sendPromptToContentScript(promptText) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      STATE.chatGptTabId,
      { type: "PROCESS_PROMPT", promptText: promptText },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || { success: false, error: "No response from content script" });
      }
    );
  });
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

  const items = message.items;
  const folder = message.downloadFolder || "generated-images";
  const tabId = await findChatGptTab();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const promptNumber = i + 1;
    const totalPrompts = items.length;

    broadcastProgress({
      status: "processing",
      currentIndex: i,
      totalPrompts: totalPrompts,
      currentPrompt: item.promptText,
      message: `Downloading scraped image ${promptNumber} of ${totalPrompts}`
    });

    try {
      let dataUrl;
      if (item.imageUrl.startsWith("data:") || item.imageUrl.startsWith("http:") || item.imageUrl.startsWith("https:")) {
        dataUrl = item.imageUrl;
      } else {
        dataUrl = await fetchScrapedDataUrl(tabId, item.imageUrl);
      }
      await downloadGeneratedImage(dataUrl, i, item.promptText, folder);

      broadcastProgress({
        status: "downloaded",
        currentIndex: i,
        totalPrompts: totalPrompts,
        message: `Downloaded scraped image ${promptNumber} of ${totalPrompts}`
      });
    } catch (error) {
      broadcastProgress({
        status: "error",
        currentIndex: i,
        message: `Failed to download image ${promptNumber}: ${error.message}`
      });
    }

    await delay(1000);
  }

  broadcastProgress({
    status: "completed",
    message: "Finished downloading all scraped images",
    totalProcessed: items.length
  });
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
  }
}
