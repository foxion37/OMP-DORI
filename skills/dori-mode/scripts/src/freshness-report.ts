export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = new RegExp(
    `\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|halted|done) \\| (?!<what)\\S`,
  );
  const template = (l: string) => /["'`]\[REPORT\]/.test(l) && /\$?\{[A-Za-z_][\w.]*\}/.test(l);
  const hits = screen
    .split("\n")
    .flatMap((l) => (grammar.test(l) && !template(l) ? [l.slice(l.indexOf("[REPORT]"))] : []));
  return hits.at(-1)?.replace(/["'\])\s,]+$/, "") ?? null;
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home)
    .join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

// A report is a line that starts with [REPORT], or the last quoted element of an argv row, the shape lanes are told
// to send it in: an argv array ending in "lead:p1", "[REPORT] key | kind | text". Instructions
// and prompts that quote the grammar mid-sentence are dropped before parsing, so an example is never posted as the
// lane's progress. A report whose whole text is one unfilled placeholder ($name, ${name}, {name}, %s, <what>) is a
// template, quoted or not (#29). The match is anchored to the [REPORT] key | kind | text structure, so
// 'deployed api | %s' stays a real report.
const placeholderOnly =
  /^\s*\[REPORT\][^|]*\|[^|]*\|\s*["'`]?(\$\{?[A-Za-z_]\w*\}?|\{[A-Za-z_][\w.]*\}|%[sdif]|<[^>]+>)["'`)\s]*$/;
// An argv row is the whole line (optionally inside one spawn call): [ then quoted strings separated by commas, then ]. Only its last element can be the
// report, which is how lanes are told to send it. Prose that happens to contain a quoted report is not an argv row.
const argvElements = (line: string): string[] | null => {
  // A spawn call around the row, such as Bun.spawn([...]) or subprocess.run([...]), is the same row.
  const call = /^\s*[\w.$]+\(\s*(\[.*\])\s*\)\s*;?\s*$/.exec(line);
  const row = (call?.[1] ?? line).trim();
  if (!row.startsWith("[") || !row.endsWith("]")) return null;
  const element = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*(,|$)/y;
  const inner = row.slice(1, -1);
  const elements: string[] = [];
  element.lastIndex = 0;
  while (element.lastIndex < inner.length) {
    const m = element.exec(inner);
    if (!m) return null;
    elements.push(m[1] ?? m[2] ?? "");
    if (m[3] === "") break;
  }
  return element.lastIndex === inner.length && elements.length > 0 ? elements : null;
};
const argvReport = (line: string): string | null => {
  const last = argvElements(line)?.at(-1);
  return last?.startsWith("[REPORT]") ? last : null;
};
const reportCandidate = (l: string): string | null => {
  if (!l.includes("[REPORT]")) return l;
  const report = /^\s*\[REPORT\]/.test(l) ? l : argvReport(l);
  return report !== null && !placeholderOnly.test(report) ? report : null;
};
export const anchoredReportLine = (screen: string, key: string): string | null =>
  lastReportLine(
    screen
      .split("\n")
      .flatMap((l) => reportCandidate(l) ?? [])
      .join("\n"),
    key,
  );
