import * as pdfjsLib from "../lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

export async function extractPromptsFromPdf(fileArrayBuffer) {
  const pdfDocument = await pdfjsLib.getDocument({ data: fileArrayBuffer }).promise;
  const totalPages = pdfDocument.numPages;
  const allTextLines = [];

  for (let pageIndex = 1; pageIndex <= totalPages; pageIndex++) {
    const page = await pdfDocument.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(" ");
    allTextLines.push(pageText);
  }

  const rawText = allTextLines.join("\n");
  return splitTextIntoPrompts(rawText);
}

function splitTextIntoPrompts(rawText) {
  // Normalize line endings, merge single line breaks, then split on true paragraphs
  const normalized = rawText.replace(/(?<!\n)\n(?!\n)/g, " "); 
  return normalized.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
}
