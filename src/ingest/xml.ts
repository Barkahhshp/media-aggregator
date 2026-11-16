import sax from "sax";

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  content: Array<string | XmlNode>;
}

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_XML_NODES = 50_000;
const MAX_XML_DEPTH = 128;

export function localName(name: string): string {
  const separator = name.lastIndexOf(":");
  return (separator < 0 ? name : name.slice(separator + 1)).toLowerCase();
}

export function nodeText(node: XmlNode | undefined): string {
  if (node === undefined) return "";
  return node.content.map((part) => typeof part === "string" ? part : nodeText(part)).join("");
}

export function childrenNamed(node: XmlNode | undefined, expectedName: string): XmlNode[] {
  if (node === undefined) return [];
  return node.children.filter((child) => localName(child.name) === expectedName.toLowerCase());
}

export function firstChild(node: XmlNode | undefined, expectedName: string): XmlNode | undefined {
  return childrenNamed(node, expectedName)[0];
}

export function firstChildText(node: XmlNode | undefined, expectedName: string): string {
  return nodeText(firstChild(node, expectedName)).trim();
}

export function parseXmlDocument(xml: string): XmlNode {
  if (new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES) {
    throw new Error("XML payload exceeds the 2 MiB parser limit");
  }

  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let nodeCount = 0;
  const parser = sax.parser(true, { position: false, xmlns: false });
  parser.ondoctype = () => { throw new Error("XML DTD declarations are not allowed"); };
  parser.onsgmldeclaration = () => { throw new Error("XML entity declarations are not allowed"); };
  parser.onerror = (error) => { throw error; };
  parser.onopentag = (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH) {
      throw new Error("XML structure exceeds parser limits");
    }
    const node: XmlNode = {
      name: tag.name,
      attributes: tag.attributes as Record<string, string>,
      children: [],
      content: [],
    };
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else {
      parent.children.push(node);
      parent.content.push(node);
    }
    stack.push(node);
  };
  parser.onclosetag = () => { stack.pop(); };
  parser.ontext = (text) => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined && text.length > 0) parent.content.push(text);
  };
  parser.oncdata = (text) => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined && text.length > 0) parent.content.push(text);
  };

  parser.write(xml).close();
  if (stack.length !== 0 || roots.length !== 1) throw new Error("XML document must have exactly one root element");
  return roots[0];
}
