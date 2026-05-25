import { extractPromptsFromPdf } from "./parsers/pdf-parser.js";
import { extractPromptsFromDocx } from "./parsers/docx-parser.js";
import { extractPromptsFromMarkdown } from "./parsers/markdown-parser.js";


const elements = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  fileInfo: document.getElementById("fileInfo"),
  fileName: document.getElementById("fileName"),
  clearFileButton: document.getElementById("clearFileButton"),
  promptsPreview: document.getElementById("promptsPreview"),
  promptCount: document.getElementById("promptCount"),
  promptList: document.getElementById("promptList"),
  downloadFolder: document.getElementById("downloadFolder"),
  startButton: document.getElementById("startButton"),
  secondaryControls: document.getElementById("secondaryControls"),
  pauseButton: document.getElementById("pauseButton"),
  cancelButton: document.getElementById("cancelButton"),
  progressSection: document.getElementById("progressSection"),
  progressLabel: document.getElementById("progressLabel"),
  progressValue: document.getElementById("progressValue"),
  progressBarFill: document.getElementById("progressBarFill"),
  currentPromptText: document.getElementById("currentPromptText"),
  logSection: document.getElementById("logSection"),
  logEntries: document.getElementById("logEntries"),
  clearLogButton: document.getElementById("clearLogButton"),
  scrapeButton: document.getElementById("scrapeButton"),
  scrapedPreview: document.getElementById("scrapedPreview"),
  scrapedCount: document.getElementById("scrapedCount"),
  scrapedList: document.getElementById("scrapedList"),
  downloadScrapedButton: document.getElementById("downloadScrapedButton"),
  manualPromptInput: document.getElementById("manualPromptInput"),
  addPromptButton: document.getElementById("addPromptButton")
};

let parsedPrompts = [];
let scrapedImages = [];
let currentActiveIndex = 0;
let isPaused = false;


function initializeEventListeners() {
  elements.dropZone.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", handleFileSelection);
  elements.clearFileButton.addEventListener("click", clearSelectedFile);
  elements.startButton.addEventListener("click", startGeneration);
  elements.pauseButton.addEventListener("click", togglePause);
  elements.cancelButton.addEventListener("click", cancelGeneration);
  elements.clearLogButton.addEventListener("click", clearLog);
  elements.scrapeButton.addEventListener("click", startScraping);
  elements.downloadScrapedButton.addEventListener("click", downloadScrapedImages);
  elements.addPromptButton.addEventListener("click", addManualPrompt);
  elements.manualPromptInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      addManualPrompt();
    }
  });

  elements.dropZone.addEventListener("dragover", handleDragOver);
  elements.dropZone.addEventListener("dragleave", handleDragLeave);
  elements.dropZone.addEventListener("drop", handleDrop);

  chrome.runtime.onMessage.addListener(handleProgressUpdate);
}


function handleDragOver(event) {
  event.preventDefault();
  elements.dropZone.classList.add("drag-over");
}

function handleDragLeave(event) {
  event.preventDefault();
  elements.dropZone.classList.remove("drag-over");
}

function handleDrop(event) {
  event.preventDefault();
  elements.dropZone.classList.remove("drag-over");

  const droppedFile = event.dataTransfer.files[0];
  if (droppedFile && isValidFileType(droppedFile.name)) {
    processUploadedFile(droppedFile);
  }
}

function handleFileSelection(event) {
  const selectedFile = event.target.files[0];
  if (selectedFile) {
    processUploadedFile(selectedFile);
  }
}

function isValidFileType(fileName) {
  const validExtensions = [".pdf", ".docx", ".md"];
  const extension = fileName.substring(fileName.lastIndexOf(".")).toLowerCase();
  return validExtensions.includes(extension);
}


async function processUploadedFile(file) {
  const fileExtension = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();

  showFileInfo(file.name);

  try {
    const fileArrayBuffer = await readFileAsArrayBuffer(file);
    const fileText = await readFileAsText(file);

    const extractors = {
      ".pdf": () => extractPromptsFromPdf(fileArrayBuffer),
      ".docx": () => extractPromptsFromDocx(fileArrayBuffer),
      ".md": () => extractPromptsFromMarkdown(fileText)
    };

    const extractor = extractors[fileExtension];
    if (!extractor) {
      addLogEntry("Unsupported file type: " + fileExtension, "error");
      return;
    }

    parsedPrompts = await extractor();
    renderPromptsList(parsedPrompts);
    elements.startButton.disabled = parsedPrompts.length === 0;

  } catch (error) {
    addLogEntry("Failed to parse file: " + error.message, "error");
    parsedPrompts = [];
    elements.startButton.disabled = true;
  }
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}


function showFileInfo(name) {
  elements.dropZone.hidden = true;
  elements.fileInfo.hidden = false;
  elements.fileName.textContent = name;
}

function clearSelectedFile() {
  elements.dropZone.hidden = false;
  elements.fileInfo.hidden = true;
  elements.fileInput.value = "";
  parsedPrompts = [];
  hidePromptsPreview();
  elements.startButton.disabled = true;
}

function renderPromptsList(prompts) {
  elements.promptsPreview.hidden = false;
  elements.promptCount.textContent = prompts.length;
  elements.promptList.innerHTML = "";

  prompts.forEach((promptText, index) => {
    const listItem = document.createElement("li");
    listItem.className = "prompt-item";
    listItem.id = `prompt-item-${index}`;

    const indexSpan = document.createElement("span");
    indexSpan.className = "prompt-index";
    indexSpan.textContent = String(index + 1).padStart(2, "0");

    const textSpan = document.createElement("span");
    textSpan.className = "prompt-text";
    textSpan.textContent = promptText;
    textSpan.title = promptText;

    const removeButton = document.createElement("button");
    removeButton.className = "btn-remove-prompt";
    removeButton.title = "Remove prompt";
    removeButton.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    const isGenerationActive = elements.startButton.hidden;
    if (isGenerationActive && index <= currentActiveIndex) {
      removeButton.disabled = true;
      removeButton.style.opacity = "0.2";
      removeButton.style.cursor = "not-allowed";
    }

    removeButton.addEventListener("click", () => {
      if (!removeButton.disabled) {
        removePromptAt(index);
      }
    });

    listItem.appendChild(indexSpan);
    listItem.appendChild(textSpan);
    listItem.appendChild(removeButton);
    elements.promptList.appendChild(listItem);
  });
}

function removePromptAt(index) {
  parsedPrompts.splice(index, 1);
  renderPromptsList(parsedPrompts);

  if (!elements.startButton.hidden) {
    elements.startButton.disabled = parsedPrompts.length === 0;
  } else {
    highlightActivePrompt(currentActiveIndex);
    chrome.runtime.sendMessage({ type: "REMOVE_PROMPT", index: index });
    updateProgress(currentActiveIndex, parsedPrompts.length, elements.progressLabel.textContent);
  }
}

function hidePromptsPreview() {
  elements.promptsPreview.hidden = true;
  elements.promptList.innerHTML = "";
}


function startGeneration() {
  if (parsedPrompts.length === 0) return;

  const downloadFolder = elements.downloadFolder.value.trim() || "generated-images";

  chrome.runtime.sendMessage({
    type: "START_GENERATION",
    prompts: parsedPrompts,
    downloadFolder: downloadFolder
  });

  switchToRunningState();
  showProgressSection();
  showLogSection();
  addLogEntry("Generation started with " + parsedPrompts.length + " prompts", "success");
}

function togglePause() {
  isPaused = !isPaused;

  if (isPaused) {
    chrome.runtime.sendMessage({ type: "PAUSE_GENERATION" });
    elements.pauseButton.innerHTML = createResumeIcon() + " Resume";
    addLogEntry("Generation paused", "warning");
  } else {
    chrome.runtime.sendMessage({ type: "RESUME_GENERATION" });
    elements.pauseButton.innerHTML = createPauseIcon() + " Pause";
    addLogEntry("Generation resumed", "success");
  }
}

function cancelGeneration() {
  chrome.runtime.sendMessage({ type: "CANCEL_GENERATION" });
  switchToIdleState();
  addLogEntry("Generation cancelled", "error");
}

function createPauseIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
}

function createResumeIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
}


function switchToRunningState() {
  elements.startButton.hidden = true;
  elements.secondaryControls.hidden = false;
  isPaused = false;
}

function switchToIdleState() {
  elements.startButton.hidden = false;
  elements.startButton.disabled = parsedPrompts.length === 0;
  elements.secondaryControls.hidden = true;
  isPaused = false;
  elements.pauseButton.innerHTML = createPauseIcon() + " Pause";
}


function showProgressSection() {
  elements.progressSection.hidden = false;
  updateProgress(0, parsedPrompts.length, "Starting...");
}

function showLogSection() {
  elements.logSection.hidden = false;
}

function updateProgress(currentIndex, totalPrompts, message) {
  const percentage = totalPrompts > 0 ? Math.round((currentIndex / totalPrompts) * 100) : 0;

  elements.progressValue.textContent = percentage + "%";
  elements.progressBarFill.style.width = percentage + "%";
  elements.progressLabel.textContent = message || "Processing...";
}

function highlightActivePrompt(activeIndex) {
  const activeList = !elements.scrapedPreview.hidden ? elements.scrapedList : elements.promptList;
  const allPromptItems = activeList.querySelectorAll(".prompt-item");

  allPromptItems.forEach((item, index) => {
    item.classList.remove("active");

    if (index < activeIndex) {
      item.classList.add("completed");
    }

    if (index === activeIndex) {
      item.classList.add("active");
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

function markPromptAsError(index) {
  const prefix = !elements.scrapedPreview.hidden ? "scraped" : "prompt";
  const promptItem = document.getElementById(`${prefix}-item-${index}`);
  if (promptItem) {
    promptItem.classList.add("error");
  }
}


function addLogEntry(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;

  const timeSpan = document.createElement("span");
  timeSpan.className = "log-entry-time";
  timeSpan.textContent = formatCurrentTime();

  const messageSpan = document.createElement("span");
  messageSpan.className = "log-entry-message";
  messageSpan.textContent = message;
  messageSpan.title = message;

  entry.appendChild(timeSpan);
  entry.appendChild(messageSpan);

  elements.logEntries.insertBefore(entry, elements.logEntries.firstChild);
}

function clearLog() {
  elements.logEntries.innerHTML = "";
}

function formatCurrentTime() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}


function handleProgressUpdate(message) {
  const statusHandlers = {
    processing: () => {
      currentActiveIndex = message.currentIndex;
      updateProgress(message.currentIndex, message.totalPrompts, message.message);
      highlightActivePrompt(message.currentIndex);
      elements.currentPromptText.textContent = message.currentPrompt || "";
      addLogEntry(message.message);
    },

    downloaded: () => {
      updateProgress(message.currentIndex + 1, message.totalPrompts, message.message);
      addLogEntry(message.message, "success");
    },

    completed: () => {
      currentActiveIndex = 0;
      updateProgress(message.totalProcessed, message.totalProcessed, "All done!");
      switchToIdleState();
      addLogEntry(message.message, "success");
    },

    paused: () => {
      elements.progressLabel.textContent = "Paused";
      elements.progressLabel.classList.add("status-pulse");
    },

    resumed: () => {
      elements.progressLabel.classList.remove("status-pulse");
    },

    cancelled: () => {
      currentActiveIndex = 0;
      switchToIdleState();
    },

    warning: () => {
      markPromptAsError(message.currentIndex);
      addLogEntry(message.message, "warning");
    },

    error: () => {
      if (message.currentIndex !== undefined) {
        markPromptAsError(message.currentIndex);
      }
      addLogEntry(message.message, "error");
    }
  };

  const handler = statusHandlers[message.status];
  if (handler) handler();
}


function startScraping() {
  showLogSection();
  addLogEntry("Scraping chat images...");
  elements.scrapeButton.disabled = true;
  elements.scrapeButton.innerHTML = `<span class="spinner"></span>Scraping...`;

  const startTime = Date.now();

  chrome.runtime.sendMessage({ type: "SCRAPE_CHAT" }, response => {
    const elapsed = Date.now() - startTime;
    const remainingDelay = Math.max(0, 800 - elapsed);

    setTimeout(() => {
      elements.scrapeButton.disabled = false;
      elements.scrapeButton.innerHTML = "Scrape Chat Images";

      if (chrome.runtime.lastError) {
        addLogEntry("Scrape failed: " + chrome.runtime.lastError.message, "error");
        return;
      }
      if (response && response.success) {
        scrapedImages = response.items;
        if (scrapedImages.length === 0) {
          addLogEntry("No generated images found in the chat.", "warning");
          elements.scrapedPreview.hidden = true;
        } else {
          renderScrapedList(scrapedImages);
          addLogEntry(`Found ${scrapedImages.length} images in the chat.`, "success");
        }
      } else {
        addLogEntry("Scrape failed: " + (response ? response.error : "Unknown error"), "error");
      }
    }, remainingDelay);
  });
}

function renderScrapedList(items) {
  elements.scrapedPreview.hidden = false;
  elements.scrapedCount.textContent = items.length;
  elements.scrapedList.innerHTML = "";
  elements.downloadScrapedButton.disabled = items.length === 0;

  items.forEach((item, index) => {
    const listItem = document.createElement("li");
    listItem.className = "prompt-item";
    listItem.id = `scraped-item-${index}`;

    const indexSpan = document.createElement("span");
    indexSpan.className = "prompt-index";
    indexSpan.textContent = String(index + 1).padStart(2, "0");

    const thumbnail = document.createElement("img");
    thumbnail.src = item.imageUrl;
    thumbnail.alt = "Thumbnail";

    const textSpan = document.createElement("span");
    textSpan.className = "prompt-text";
    textSpan.textContent = item.promptText;
    textSpan.title = item.promptText;

    const removeButton = document.createElement("button");
    removeButton.className = "btn-remove-prompt";
    removeButton.title = "Remove image";
    removeButton.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    removeButton.addEventListener("click", () => {
      removeScrapedImageAt(index);
    });

    listItem.appendChild(indexSpan);
    listItem.appendChild(thumbnail);
    listItem.appendChild(textSpan);
    listItem.appendChild(removeButton);
    elements.scrapedList.appendChild(listItem);
  });
}

function removeScrapedImageAt(index) {
  scrapedImages.splice(index, 1);
  renderScrapedList(scrapedImages);
}

function downloadScrapedImages() {
  if (scrapedImages.length === 0) return;

  const downloadFolder = elements.downloadFolder.value.trim() || "generated-images";
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_SCRAPED",
    items: scrapedImages,
    downloadFolder: downloadFolder
  });

  switchToRunningState();
  elements.progressSection.hidden = false;
  updateProgress(0, scrapedImages.length, "Starting download...");
  elements.logSection.hidden = false;
  addLogEntry("Starting bulk download of " + scrapedImages.length + " scraped images...", "success");
}


function addManualPrompt() {
  const text = elements.manualPromptInput.value.trim();
  if (text) {
    parsedPrompts.push(text);
    renderPromptsList(parsedPrompts);

    if (!elements.startButton.hidden) {
      elements.startButton.disabled = false;
    } else {
      highlightActivePrompt(currentActiveIndex);
      chrome.runtime.sendMessage({ type: "ADD_PROMPT", prompt: text });
      updateProgress(currentActiveIndex, parsedPrompts.length, elements.progressLabel.textContent);
    }

    elements.manualPromptInput.value = "";
  }
}


initializeEventListeners();
