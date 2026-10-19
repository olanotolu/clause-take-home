/** Counts non-whitespace runs without allocating an array proportional to the document's number of words. */
export function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const whitespace = (code >= 0x0009 && code <= 0x000d) || code === 0x0020 || code === 0x00a0 || code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
      code === 0x3000 || code === 0xfeff;
    if (whitespace) inWord = false;
    else if (!inWord) { count++; inWord = true; }
  }
  return count;
}
