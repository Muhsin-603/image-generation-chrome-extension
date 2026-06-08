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
  IMAGE_GENERATION: 90000, // reduced from 180s to 90s to avoid long fallback waits
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

function isMessageStreaming(messageElement) {
  if (!messageElement) return false;
  
  // Check common streaming classes/selectors on ChatGPT
  return messageElement.classList.contains("result-streaming") ||
         messageElement.querySelector(".result-streaming") ||
         messageElement.querySelector('[class*="result-streaming"]') ||
         messageElement.querySelector('.cursor') ||
         messageElement.querySelector('[class*="cursor"]') ||
         messageElement.querySelector('.typing-indicator') ||
         messageElement.querySelector('[class*="typing"]');
}

function isMarkdownRenderedImage(img) {
  if (!img) return false;
  
  const src = img.src || img.getAttribute("src") || "";
  const alt = img.getAttribute("alt") || "";
  const className = img.className || "";

  // Require a src, but alt text is helpful and no longer mandatory
  if (!src) return false;

  // Exclude avatars, UI icons, formulas, and emojis
  const excludeKeywords = ["avatar", "profile", "icon", "logo", "emoji", "favicon", "math", "katex", "formula"];
  const matchesExclude = excludeKeywords.some(keyword => {
    return src.toLowerCase().includes(keyword) || 
           (alt && alt.toLowerCase().includes(keyword)) || 
           className.toLowerCase().includes(keyword);
  });

  if (matchesExclude) return false;

  // Verify it is inside the assistant message content (markdown/prose) or an assistant message container
  const isInsideContent = img.closest(".markdown") || 
                          img.closest(".prose") || 
                          img.closest('[class*="markdown"]') || 
                          img.closest('[class*="prose"]') ||
                          img.closest('[data-message-author-role="assistant"]') ||
                          img.closest('article');
  
  if (!isInsideContent) return false;

  // Heuristics: accept if src looks like a generated image, or the image element has reasonable dimensions
  const srcLower = src.toLowerCase();
  const likelyImagePattern = srcLower.startsWith("blob:") ||
                             srcLower.startsWith("data:") ||
                             srcLower.includes("oaiusercontent") ||
                             srcLower.includes("openai") ||
                             srcLower.includes("dall-e") ||
                             srcLower.endsWith(".png") ||
                             srcLower.endsWith(".jpg") ||
                             srcLower.endsWith(".jpeg") ||
                             srcLower.endsWith(".webp");

  if (likelyImagePattern) return true;

  try {
    if (img.naturalWidth && img.naturalHeight && (img.naturalWidth >= 48 || img.naturalHeight >= 48)) {
      return true;
    }
  } catch (e) {
    // ignore
  }

  return false;
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
  
  // Clear existing content
  inputElement.innerHTML = "";
  
  // Create paragraph container inside contenteditable
  const p = document.createElement("p");
  p.textContent = promptText;
  inputElement.appendChild(p);
  
  // Position the text insertion selection at the end
  try {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(p);
    range.collapse(false); // collapse to end
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (err) {
    console.warn("Failed to set selection range:", err);
  }

  // Dispatch events to trigger editor framework updates
  const inputEvent = new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: promptText
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
    let observer;
    let fallbackInterval;

    const cleanup = () => {
      if (observer) observer.disconnect();
      clearTimeout(timeoutId);
      if (fallbackInterval) clearInterval(fallbackInterval);
    };

    const checkNodeForImage = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;

      // Check images inside node
      const imgs = node.querySelectorAll("img");
      for (const img of imgs) {
        if (isMarkdownRenderedImage(img)) return img;
      }

      // Check links that look like images
      const links = node.querySelectorAll("a[href]");
      for (const link of links) {
        const href = link.href || link.getAttribute("href") || "";
        const hrefLower = href.toLowerCase();
        const matchesPattern = href.startsWith("blob:") ||
                               href.startsWith("data:") ||
                               hrefLower.includes("oaiusercontent") ||
                               hrefLower.includes("openai") ||
                               hrefLower.includes("dall-e") ||
                               hrefLower.includes(".png") ||
                               hrefLower.includes(".jpg") ||
                               hrefLower.includes(".jpeg") ||
                               hrefLower.includes(".webp");
        if (matchesPattern) return link;
      }

      return null;
    };

    const checkForTextRefusal = () => {
      const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      if (assistantMessages.length > messageCountBeforeSend) {
        const latestMessage = assistantMessages[assistantMessages.length - 1];
        if (!isMessageStreaming(latestMessage) && !findStopButton()) {
          const found = checkNodeForImage(latestMessage);
          if (!found) {
            return (latestMessage.textContent || "").trim();
          }
        }
      }
      return null;
    };

    // Quick initial check: maybe the image is already present in a newly appended assistant message
    try {
      const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      if (assistantMessages.length > messageCountBeforeSend) {
        const latestMessage = assistantMessages[assistantMessages.length - 1];
        const found = checkNodeForImage(latestMessage);
        if (found) {
          resolve(found);
          return;
        }
      } else if (assistantMessages.length > 0) {
        // Some flows update the last message in-place; check it too
        const latestMessage = assistantMessages[assistantMessages.length - 1];
        const found = checkNodeForImage(latestMessage);
        if (found) {
          resolve(found);
          return;
        }
      }

      const refusalText = checkForTextRefusal();
      if (refusalText) {
        reject(new Error(`Text response received: "${refusalText.substring(0, 150)}..."`));
        return;
      }
    } catch (e) {
      // ignore and continue to observer
    }

    // Observe the chat container for new assistant messages / images / attribute changes
    observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === 'childList') {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const el = /** @type {Element} */ (node);
            // If an assistant message node was added, check it
            if (el.matches && el.matches(SELECTORS.ASSISTANT_MESSAGE)) {
              const found = checkNodeForImage(el);
              if (found) {
                cleanup();
                resolve(found);
                return;
              }
            }
            // Otherwise check the subtree for images/links
            const foundSub = checkNodeForImage(el);
            if (foundSub) {
              cleanup();
              resolve(foundSub);
              return;
            }
          }
        } else if (mut.type === 'attributes') {
          const target = mut.target;
          const container = target.closest ? target.closest(SELECTORS.ASSISTANT_MESSAGE) : null;
          const toCheck = container || target;
          const foundAttr = checkNodeForImage(toCheck);
          if (foundAttr) {
            cleanup();
            resolve(foundAttr);
            return;
          }
        }
      }

      // Check for text refusal on mutations
      const refusalText = checkForTextRefusal();
      if (refusalText) {
        cleanup();
        reject(new Error(`Text response received: "${refusalText.substring(0, 150)}..."`));
      }
    });

    observer.observe(chatContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });

    // Fallback periodic check (in case observer misses something)
    fallbackInterval = setInterval(() => {
      const assistantMessagesNow = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      if (assistantMessagesNow.length > messageCountBeforeSend) {
        const latestMessage = assistantMessagesNow[assistantMessagesNow.length - 1];
        const found = checkNodeForImage(latestMessage);
        if (found) {
          cleanup();
          resolve(found);
          return;
        }
      } else if (assistantMessagesNow.length > 0) {
        const latestMessage = assistantMessagesNow[assistantMessagesNow.length - 1];
        const found = checkNodeForImage(latestMessage);
        if (found) {
          cleanup();
          resolve(found);
          return;
        }
      }

      const refusalText = checkForTextRefusal();
      if (refusalText) {
        cleanup();
        reject(new Error(`Text response received: "${refusalText.substring(0, 150)}..."`));
      }
    }, TIMEOUTS.ELEMENT_POLL_INTERVAL);

    // Global timeout
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Image generation timed out after " + (TIMEOUTS.IMAGE_GENERATION / 1000) + " seconds"));
    }, TIMEOUTS.IMAGE_GENERATION);
  });
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
  
  // Try selectors for download buttons or links
  const selectors = [
    'button[aria-label*="ownload" i]',
    'button[title*="ownload" i]',
    'a[aria-label*="ownload" i]',
    'a[title*="ownload" i]',
    'a[download]',
    'button[data-testid*="download" i]'
  ];

  for (const selector of selectors) {
    const btn = latestMessage.querySelector(selector);
    if (btn) return btn;
  }

  // Iterate over all buttons as fallback
  const allButtons = latestMessage.querySelectorAll("button");
  for (const button of allButtons) {
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    const title = (button.getAttribute("title") || "").toLowerCase();
    const text = (button.textContent || "").toLowerCase();
    if (label.includes("download") || title.includes("download") || text.includes("download")) {
      return button;
    }
  }

  // Iterate over all links as fallback
  const allLinks = latestMessage.querySelectorAll("a");
  for (const link of allLinks) {
    const label = (link.getAttribute("aria-label") || "").toLowerCase();
    const title = (link.getAttribute("title") || "").toLowerCase();
    const text = (link.textContent || "").toLowerCase();
    if (label.includes("download") || title.includes("download") || text.includes("download") || link.hasAttribute("download")) {
      return link;
    }
  }

  return null;
}


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function triggerModalDownload(imgElement) {
  if (!imgElement) return false;

  try {
    // 1. Click the image to open the modal
    imgElement.click();

    // 2. Wait for the modal/lightbox to appear in the DOM (prioritizing ARIA role="dialog")
    const modalSelector = '[role="dialog"], div[role="dialog"], div[class*="lightbox"], div[class*="modal"]';
    let modal = null;
    for (let i = 0; i < 30; i++) {
      modal = document.querySelector(modalSelector);
      if (modal) break;
      await delay(100);
    }

    if (!modal) {
      console.warn("Modal not found after click. Trying to click download button on the page directly.");
      const directBtn = findDownloadButtonForImage();
      if (directBtn) {
        directBtn.click();
        return true;
      }
      return false;
    }

    // Explicit delay (500ms) to allow React to mount the modal DOM and complete opacity/CSS transitions
    await delay(500);

    // 3. Find the download button inside the modal and click it
    let downloadBtn = modal.querySelector('button[aria-label*="ownload" i], a[aria-label*="ownload" i], button[title*="ownload" i]');
    if (!downloadBtn) {
      const buttons = modal.querySelectorAll("button, a");
      for (const btn of buttons) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        const text = (btn.textContent || "").toLowerCase();
        if (label.includes("download") || title.includes("download") || text.includes("download") || btn.hasAttribute("download")) {
          downloadBtn = btn;
          break;
        }
      }
    }

    if (downloadBtn) {
      downloadBtn.click();
      await delay(800); // Give it a moment to trigger the download
    } else {
      console.warn("Download button not found in modal.");
    }

    // 4. Find the close button inside the modal and click it
    let closeBtn = modal.querySelector('button[aria-label*="lose" i], button[title*="lose" i]');
    if (!closeBtn) {
      const buttons = modal.querySelectorAll("button");
      for (const btn of buttons) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        const text = (btn.textContent || "").toLowerCase();
        if (label.includes("close") || title.includes("close") || text.includes("close") || text.includes("cancel")) {
          closeBtn = btn;
          break;
        }
      }
    }

    if (closeBtn) {
      closeBtn.click();
    } else {
      // Press Escape key programmatically to close the dialog.
      // Set bubbles: true and composed: true so React delegators capture it at root.
      const escEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        keyCode: 27,
        code: "Escape",
        which: 27,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      
      const target = document.activeElement || modal || document;
      target.dispatchEvent(escEvent);
    }

    return true;
  } catch (err) {
    console.error("Error in triggerModalDownload:", err);
    return false;
  }
}

async function processPrompt(promptText) {
  dismissComparisonDialog();
  const messageCountBeforeSend = countAssistantMessages();

  typePromptText(promptText);
  await clickSendButtonWhenEnabled();

  const imgElement = await waitForImageGeneration(messageCountBeforeSend);
  
  let downloadTriggered = false;
  if (imgElement) {
    downloadTriggered = await triggerModalDownload(imgElement);
  }

  // Extract the image source for reporting/displaying in sidepanel
  const imageUrl = imgElement ? extractHighResImageUrl(imgElement) : null;

  return { imageUrl, downloadTriggered };
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
  if (isProcessing) {
    sendResponse({ success: false, error: "Content script is already processing a prompt" });
    return;
  }
  sendResponse({ success: true, status: "started" });

  isProcessing = true;
  processPrompt(message.promptText)
    .then(async (result) => {
      if (!isProcessing) return;

      const { imageUrl, downloadTriggered } = result;
      let dataUrl = imageUrl;

      // If download was not triggered natively, and the URL is a local blob, try to convert to data URL as fallback.
      if (!downloadTriggered && imageUrl && imageUrl.startsWith("blob:")) {
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
        dataUrl: dataUrl,
        imageUrl: imageUrl,
        downloadTriggered: downloadTriggered
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
        if (isMarkdownRenderedImage(img)) {
          const src = extractHighResImageUrl(img);
          if (src) {
            results.push({
              promptText: lastUserPrompt.trim(),
              imageUrl: src
            });
          }
        }
      });
    }
  });

  if (results.length === 0) {
    const allImages = document.querySelectorAll("img");
    allImages.forEach(img => {
      if (isMarkdownRenderedImage(img)) {
        const src = extractHighResImageUrl(img);
        if (src) {
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
