export function extractPromptsFromMarkdown(fileText) {
  return fileText
    .split(/\n+/)
    .map(line => stripMarkdownSyntax(line.trim()))
    .filter(line => line.length > 0)
    .filter(line => !isMarkdownHeading(line));
}

function stripMarkdownSyntax(line) {
  const withoutBold = line.replace(/\*\*(.*?)\*\*/g, "$1");
  const withoutItalic = withoutBold.replace(/\*(.*?)\*/g, "$1");
  const withoutInlineCode = withoutItalic.replace(/`(.*?)`/g, "$1");
  const withoutListMarker = withoutInlineCode.replace(/^[-*+]\s+/, "");
  const withoutNumberedList = withoutListMarker.replace(/^\d+\.\s+/, "");
  return withoutNumberedList.trim();
}

function isMarkdownHeading(line) {
  return /^#{1,6}\s/.test(line);
}
