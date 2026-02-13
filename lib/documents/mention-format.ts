const SIMPLE_FILENAME_MENTION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function formatDocumentMention(originalFilename: string): string {
  if (SIMPLE_FILENAME_MENTION.test(originalFilename)) {
    return `@${originalFilename}`;
  }
  return `@{${originalFilename}}`;
}
