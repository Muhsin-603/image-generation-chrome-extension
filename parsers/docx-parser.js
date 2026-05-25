export async function extractPromptsFromDocx(fileArrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer: fileArrayBuffer });
  return splitTextIntoPrompts(result.value);
}

function splitTextIntoPrompts(rawText) {
  return rawText
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}
