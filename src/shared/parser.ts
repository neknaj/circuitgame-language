import {
  ArgExpression,
  ArgSlice,
  CallStatement,
  ColorToken,
  DefinitionBlock,
  DiagnosticLike,
  GraphicalBlock,
  GraphicalEntry,
  ParsedDocument,
  PortSpec,
  Span,
  TestBlock,
  TestCase,
  TopLevelItem,
  UsingDirective,
} from "./types";

const WORD_RE = /[A-Za-z0-9_]+/y;
const USING_RE =
  /^using\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s*->\s*(\d+)\s*;?\s*$/d;
const DEF_HEADER_RE =
  /^(func|module)\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*->\s*\(([\s\S]*?)\)\s*$/d;
const TEST_HEADER_RE =
  /^test\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s*->\s*(\d+)\s*$/d;
const GRAPHICAL_HEADER_RE =
  /^graphical\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s*x\s*(\d+)\s*$/d;
const GRAPHICAL_ENTRY_RE =
  /^\s*(\d+)\s*,\s*(\d+)\s*:\s*([A-Za-z0-9_]+)\s*(?:<-\s*)?(#[0-9A-Fa-f]{6})\s+(#[0-9A-Fa-f]{6})\s*$/d;

function diag(
  code: string,
  message: string,
  span: Span,
  source: "parser" | "semantic" = "parser",
  severity: "error" | "warning" | "info" = "error",
): DiagnosticLike {
  return { code, message, severity, span, source };
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (isWhitespace(text[index])) {
      index += 1;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function findKeywordAt(text: string, start: number): string | undefined {
  const keywords = ["using", "func", "module", "test", "graphical"];
  for (const keyword of keywords) {
    if (!text.startsWith(keyword, start)) {
      continue;
    }
    const before = start > 0 ? text[start - 1] : "";
    const after = text[start + keyword.length] ?? "";
    const beforeOk = before === "" || !/[A-Za-z0-9_]/.test(before);
    const afterOk = after === "" || !/[A-Za-z0-9_]/.test(after);
    if (beforeOk && afterOk) {
      return keyword;
    }
  }
  return undefined;
}

function findSemicolon(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (text[index] === ";") {
      return index;
    }
    index += 1;
  }
  return -1;
}

function findBlockOpenBrace(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (text[index] === "{") {
      return index;
    }
    index += 1;
  }
  return -1;
}

function findMatchingBrace(text: string, openBrace: number): number {
  let index = openBrace + 1;
  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (text[index] === "}") {
      return index;
    }
    index += 1;
  }
  return -1;
}

function splitSemicolonSegments(
  text: string,
  baseOffset: number,
): Array<{ text: string; span: Span }> {
  const segments: Array<{ text: string; span: Span }> = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (text[index] === ";") {
      segments.push({
        text: text.slice(start, index),
        span: { start: baseOffset + start, end: baseOffset + index },
      });
      start = index + 1;
    }
    index += 1;
  }

  const trailing = text.slice(start);
  if (trailing.trim().length > 0) {
    segments.push({
      text: trailing,
      span: { start: baseOffset + start, end: baseOffset + text.length },
    });
  }

  return segments;
}

function trimRelativeSpan(text: string): Span | undefined {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespace(text[start])) {
    start += 1;
  }
  while (end > start && isWhitespace(text[end - 1])) {
    end -= 1;
  }
  if (start >= end) {
    return undefined;
  }
  return { start, end };
}

function trimStatementSegment(text: string): Span | undefined {
  let start = 0;
  while (start < text.length) {
    while (start < text.length && isWhitespace(text[start])) {
      start += 1;
    }
    if (text[start] === "/" && text[start + 1] === "/") {
      start += 2;
      while (start < text.length && text[start] !== "\n") {
        start += 1;
      }
      continue;
    }
    break;
  }

  let end = text.length;
  while (end > start && isWhitespace(text[end - 1])) {
    end -= 1;
  }

  if (start >= end) {
    return undefined;
  }
  return { start, end };
}

function parsePortList(
  text: string,
  baseOffset: number,
  diagnostics: DiagnosticLike[],
  codePrefix: string,
): PortSpec[] {
  const ports: PortSpec[] = [];
  let index = 0;

  while (index < text.length) {
    while (
      index < text.length &&
      (isWhitespace(text[index]) || text[index] === ",")
    ) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }

    WORD_RE.lastIndex = index;
    const match = WORD_RE.exec(text);
    if (!match) {
      diagnostics.push(
        diag(
          `${codePrefix}-unexpected`,
          "Unexpected token in port list.",
          { start: baseOffset + index, end: baseOffset + index + 1 },
        ),
      );
      index += 1;
      continue;
    }

    const name = match[0];
    const nameStart = match.index;
    const nameEnd = nameStart + name.length;
    index = nameEnd;

    while (index < text.length && isWhitespace(text[index])) {
      index += 1;
    }

    let width: number | undefined;
    if (text[index] === "(") {
      const openParen = index;
      index += 1;
      while (index < text.length && isWhitespace(text[index])) {
        index += 1;
      }
      const widthStart = index;
      while (index < text.length && /[0-9]/.test(text[index])) {
        index += 1;
      }
      const widthText = text.slice(widthStart, index);
      while (index < text.length && isWhitespace(text[index])) {
        index += 1;
      }
      if (text[index] !== ")" || widthText.length === 0) {
        diagnostics.push(
          diag(
            `${codePrefix}-width`,
            "Invalid width annotation. Expected `(number)`.",
            { start: baseOffset + openParen, end: baseOffset + Math.max(index, openParen + 1) },
          ),
        );
      } else {
        width = Number.parseInt(widthText, 10);
        index += 1;
      }
    }

    ports.push({
      name,
      width,
      span: { start: baseOffset + nameStart, end: baseOffset + nameEnd },
    });
  }

  return ports;
}

function parseSlice(
  text: string,
  baseOffset: number,
  diagnostics: DiagnosticLike[],
): ArgSlice | undefined {
  const match = /^\[\s*(\d+)\s*(?:([,:-])\s*(\d+)\s*)?\]$/.exec(text);
  if (!match) {
    diagnostics.push(
      diag(
        "slice-invalid",
        "Invalid slice syntax. Use `[n]`, `[start,end]`, or `[start:end]`.",
        { start: baseOffset, end: baseOffset + text.length },
      ),
    );
    return undefined;
  }

  return {
    start: Number.parseInt(match[1], 10),
    end: match[3] ? Number.parseInt(match[3], 10) : undefined,
    separator: match[2] as "," | ":" | "-" | undefined,
  };
}

function parseArgList(
  text: string,
  baseOffset: number,
  diagnostics: DiagnosticLike[],
): ArgExpression[] {
  const args: ArgExpression[] = [];
  let index = 0;

  while (index < text.length) {
    while (
      index < text.length &&
      (isWhitespace(text[index]) || text[index] === ",")
    ) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    if (text[index] === "/" && text[index + 1] === "/") {
      break;
    }

    WORD_RE.lastIndex = index;
    const match = WORD_RE.exec(text);
    if (!match) {
      diagnostics.push(
        diag(
          "arg-unexpected",
          "Unexpected token in argument list.",
          { start: baseOffset + index, end: baseOffset + index + 1 },
        ),
      );
      index += 1;
      continue;
    }

    const baseName = match[0];
    const nameStart = match.index;
    const nameEnd = nameStart + baseName.length;
    let tokenEnd = nameEnd;
    index = nameEnd;

    const gapStart = index;
    while (index < text.length && isWhitespace(text[index])) {
      index += 1;
    }

    let slice: ArgSlice | undefined;
    if (text[index] === "[") {
      const closeBracket = text.indexOf("]", index + 1);
      if (closeBracket < 0) {
        diagnostics.push(
          diag(
            "arg-slice-unclosed",
            "Unclosed slice expression.",
            { start: baseOffset + index, end: baseOffset + text.length },
          ),
        );
        tokenEnd = text.length;
        index = text.length;
      } else {
        slice = parseSlice(
          text.slice(index, closeBracket + 1),
          baseOffset + index,
          diagnostics,
        );
        tokenEnd = closeBracket + 1;
        index = tokenEnd;
      }
    } else {
      index = gapStart;
    }

    args.push({
      text: text.slice(nameStart, tokenEnd),
      baseName,
      slice,
      span: { start: baseOffset + nameStart, end: baseOffset + tokenEnd },
    });
  }

  return args;
}

function parseStatement(
  rawText: string,
  span: Span,
  diagnostics: DiagnosticLike[],
): CallStatement | undefined {
  const trimmed = trimStatementSegment(rawText);
  if (!trimmed) {
    return undefined;
  }

  const text = rawText.slice(trimmed.start, trimmed.end);
  const absoluteTrimmed = {
    start: span.start + trimmed.start,
    end: span.start + trimmed.end,
  };
  let operatorIndex = -1;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      break;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (bracketDepth === 0 && parenDepth === 0 && (char === ":" || char === "=")) {
      operatorIndex = index;
      break;
    }
  }

  if (operatorIndex < 0) {
    diagnostics.push(
      diag(
        "statement-operator",
        "Expected `:` or `=` in statement.",
        absoluteTrimmed,
      ),
    );
    return undefined;
  }

  const operator = text[operatorIndex] as ":" | "=";
  const lhsText = text.slice(0, operatorIndex);
  const rhsText = text.slice(operatorIndex + 1);
  const statementStart = absoluteTrimmed.start;

  const lhs = parsePortList(
    lhsText,
    statementStart,
    diagnostics,
    "statement-lhs",
  );

  let rhsIndex = 0;
  while (rhsIndex < rhsText.length && isWhitespace(rhsText[rhsIndex])) {
    rhsIndex += 1;
  }

  WORD_RE.lastIndex = rhsIndex;
  const calleeMatch = WORD_RE.exec(rhsText);
  if (!calleeMatch) {
    diagnostics.push(
      diag(
        "statement-callee",
        "Expected callable name after assignment operator.",
        {
          start: statementStart + operatorIndex + 1,
          end: statementStart + operatorIndex + 2,
        },
      ),
    );
    return undefined;
  }

  const callee = calleeMatch[0];
  const calleeStart = calleeMatch.index;
  const calleeEnd = calleeStart + callee.length;
  rhsIndex = calleeEnd;

  while (rhsIndex < rhsText.length && isWhitespace(rhsText[rhsIndex])) {
    rhsIndex += 1;
  }

  let arrowSpan: Span | undefined;
  if (rhsText.startsWith("<-", rhsIndex)) {
    arrowSpan = {
      start: statementStart + operatorIndex + 1 + rhsIndex,
      end: statementStart + operatorIndex + 1 + rhsIndex + 2,
    };
    rhsIndex += 2;
  }

  const argOffset = statementStart + operatorIndex + 1 + rhsIndex;
  const args = parseArgList(rhsText.slice(rhsIndex), argOffset, diagnostics);

  return {
    kind: "statement",
    span: absoluteTrimmed,
    operator,
    lhs,
    callee,
    calleeSpan: {
      start: statementStart + operatorIndex + 1 + calleeStart,
      end: statementStart + operatorIndex + 1 + calleeEnd,
    },
    args,
    arrowSpan,
    raw: text,
  };
}

function parseUsing(
  rawText: string,
  span: Span,
  diagnostics: DiagnosticLike[],
): UsingDirective | undefined {
  const match = USING_RE.exec(rawText);
  if (!match || !match.indices) {
    diagnostics.push(
      diag("using-invalid", "Invalid `using` directive.", span),
    );
    return undefined;
  }

  const nameIndices = match.indices[1];
  return {
    kind: "using",
    name: match[1],
    nameSpan: {
      start: span.start + nameIndices[0],
      end: span.start + nameIndices[1],
    },
    inputs: Number.parseInt(match[2], 10),
    outputs: Number.parseInt(match[3], 10),
    span,
  };
}

function parseDefinition(
  headerText: string,
  headerSpan: Span,
  bodyText: string,
  bodySpan: Span,
  blockSpan: Span,
  diagnostics: DiagnosticLike[],
): DefinitionBlock | undefined {
  const headerMatch = DEF_HEADER_RE.exec(headerText);
  if (!headerMatch || !headerMatch.indices) {
    diagnostics.push(
      diag(
        "definition-header",
        "Invalid definition header. Expected `func name(...) -> (...)` or `module name(...) -> (...)`.",
        headerSpan,
      ),
    );
    return undefined;
  }

  const nameIndices = headerMatch.indices[2];
  const paramIndices = headerMatch.indices[3];
  const outputIndices = headerMatch.indices[4];
  const blockDiagnostics: DiagnosticLike[] = [];

  const params = parsePortList(
    headerText.slice(paramIndices[0], paramIndices[1]),
    headerSpan.start + paramIndices[0],
    blockDiagnostics,
    "definition-param",
  );
  const outputs = parsePortList(
    headerText.slice(outputIndices[0], outputIndices[1]),
    headerSpan.start + outputIndices[0],
    blockDiagnostics,
    "definition-output",
  );

  const statements = splitSemicolonSegments(bodyText, bodySpan.start)
    .map((segment) => parseStatement(segment.text, segment.span, blockDiagnostics))
    .filter((statement): statement is CallStatement => statement !== undefined);

  const definition: DefinitionBlock = {
    kind: headerMatch[1] as "func" | "module",
    name: headerMatch[2],
    nameSpan: {
      start: headerSpan.start + nameIndices[0],
      end: headerSpan.start + nameIndices[1],
    },
    params,
    outputs,
    headerSpan,
    bodySpan,
    span: blockSpan,
    statements,
    diagnostics: blockDiagnostics,
  };

  diagnostics.push(...blockDiagnostics);
  return definition;
}

function parseTest(
  headerText: string,
  headerSpan: Span,
  bodyText: string,
  bodySpan: Span,
  blockSpan: Span,
  diagnostics: DiagnosticLike[],
): TestBlock | undefined {
  const headerMatch = TEST_HEADER_RE.exec(headerText);
  if (!headerMatch || !headerMatch.indices) {
    diagnostics.push(
      diag(
        "test-header",
        "Invalid test header. Expected `test name:inputs->outputs`.",
        headerSpan,
      ),
    );
    return undefined;
  }

  const blockDiagnostics: DiagnosticLike[] = [];
  const cases: TestCase[] = [];

  for (const segment of splitSemicolonSegments(bodyText, bodySpan.start)) {
    const trimmed = trimRelativeSpan(segment.text);
    if (!trimmed) {
      continue;
    }

    const relativeText = segment.text.slice(trimmed.start, trimmed.end);
    const arrowIndex = relativeText.indexOf("->");
    if (arrowIndex < 0) {
      blockDiagnostics.push(
        diag(
          "test-case-arrow",
          "Test case must contain `->`.",
          {
            start: segment.span.start + trimmed.start,
            end: segment.span.start + trimmed.end,
          },
        ),
      );
      continue;
    }

    const left = relativeText.slice(0, arrowIndex);
    const right = relativeText.slice(arrowIndex + 2);
    const bitRegex = /\b(?:t|f|0|1)\b/g;
    const inputs = Array.from(left.matchAll(bitRegex), (match) => match[0]);
    const outputs = Array.from(right.matchAll(bitRegex), (match) => match[0]);

    cases.push({
      span: {
        start: segment.span.start + trimmed.start,
        end: segment.span.start + trimmed.end,
      },
      inputs,
      outputs,
    });
  }

  const nameIndices = headerMatch.indices[1];
  const block: TestBlock = {
    kind: "test",
    name: headerMatch[1],
    nameSpan: {
      start: headerSpan.start + nameIndices[0],
      end: headerSpan.start + nameIndices[1],
    },
    inputs: Number.parseInt(headerMatch[2], 10),
    outputs: Number.parseInt(headerMatch[3], 10),
    bodySpan,
    span: blockSpan,
    cases,
    diagnostics: blockDiagnostics,
  };

  diagnostics.push(...blockDiagnostics);
  return block;
}

function parseGraphical(
  headerText: string,
  headerSpan: Span,
  bodyText: string,
  bodySpan: Span,
  blockSpan: Span,
  diagnostics: DiagnosticLike[],
): GraphicalBlock | undefined {
  const headerMatch = GRAPHICAL_HEADER_RE.exec(headerText);
  if (!headerMatch || !headerMatch.indices) {
    diagnostics.push(
      diag(
        "graphical-header",
        "Invalid graphical header. Expected `graphical name: WxH`.",
        headerSpan,
      ),
    );
    return undefined;
  }

  const blockDiagnostics: DiagnosticLike[] = [];
  const entries: GraphicalEntry[] = [];

  for (const segment of splitSemicolonSegments(bodyText, bodySpan.start)) {
    const entryMatch = GRAPHICAL_ENTRY_RE.exec(segment.text);
    if (!entryMatch || !entryMatch.indices) {
      if (segment.text.trim().length > 0) {
        blockDiagnostics.push(
          diag(
            "graphical-entry",
            "Invalid graphical entry. Expected `x,y: target <- #foreground #background`.",
            segment.span,
          ),
        );
      }
      continue;
    }

    const targetIndices = entryMatch.indices[3];
    const colorAIndices = entryMatch.indices[4];
    const colorBIndices = entryMatch.indices[5];
    const colors: ColorToken[] = [
      {
        value: entryMatch[4],
        span: {
          start: segment.span.start + colorAIndices[0],
          end: segment.span.start + colorAIndices[1],
        },
      },
      {
        value: entryMatch[5],
        span: {
          start: segment.span.start + colorBIndices[0],
          end: segment.span.start + colorBIndices[1],
        },
      },
    ];

    entries.push({
      span: segment.span,
      x: Number.parseInt(entryMatch[1], 10),
      y: Number.parseInt(entryMatch[2], 10),
      target: entryMatch[3],
      targetSpan: {
        start: segment.span.start + targetIndices[0],
        end: segment.span.start + targetIndices[1],
      },
      colors,
    });
  }

  const nameIndices = headerMatch.indices[1];
  const block: GraphicalBlock = {
    kind: "graphical",
    name: headerMatch[1],
    nameSpan: {
      start: headerSpan.start + nameIndices[0],
      end: headerSpan.start + nameIndices[1],
    },
    width: Number.parseInt(headerMatch[2], 10),
    height: Number.parseInt(headerMatch[3], 10),
    bodySpan,
    span: blockSpan,
    entries,
    diagnostics: blockDiagnostics,
  };

  diagnostics.push(...blockDiagnostics);
  return block;
}

function pushItem(
  items: TopLevelItem[],
  item: TopLevelItem | undefined,
): void {
  if (item) {
    items.push(item);
  }
}

function findRecoveryOffset(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === "\n" || text[index] === ";" || text[index] === "}") {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

export function parseNcgDocument(uri: string, text: string): ParsedDocument {
  const diagnostics: DiagnosticLike[] = [];
  const items: TopLevelItem[] = [];
  let index = 0;

  while (index < text.length) {
    index = skipTrivia(text, index);
    if (index >= text.length) {
      break;
    }

    const keyword = findKeywordAt(text, index);
    if (!keyword) {
      diagnostics.push(
        diag(
          "top-level-token",
          "Unexpected top-level token.",
          { start: index, end: Math.min(index + 1, text.length) },
        ),
      );
      index = findRecoveryOffset(text, index);
      continue;
    }

    if (keyword === "using") {
      const semicolon = findSemicolon(text, index);
      if (semicolon < 0) {
        diagnostics.push(
          diag(
            "using-semicolon",
            "Unterminated `using` directive.",
            { start: index, end: text.length },
          ),
        );
        break;
      }
      const span = { start: index, end: semicolon + 1 };
      pushItem(items, parseUsing(text.slice(index, semicolon + 1), span, diagnostics));
      index = semicolon + 1;
      continue;
    }

    const openBrace = findBlockOpenBrace(text, index);
    if (openBrace < 0) {
      diagnostics.push(
        diag(
          `${keyword}-brace-open`,
          `Expected \`{\` after ${keyword} header.`,
          { start: index, end: text.length },
        ),
      );
      break;
    }

    const closeBrace = findMatchingBrace(text, openBrace);
    if (closeBrace < 0) {
      diagnostics.push(
        diag(
          `${keyword}-brace-close`,
          `Unclosed block for ${keyword}.`,
          { start: openBrace, end: text.length },
        ),
      );
      break;
    }

    const headerSpan = { start: index, end: openBrace };
    const bodySpan = { start: openBrace + 1, end: closeBrace };
    const blockSpan = { start: index, end: closeBrace + 1 };
    const headerText = text.slice(index, openBrace);
    const bodyText = text.slice(openBrace + 1, closeBrace);

    if (keyword === "func" || keyword === "module") {
      pushItem(
        items,
        parseDefinition(headerText, headerSpan, bodyText, bodySpan, blockSpan, diagnostics),
      );
    } else if (keyword === "test") {
      pushItem(
        items,
        parseTest(headerText, headerSpan, bodyText, bodySpan, blockSpan, diagnostics),
      );
    } else if (keyword === "graphical") {
      pushItem(
        items,
        parseGraphical(headerText, headerSpan, bodyText, bodySpan, blockSpan, diagnostics),
      );
    }

    index = closeBrace + 1;
  }

  const usings = items.filter((item): item is UsingDirective => item.kind === "using");
  const definitions = items.filter(
    (item): item is DefinitionBlock => item.kind === "func" || item.kind === "module",
  );
  const tests = items.filter((item): item is TestBlock => item.kind === "test");
  const graphicals = items.filter(
    (item): item is GraphicalBlock => item.kind === "graphical",
  );
  const colors = graphicals.flatMap((graphical) =>
    graphical.entries.flatMap((entry) => entry.colors),
  );

  return {
    uri,
    text,
    items,
    usings,
    definitions,
    tests,
    graphicals,
    colors,
    diagnostics,
  };
}
