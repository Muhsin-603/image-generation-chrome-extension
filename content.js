const SELECTORS = {
  PROMPT_INPUT: '[role="textbox"][contenteditable="true"]',
  SEND_BUTTON: 'button[data-testid="send-button"]',
  SEND_BUTTON_FALLBACK: 'button[aria-label="Send prompt"]',
  CHAT_CONTAINER: '[role="presentation"]',
  ASSISTANT_MESSAGE: '[data-message-author-role="assistant"]',
  GENERATED_IMAGE: 'img[alt]',
  COMPARISON_SKIP: 'button[data-testid="skip-button"]'
};

const TIMEOUTS = {
  IMAGE_GENERATION: 180000,
  ELEMENT_POLL_INTERVAL: 500,
  POST_SEND_DELAY: 2000,
  BETWEEN_PROMPTS_DELAY: 3000
};

let isProcessing = false;


function findPromptInput() {
  return document.querySelector(SELECTORS.PROMPT_INPUT);
}

function findSendButton() {
  const primaryButton = document.querySelector(SELECTORS.SEND_BUTTON);
  if (primaryButton) return primaryButton;
  const fallback = document.querySelector(SELECTORS.SEND_BUTTON_FALLBACK);
  if (fallback) return fallback;

  // Broader case-insensitive and structural fallbacks
  return document.querySelector('button[aria-label*="Send" i]') || 
         document.querySelector('button[data-testid*="send" i]') ||
         document.querySelector('form button[type="submit"]') ||
         document.querySelector('form button:last-of-type');
}

function findStopButton() {
  return document.querySelector('button[data-testid="stop-button"]') || 
         document.querySelector('button[data-testid*="stop" i]') || 
         document.querySelector('button[aria-label*="Stop" i]');
}

function findChatContainer() {
  const presentationContainer = document.querySelector(SELECTORS.CHAT_CONTAINER);
  if (presentationContainer) return presentationContainer;
  return document.querySelector("main");
}

function countAssistantMessages() {
  return document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE).length;
}


function typePromptText(promptText) {
  const inputElement = findPromptInput();
  if (!inputElement) {
    throw new Error("Could not find ChatGPT prompt input field");
  }

  inputElement.focus();
  
  // Clear existing text securely
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  
  // Use native execution command to insert the text, bypassing clipboard sandbox policies
  document.execCommand('insertText', false, promptText);
  
  // Dispatch input event to trigger React/Lexical listeners
  const inputEvent = new Event('input', {
    bubbles: true,
    cancelable: true
  });
  inputElement.dispatchEvent(inputEvent);
}

function clickSendButtonWhenEnabled() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const timeoutMs = 5000;

    function check() {
      const sendButton = findSendButton();
      if (sendButton && !sendButton.disabled && !sendButton.hasAttribute("disabled")) {
        sendButton.click();
        resolve();
        return;
      }

      if (Date.now() - startTime > timeoutMs) {
        if (sendButton) {
          sendButton.click();
          resolve();
        } else {
          reject(new Error("Send button did not become enabled in time"));
        }
        return;
      }

      requestAnimationFrame(check);
    }

    requestAnimationFrame(check);
  });
}


function waitForElement(selector, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const existingElement = document.querySelector(selector);
    if (existingElement) {
      resolve(existingElement);
      return;
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for element: ${selector}`));
    }, timeoutMs);
  });
}

function waitForImageGeneration(messageCountBeforeSend) {
  return new Promise((resolve, reject) => {
    const chatContainer = findChatContainer();
    if (!chatContainer) {
      reject(new Error("Could not find chat container"));
      return;
    }

    let timeoutId;
    let checkIntervalId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      clearInterval(checkIntervalId);
    };

    const checkForNewImage = () => {
      const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      if (assistantMessages.length <= messageCountBeforeSend) return null;

      const latestMessage = assistantMessages[assistantMessages.length - 1];
      const imageElements = latestMessage.querySelectorAll("img");

      for (const img of imageElements) {
        const imageSource = img.src || img.getAttribute("src");
        if (imageSource && isGeneratedImageUrl(imageSource)) {
          return imageSource;
        }
      }

      const downloadLinks = latestMessage.querySelectorAll('a[href]');
      for (const link of downloadLinks) {
        const href = link.href || link.getAttribute("href");
        if (href && isGeneratedImageUrl(href)) {
          return href;
        }
      }

      return null;
    };

    const isResponseComplete = () => {
      // Look for the Send button and the Stop button.
      const sendButton = findSendButton();
      const stopButton = findStopButton();

      // If a stop button exists, we are definitely still generating.
      if (stopButton) {
        return false;
      }

      // If the send button exists and is visible, then we are done generating.
      // Note: the send button is usually disabled when the prompt input field is empty,
      // so we do not require it to be enabled.
      if (sendButton && sendButton.offsetParent !== null) {
        return true;
      }

      return false; // Wait for state to settle
    };

    let generationStarted = false;
    let completionDetectedTime = null;

    checkIntervalId = setInterval(() => {
      dismissComparisonDialog();

      const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      const isComplete = isResponseComplete();

      // If the response completed before we detected the start (e.g. instant policy violation)
      if (assistantMessages.length > messageCountBeforeSend && isComplete) {
        generationStarted = true;
      }

      if (!generationStarted) {
        const sendButton = findSendButton();
        
        // Generation has started if the message count increased AND (send button is disabled, hidden, or absent)
        const isGenerating = !sendButton || sendButton.offsetParent === null || sendButton.disabled || sendButton.hasAttribute('disabled');

        if (assistantMessages.length > messageCountBeforeSend && isGenerating) {
          generationStarted = true;
        }
        return; // Wait for the next poll to check completion
      }

      if (!isComplete) return;

      // Start the grace period timer when isComplete first becomes true
      if (completionDetectedTime === null) {
        completionDetectedTime = Date.now();
      }

      const imageUrl = checkForNewImage();
      if (imageUrl) {
        cleanup();
        resolve(imageUrl);
        return;
      }

      // If we've waited less than the grace period (5 seconds), keep waiting for the image to be appended
      const gracePeriodMs = 5000;
      if (Date.now() - completionDetectedTime < gracePeriodMs) {
        return; // Wait for the next tick
      }

      // Response is complete, but no DALL-E image was generated.
      cleanup();
      
      let errorMsg = "Response completed but no image was found.";
      if (assistantMessages.length > messageCountBeforeSend) {
        const latestMessage = assistantMessages[assistantMessages.length - 1];
        const responseText = (latestMessage.textContent || "").trim();
        if (responseText) {
          errorMsg = `ChatGPT responded: "${responseText}"`;
        }
      }
      reject(new Error(errorMsg));
    }, TIMEOUTS.ELEMENT_POLL_INTERVAL);

    timeoutId = setTimeout(() => {
      cleanup();

      const imageUrl = checkForNewImage();
      if (imageUrl) {
        resolve(imageUrl);
        return;
      }

      reject(new Error("Image generation timed out after " + (TIMEOUTS.IMAGE_GENERATION / 1000) + " seconds"));
    }, TIMEOUTS.IMAGE_GENERATION);
  });
}

function isGeneratedImageUrl(url) {
  if (!url) return false;
  if (url.startsWith("data:image/")) return true;
  if (url.startsWith("blob:")) return true;

  const imagePatterns = [
    "oaidalleapiprodscus",
    "dall-e",
    "openai",
    "oaiusercontent",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    "format="
  ];

  const excludePatterns = [
    "avatar",
    "icon",
    "logo",
    "favicon",
    "profile",
    "emoji"
  ];

  const urlLower = url.toLowerCase();
  const matchesImagePattern = imagePatterns.some(pattern => urlLower.includes(pattern));
  const matchesExcludePattern = excludePatterns.some(pattern => urlLower.includes(pattern));

  return matchesImagePattern && !matchesExcludePattern;
}

function dismissComparisonDialog() {
  const skipButton = document.querySelector(SELECTORS.COMPARISON_SKIP);
  if (skipButton) {
    skipButton.click();
    return;
  }

  const allButtons = document.querySelectorAll("button");
  for (const button of allButtons) {
    const buttonText = (button.textContent || "").toLowerCase().trim();
    if (buttonText === "skip" || buttonText === "no thanks" || buttonText === "cancel") {
      button.click();
      return;
    }
  }
}


function extractHighResImageUrl(imageElement) {
  const srcset = imageElement.getAttribute("srcset");
  if (srcset) {
    const sources = srcset.split(",").map(s => s.trim());
    const lastSource = sources[sources.length - 1];
    const highResUrl = lastSource.split(" ")[0];
    if (highResUrl) return highResUrl;
  }

  return imageElement.src || imageElement.getAttribute("src");
}

function findDownloadButtonForImage() {
  const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
  if (assistantMessages.length === 0) return null;

  const latestMessage = assistantMessages[assistantMessages.length - 1];
  const downloadButton = latestMessage.querySelector('button[aria-label*="ownload"]');
  if (downloadButton) return downloadButton;

  const allButtons = latestMessage.querySelectorAll("button");
  for (const button of allButtons) {
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    const text = (button.textContent || "").toLowerCase();
    if (label.includes("download") || text.includes("download")) {
      return button;
    }
  }

  return null;
}


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processPrompt(promptText) {
  const messageCountBeforeSend = countAssistantMessages();

  typePromptText(promptText);
  await clickSendButtonWhenEnabled();

  const imageUrl = await waitForImageGeneration(messageCountBeforeSend);
  return imageUrl;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_PROMPT") {
    handleStartPrompt(message, sendResponse);
    return true;
  }

  if (message.type === "CHECK_READY") {
    const inputField = findPromptInput();
    sendResponse({ ready: !!inputField });
    return true;
  }

  if (message.type === "CANCEL") {
    isProcessing = false;
    sendResponse({ cancelled: true });
    return true;
  }

  if (message.type === "SCRAPE_CHAT") {
    handleScrapeChat(sendResponse);
    return true;
  }

  if (message.type === "FETCH_DATA_URL") {
    handleFetchDataUrl(message.url, sendResponse);
    return true;
  }

  if (message.type === "DOWNLOAD_SCRAPED_IMAGES") {
    handleDownloadScrapedImages(message.items, message.downloadFolder, sendResponse);
    return true;
  }
});

async function fetchAsDataUrl(url) {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to convert image to data URL"));
    reader.readAsDataURL(blob);
  });
}

function handleStartPrompt(message, sendResponse) {
  sendResponse({ success: true, status: "started" });

  isProcessing = true;
  processPrompt(message.promptText)
    .then(async (imageUrl) => {
      if (!isProcessing) return;

      let dataUrl = imageUrl;
      if (imageUrl && imageUrl.startsWith("blob:")) {
        try {
          dataUrl = await fetchAsDataUrl(imageUrl);
        } catch (err) {
          console.error("Failed to resolve blob URL in content script:", err);
        }
      }

      chrome.runtime.sendMessage({
        type: "PROMPT_COMPLETED",
        runId: message.runId,
        index: message.index,
        success: true,
        dataUrl: dataUrl
      });
    })
    .catch((error) => {
      if (!isProcessing) return;
      chrome.runtime.sendMessage({
        type: "PROMPT_COMPLETED",
        runId: message.runId,
        index: message.index,
        success: false,
        error: error.message
      });
    })
    .finally(() => {
      isProcessing = false;
    });
}

function scrapeChatImages() {
  const messages = document.querySelectorAll("[data-message-author-role]");
  const results = [];
  let lastUserPrompt = "image";

  messages.forEach(message => {
    const role = message.getAttribute("data-message-author-role");
    if (role === "user") {
      lastUserPrompt = message.textContent || "image";
    } else if (role === "assistant") {
      const images = message.querySelectorAll("img");
      images.forEach(img => {
        const src = img.src || img.getAttribute("src");
        if (src && isGeneratedImageUrl(src)) {
          results.push({
            promptText: lastUserPrompt.trim(),
            imageUrl: src
          });
        }
      });
    }
  });

  if (results.length === 0) {
    const allImages = document.querySelectorAll("img");
    allImages.forEach(img => {
      const src = img.src || img.getAttribute("src");
      if (src && isGeneratedImageUrl(src)) {
        let promptText = "scraped-image";
        const parentMessage = img.closest("[data-message-author-role='assistant']") || img.closest("article");

        if (parentMessage) {
          let prev = parentMessage.previousElementSibling;
          while (prev) {
            const hasUserRole = prev.getAttribute && (prev.getAttribute("data-message-author-role") === "user" || prev.querySelector("[data-message-author-role='user']"));
            if (hasUserRole) {
              promptText = prev.textContent || promptText;
              break;
            }
            prev = prev.previousElementSibling;
          }
        }

        results.push({
          promptText: promptText.trim(),
          imageUrl: src
        });
      }
    });
  }

  const uniqueResults = [];
  const seenUrls = new Set();

  results.forEach(item => {
    if (!seenUrls.has(item.imageUrl)) {
      seenUrls.add(item.imageUrl);
      uniqueResults.push(item);
    }
  });

  return uniqueResults;
}

function handleScrapeChat(sendResponse) {
  try {
    const items = scrapeChatImages();
    sendResponse({ success: true, items: items });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleFetchDataUrl(url, sendResponse) {
  try {
    const dataUrl = await fetchAsDataUrl(url);
    sendResponse({ success: true, dataUrl: dataUrl });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleDownloadScrapedImages(items, downloadFolder, sendResponse) {
  sendResponse({ success: true, message: "Started downloading on page" });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const promptNumber = i + 1;
    const totalPrompts = items.length;

    chrome.runtime.sendMessage({
      status: "processing",
      currentIndex: i,
      totalPrompts: totalPrompts,
      currentPrompt: item.promptText,
      message: `Downloading scraped image ${promptNumber} of ${totalPrompts}`
    });

    try {
      const sanitizedName = sanitizeFileName(item.promptText);
      const paddedIndex = String(i + 1).padStart(3, "0");
      const fileName = `${downloadFolder}/${paddedIndex}_${sanitizedName}.png`;

      let finalUrl = item.imageUrl;
      let createdBlobUrl = null;

      // If it is a cross-origin HTTPS URL, try to fetch it first to convert it to a local blob URL
      // so that the download attribute on the <a> tag is respected!
      if (finalUrl.startsWith("http") && !finalUrl.includes(window.location.host)) {
        try {
          const res = await fetch(finalUrl);
          const blob = await res.blob();
          finalUrl = URL.createObjectURL(blob);
          createdBlobUrl = finalUrl;
        } catch (fetchErr) {
          console.warn("Failed to fetch cross-origin image in page context, falling back:", fetchErr);
        }
      }

      let downloadedSuccessfully = false;

      // If we got a blob (either local or resolved), trigger download programmatically
      if (finalUrl.startsWith("blob:") || finalUrl.startsWith("data:")) {
        try {
          const a = document.createElement("a");
          a.href = finalUrl;
          a.download = fileName;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          downloadedSuccessfully = true;
        } catch (downloadErr) {
          console.warn("Programmatic download failed:", downloadErr);
        }
      }

      // If not downloaded successfully (e.g. cross-origin fetch failed or failed download), delegate to background
      if (!downloadedSuccessfully) {
        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_VIA_BACKGROUND",
            imageUrl: item.imageUrl,
            index: i,
            promptText: item.promptText,
            downloadFolder: downloadFolder
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.success) {
              resolve();
            } else {
              reject(new Error(response ? response.error : "Unknown background download error"));
            }
          });
        });
      }

      // Clean up object URL if created
      if (createdBlobUrl) {
        URL.revokeObjectURL(createdBlobUrl);
      }

      chrome.runtime.sendMessage({
        status: "downloaded",
        currentIndex: i,
        totalPrompts: totalPrompts,
        message: `Downloaded scraped image ${promptNumber} of ${totalPrompts}`
      });

    } catch (error) {
      chrome.runtime.sendMessage({
        status: "error",
        currentIndex: i,
        message: `Failed to download image ${promptNumber}: ${error.message}`
      });
    }

    await new Promise(resolve => setTimeout(resolve, 1000)); // Delay between downloads to prevent flooding the browser
  }

  chrome.runtime.sendMessage({
    status: "completed",
    message: "Finished downloading all scraped images",
    totalProcessed: items.length
  });
}

function sanitizeFileName(text) {
  return text.substring(0, 50).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}
