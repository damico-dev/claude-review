// GitHub accepts a review comment only on a line that a hunk of the PR's diff
// shows on the RIGHT side (an added line or a context line), and a multi-line
// comment only when both ends sit in the same hunk. One comment that breaks
// this makes GitHub reject the whole review, so review.ts checks each comment
// against this map first.

/** For each file, maps every commentable RIGHT-side line to its hunk's index. */
export type DiffLines = Map<string, Map<number, number>>;

export function parseDiffLines(diff: string): DiffLines {
  const files: DiffLines = new Map();
  let lines: Map<number, number> | undefined;
  let hunk = -1;
  let right = 0;
  // Lines still to read in the current hunk. Counting them, instead of looking
  // for headers, keeps an added line such as "++ x" (shown as "+++ x") from
  // being read as the next file's header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("+")) {
        lines?.set(right++, hunk);
        newLeft--;
      } else if (text.startsWith("-")) {
        oldLeft--;
      } else if (text.startsWith(" ") || text === "") {
        lines?.set(right++, hunk);
        oldLeft--;
        newLeft--;
      }
      // "\ No newline at end of file" counts toward neither side.
      continue;
    }
    if (text.startsWith("+++ ")) {
      // "+++ /dev/null" is a deleted file: nothing on the RIGHT side to comment on.
      lines = text.startsWith("+++ b/") ? new Map() : undefined;
      if (lines) files.set(text.slice(6), lines);
    } else if (text.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (match) {
        oldLeft = match[1] === undefined ? 1 : Number(match[1]);
        right = Number(match[2]);
        newLeft = match[3] === undefined ? 1 : Number(match[3]);
        hunk++;
      }
    }
  }
  return files;
}

export function isCommentable(diffLines: DiffLines, path: string, line: number, startLine?: number): boolean {
  const lines = diffLines.get(path);
  const hunk = lines?.get(line);
  if (hunk === undefined) return false;
  return startLine === undefined || startLine >= line || lines?.get(startLine) === hunk;
}
