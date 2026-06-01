export async function extractPromptsFromDocx(fileArrayBuffer) {
  if (typeof mammoth === "undefined") {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("lib/mammoth.browser.min.js");
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load Mammoth.js"));
      document.head.appendChild(script);
    });
  }
  const result = await mammoth.extractRawText({ arrayBuffer: fileArrayBuffer });
  return splitTextIntoPrompts(result.value);
}

function splitTextIntoPrompts(rawText) {
  return rawText
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}
