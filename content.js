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
  return document.querySelector(SELECTORS.SEND_BUTTON_FALLBACK);
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
  inputElement.textContent = "";

  const paragraph = document.createElement("p");
  paragraph.textContent = promptText;
  inputElement.appendChild(paragraph);

  inputElement.dispatchEvent(new Event("input", { bubbles: true }));
  inputElement.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickSendButton() {
  const sendButton = findSendButton();
  if (!sendButton) {
    throw new Error("Could not find ChatGPT send button");
  }

  sendButton.click();
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
      const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      if (assistantMessages.length <= messageCountBeforeSend) return false;

      const stopButton = document.querySelector('button[aria-label="Stop generating"]');
      const isStillGenerating = stopButton && stopButton.offsetParent !== null;

      return !isStillGenerating;
    };

    checkIntervalId = setInterval(() => {
      dismissComparisonDialog();

      if (!isResponseComplete()) return;

      const imageUrl = checkForNewImage();
      if (imageUrl) {
        cleanup();
        resolve(imageUrl);
        return;
      }

      const assistantMessages = document.querySelectorAll(SELECTORS.ASSISTANT_MESSAGE);
      if (assistantMessages.length > messageCountBeforeSend) {
        const latestMessage = assistantMessages[assistantMessages.length - 1];
        const messageText = latestMessage.textContent || "";

        if (messageText.length > 50 && !messageText.includes("generating")) {
          cleanup();

          const anyImage = latestMessage.querySelector("img");
          if (anyImage && anyImage.src) {
            resolve(anyImage.src);
          } else {
            reject(new Error("Response completed but no image was found. ChatGPT may have responded with text only."));
          }
        }
      }
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
  if (url.startsWith("data:")) return false;

  const imagePatterns = [
    "oaidalleapiprodscus",
    "dall-e",
    "openai",
    "blob:",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp"
  ];

  const excludePatterns = [
    "avatar",
    "icon",
    "logo",
    "favicon",
    "profile",
    "emoji",
    "thumb"
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
  await delay(TIMEOUTS.POST_SEND_DELAY);
  clickSendButton();

  const imageUrl = await waitForImageGeneration(messageCountBeforeSend);
  return imageUrl;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PROCESS_PROMPT") {
    handleProcessPrompt(message.promptText, sendResponse);
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

async function handleProcessPrompt(promptText, sendResponse) {
  try {
    isProcessing = true;
    const imageUrl = await processPrompt(promptText);
    const dataUrl = await fetchAsDataUrl(imageUrl);
    sendResponse({ success: true, dataUrl: dataUrl });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  } finally {
    isProcessing = false;
  }
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

  return results;
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
