type Node = { tag: string; attrs: Map<string, string>; children: (Node | string)[]; parent?: Node };
export const allowed: Record<string, true> = {
  form: true,
  fieldset: true,
  legend: true,
  p: true,
  div: true,
  span: true,
  label: true,
  input: true,
  select: true,
  option: true,
  optgroup: true,
  textarea: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  strong: true,
  b: true,
  em: true,
  i: true,
  code: true,
  br: true,
  ul: true,
  ol: true,
  li: true,
  small: true,
  section: true,
  article: true,
  blockquote: true,
  button: true,
};
export const controls: Record<string, true> = { input: true, select: true, textarea: true };
const blocks: Record<string, true> = {
  form: true,
  fieldset: true,
  legend: true,
  p: true,
  div: true,
  label: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  br: true,
  ul: true,
  ol: true,
  li: true,
  section: true,
  article: true,
  blockquote: true,
};
export function invalid(): never {
  throw new Error("Unsupported form");
}
export const attr = (node: Node, key: string) => node.attrs.get(key);
export const has = (node: Node, key: string) => node.attrs.has(key);
export const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  AMP: "&",
  LT: "<",
  GT: ">",
  QUOT: '"',
};
export function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (_, key: string) => {
    if (key[0] !== "#") return Object.hasOwn(entities, key) ? entities[key]! : invalid();
    const value = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : invalid();
  });
}
export function text(node: Node, omitControls = true): string {
  return node.children
    .map((child) =>
      typeof child === "string"
        ? child
        : child.tag === "button" || (omitControls && Object.hasOwn(controls, child.tag))
          ? ""
          : `${Object.hasOwn(blocks, child.tag) ? "\n" : ""}${text(child, omitControls)}${Object.hasOwn(blocks, child.tag) ? "\n" : ""}`,
    )
    .join("");
}
export function ancestor(node: Node, tag: string): Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.tag === tag) return parent;
}
export async function readFormNodes(html: string) {
  const root: Node = { tag: "", attrs: new Map(), children: [] },
    stack = [root],
    nodes: Node[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        if (nodes.length >= 256 || stack.length > 24) invalid();
        const attributes = [...element.attributes];
        if (new Set(attributes.map(([key]) => key)).size !== attributes.length) invalid();
        const node: Node = { tag: element.tagName, attrs: new Map(attributes), children: [], parent: stack.at(-1)! };
        node.parent!.children.push(node);
        nodes.push(node);
        if (element.canHaveContent) {
          stack.push(node);
          element.onEndTag(() => {
            if (stack.pop() !== node) invalid();
          });
        }
      },
    })
    .onDocument({
      text(chunk) {
        stack.at(-1)!.children.push(chunk.text);
      },
    })
    .transform(new Response(html))
    .text();
  if (stack.length !== 1) invalid();
  return { root, nodes };
}
