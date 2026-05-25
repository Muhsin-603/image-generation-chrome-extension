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
  return rawText
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}
