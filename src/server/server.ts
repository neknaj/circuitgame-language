import { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Color,
  ColorInformation,
  ColorPresentation,
  CompletionItem,
  CompletionItemKind,
  Connection,
  createConnection,
  Definition,
  Diagnostic,
  DiagnosticSeverity,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentSymbol,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  ParameterInformation,
  Position,
  ProposedFeatures,
  Range,
  ReferenceParams,
  RenameParams,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  SymbolKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  buildWorkspaceAnalysis,
  findOccurrenceAtOffset,
  findScopeAtOffset,
  formatCallableSignature,
  formatPort,
} from "../shared/analyzer";
import { parseNcgDocument } from "../shared/parser";
import {
  AnalyzedDocument,
  CallableSymbol,
  ColorToken,
  DefinitionScope,
  LocalSymbol,
  Span,
  SymbolOccurrence,
  WorkspaceAnalysis,
} from "../shared/types";

const connection: Connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let workspaceFolders: string[] = [];
let analysisDocuments = new Map<string, TextDocument>();
let workspaceAnalysis: WorkspaceAnalysis = {
  documents: new Map(),
  callableByName: new Map(),
  callableById: new Map(),
  occurrencesBySymbol: new Map(),
};
let publishedDiagnosticUris = new Set<string>();

function getTextDocument(uri: string): TextDocument | undefined {
  return analysisDocuments.get(uri) ?? documents.get(uri);
}

function spanToRange(document: TextDocument, span: Span): Range {
  return Range.create(document.positionAt(span.start), document.positionAt(span.end));
}

function toDiagnostic(
  document: TextDocument,
  diagnostic: {
    code: string;
    message: string;
    severity: "error" | "warning" | "info";
    source: string;
    span: Span;
  },
): Diagnostic {
  const severityMap: Record<string, DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    info: DiagnosticSeverity.Information,
  };

  return {
    range: spanToRange(document, diagnostic.span),
    message: diagnostic.message,
    severity: severityMap[diagnostic.severity],
    source: diagnostic.source,
    code: diagnostic.code,
  };
}

function getAnalyzedDocument(uri: string): AnalyzedDocument | undefined {
  return workspaceAnalysis.documents.get(uri);
}

function getTokenAtOffset(
  text: string,
  offset: number,
): { text: string; span: Span } | undefined {
  let start = offset;
  let end = offset;

  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
    end += 1;
  }

  if (start === end) {
    return undefined;
  }

  return {
    text: text.slice(start, end),
    span: { start, end },
  };
}

function findLocalSymbol(
  analyzed: AnalyzedDocument,
  symbolId: string,
): LocalSymbol | undefined {
  for (const scope of analyzed.scopes) {
    const symbol = Array.from(scope.symbols.values()).find((entry) => entry.id === symbolId);
    if (symbol) {
      return symbol;
    }
  }
  return undefined;
}

function resolvedOccurrenceAt(
  params: TextDocumentPositionParams,
): {
  analyzed: AnalyzedDocument;
  document: TextDocument;
  occurrence?: SymbolOccurrence;
  offset: number;
} | undefined {
  const analyzed = getAnalyzedDocument(params.textDocument.uri);
  const document = getTextDocument(params.textDocument.uri);
  if (!analyzed || !document) {
    return undefined;
  }

  const offset = document.offsetAt(params.position);
  return {
    analyzed,
    document,
    occurrence: findOccurrenceAtOffset(analyzed, offset),
    offset,
  };
}

function definitionLocations(symbolId: string): Location[] {
  const callable = workspaceAnalysis.callableById.get(symbolId);
  if (callable) {
    const document = getTextDocument(callable.uri);
    if (!document) {
      return [];
    }
    return [Location.create(callable.uri, spanToRange(document, callable.span))];
  }

  return (workspaceAnalysis.occurrencesBySymbol.get(symbolId) ?? [])
    .filter((occurrence) => occurrence.role === "definition")
    .flatMap((occurrence) => {
      const document = getTextDocument(occurrence.uri);
      if (!document) {
        return [];
      }
      return [Location.create(occurrence.uri, spanToRange(document, occurrence.span))];
    });
}

function referenceLocations(
  symbolId: string,
  includeDeclaration: boolean,
): Location[] {
  return (workspaceAnalysis.occurrencesBySymbol.get(symbolId) ?? [])
    .filter((occurrence) => includeDeclaration || occurrence.role !== "definition")
    .flatMap((occurrence) => {
      const document = getTextDocument(occurrence.uri);
      if (!document) {
        return [];
      }
      return [Location.create(occurrence.uri, spanToRange(document, occurrence.span))];
    });
}

function buildKeywordItems(): CompletionItem[] {
  return ["using", "func", "module", "test", "graphical"].map((keyword) => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
  }));
}

function uniqueCallablesForUri(uri: string): CallableSymbol[] {
  const selected = new Map<string, CallableSymbol>();
  for (const candidates of workspaceAnalysis.callableByName.values()) {
    const preferred = candidates.find((candidate) => candidate.uri === uri) ?? candidates[0];
    if (preferred) {
      selected.set(preferred.name, preferred);
    }
  }
  return Array.from(selected.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function buildCallableCompletionItems(uri: string): CompletionItem[] {
  return uniqueCallablesForUri(uri).map((callable) => ({
    label: callable.name,
    kind:
      callable.kind === "module"
        ? CompletionItemKind.Module
        : callable.kind === "using"
          ? CompletionItemKind.Operator
          : CompletionItemKind.Function,
    detail: formatCallableSignature(callable),
    documentation: {
      kind: "markdown",
      value: `\`${formatCallableSignature(callable)}\``,
    },
  }));
}

function buildLocalCompletionItems(scope: DefinitionScope | undefined): CompletionItem[] {
  if (!scope) {
    return [];
  }

  return Array.from(scope.symbols.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((symbol) => ({
      label: symbol.name,
      kind:
        symbol.kind === "output"
          ? CompletionItemKind.Field
          : CompletionItemKind.Variable,
      detail:
        symbol.width === undefined
          ? `${symbol.kind} in ${symbol.definitionName}`
          : `${symbol.kind} ${symbol.width}-bit in ${symbol.definitionName}`,
    }));
}

function isCallableContext(document: TextDocument, position: Position): boolean {
  const prefix = document.getText(
    Range.create(Position.create(position.line, 0), position),
  );
  return /(?:[:=]\s*|<-\s*)[A-Za-z0-9_]*$/.test(prefix);
}

function buildSignatureInformation(callable: CallableSymbol): SignatureInformation {
  const params = callable.params.map(formatPort);
  const outputs = callable.outputs.map(formatPort).join(" ");
  const label = `${callable.name}(${params.join(" ")}) -> (${outputs})`;

  return SignatureInformation.create(
    label,
    undefined,
    ...params.map((param) => ParameterInformation.create(param)),
  );
}

function hoverForCallable(callable: CallableSymbol): Hover {
  return {
    contents: {
      kind: "markdown",
      value: `\`${formatCallableSignature(callable)}\``,
    },
  };
}

function hoverForLocal(symbol: LocalSymbol): Hover {
  const width = symbol.width === undefined ? "" : ` (${symbol.width}-bit)`;
  return {
    contents: {
      kind: "markdown",
      value: `\`${symbol.kind} ${symbol.name}${width}\`\n\nDefined in \`${symbol.definitionName}\`.`,
    },
  };
}

function documentSymbols(uri: string): DocumentSymbol[] {
  const analyzed = getAnalyzedDocument(uri);
  const document = getTextDocument(uri);
  if (!analyzed || !document) {
    return [];
  }

  const scopeByName = new Map(
    analyzed.scopes.map((scope) => [scope.definition.name, scope]),
  );

  return analyzed.parsed.items.map((item) => {
    const kind =
      item.kind === "func"
        ? SymbolKind.Function
        : item.kind === "module"
          ? SymbolKind.Module
          : item.kind === "test"
            ? SymbolKind.Event
            : item.kind === "graphical"
              ? SymbolKind.Interface
              : SymbolKind.Operator;

    const itemName = item.name;
    const selectionSpan = item.nameSpan;
    const children: DocumentSymbol[] = [];

    if (item.kind === "func" || item.kind === "module") {
      const scope = scopeByName.get(item.name);
      if (scope) {
        for (const symbol of Array.from(scope.symbols.values()).sort((left, right) =>
          left.span.start - right.span.start,
        )) {
          children.push(
            DocumentSymbol.create(
              symbol.name,
              symbol.kind,
              symbol.kind === "output" ? SymbolKind.Field : SymbolKind.Variable,
              spanToRange(document, symbol.span),
              spanToRange(document, symbol.span),
            ),
          );
        }
      }
    }

    return DocumentSymbol.create(
      itemName,
      item.kind,
      kind,
      spanToRange(document, item.span),
      spanToRange(document, selectionSpan),
      children,
    );
  });
}

function workspaceSymbols(query: string): SymbolInformation[] {
  const lowered = query.trim().toLowerCase();
  const symbols: SymbolInformation[] = [];

  for (const analyzed of workspaceAnalysis.documents.values()) {
    const document = getTextDocument(analyzed.uri);
    if (!document) {
      continue;
    }

    for (const item of analyzed.parsed.items) {
      const name = item.name;
      if (lowered.length > 0 && !name.toLowerCase().includes(lowered)) {
        continue;
      }

      const kind =
        item.kind === "func"
          ? SymbolKind.Function
          : item.kind === "module"
            ? SymbolKind.Module
            : item.kind === "test"
              ? SymbolKind.Event
              : item.kind === "graphical"
                ? SymbolKind.Interface
                : SymbolKind.Operator;
      const selectionSpan = item.nameSpan;
      symbols.push({
        name,
        kind,
        location: Location.create(analyzed.uri, spanToRange(document, selectionSpan)),
      });
    }
  }

  return symbols;
}

function colorFromHex(value: string): Color {
  return {
    red: Number.parseInt(value.slice(1, 3), 16) / 255,
    green: Number.parseInt(value.slice(3, 5), 16) / 255,
    blue: Number.parseInt(value.slice(5, 7), 16) / 255,
    alpha: 1,
  };
}

function hexFromColor(color: Color): string {
  const toHex = (part: number): string =>
    Math.max(0, Math.min(255, Math.round(part * 255)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();

  return `#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}`;
}

function documentColors(uri: string): ColorInformation[] {
  const analyzed = getAnalyzedDocument(uri);
  const document = getTextDocument(uri);
  if (!analyzed || !document) {
    return [];
  }

  return analyzed.parsed.colors.map((color: ColorToken) => ({
    range: spanToRange(document, color.span),
    color: colorFromHex(color.value),
  }));
}

async function walkDirectory(root: string, output: string[]): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "out") {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(fullPath, output);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ncg")) {
      output.push(fullPath);
    }
  }
}

async function loadWorkspaceTexts(): Promise<Map<string, string>> {
  const texts = new Map<string, string>();

  for (const folder of workspaceFolders) {
    const files: string[] = [];
    await walkDirectory(folder, files);
    for (const filePath of files) {
      try {
        texts.set(pathToFileURL(filePath).toString(), await fs.readFile(filePath, "utf8"));
      } catch {
        continue;
      }
    }
  }

  for (const document of documents.all()) {
    texts.set(document.uri, document.getText());
  }

  return texts;
}

async function rebuildAnalysis(): Promise<void> {
  const texts = await loadWorkspaceTexts();
  analysisDocuments = new Map(
    Array.from(texts.entries()).map(([uri, text]) => {
      const openDocument = documents.get(uri);
      const version = openDocument?.version ?? 0;
      return [uri, TextDocument.create(uri, "ncg", version, text)];
    }),
  );

  const parsedDocuments = Array.from(analysisDocuments.values()).map((document) =>
    parseNcgDocument(document.uri, document.getText()),
  );
  workspaceAnalysis = buildWorkspaceAnalysis(parsedDocuments);

  const nextUris = new Set<string>();
  for (const [uri, document] of analysisDocuments.entries()) {
    const analyzed = workspaceAnalysis.documents.get(uri);
    const diagnostics = analyzed
      ? analyzed.diagnostics.map((entry) => toDiagnostic(document, entry))
      : [];
    connection.sendDiagnostics({ uri, diagnostics });
    nextUris.add(uri);
  }

  for (const uri of publishedDiagnosticUris) {
    if (!nextUris.has(uri)) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }
  publishedDiagnosticUris = nextUris;
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const folderUris =
    params.workspaceFolders?.map((folder) => folder.uri) ??
    (params.rootUri ? [params.rootUri] : []);

  workspaceFolders = folderUris
    .map((uri) => {
      try {
        return fileURLToPath(uri);
      } catch {
        return undefined;
      }
    })
    .filter((folder): folder is string => folder !== undefined);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [":", "=", "<", " "],
      },
      signatureHelpProvider: {
        triggerCharacters: [" ", ","],
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      colorProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  await rebuildAnalysis();
});

documents.onDidOpen(async () => {
  await rebuildAnalysis();
});

documents.onDidChangeContent(async () => {
  await rebuildAnalysis();
});

documents.onDidClose(async () => {
  await rebuildAnalysis();
});

connection.onDidChangeWatchedFiles(async () => {
  await rebuildAnalysis();
});

connection.onCompletion((params) => {
  const document = getTextDocument(params.textDocument.uri);
  const analyzed = getAnalyzedDocument(params.textDocument.uri);
  if (!document || !analyzed) {
    return buildKeywordItems();
  }

  const offset = document.offsetAt(params.position);
  const scope = findScopeAtOffset(analyzed, offset);
  const callableItems = buildCallableCompletionItems(params.textDocument.uri);

  if (!scope) {
    return [...buildKeywordItems(), ...callableItems];
  }

  if (isCallableContext(document, params.position)) {
    return callableItems;
  }

  return [...buildLocalCompletionItems(scope), ...callableItems];
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const analyzed = getAnalyzedDocument(params.textDocument.uri);
  const document = getTextDocument(params.textDocument.uri);
  if (!analyzed || !document) {
    return null;
  }

  const offset = document.offsetAt(params.position);
  const scope = findScopeAtOffset(analyzed, offset);
  const resolution = scope?.callResolutions.find(
    (entry) =>
      offset >= entry.statement.calleeSpan.start && offset <= entry.statement.span.end,
  );
  const callable = resolution?.resolved ?? resolution?.candidates[0];
  if (!resolution || !callable) {
    return null;
  }

  let activeParameter = 0;
  for (const arg of resolution.statement.args) {
    if (offset > arg.span.end) {
      activeParameter += 1;
      continue;
    }
    if (offset >= arg.span.start) {
      break;
    }
  }

  activeParameter = Math.min(
    activeParameter,
    Math.max(callable.params.length - 1, 0),
  );

  return {
    signatures: [buildSignatureInformation(callable)],
    activeSignature: 0,
    activeParameter,
  };
});

connection.onHover((params): Hover | null => {
  const resolved = resolvedOccurrenceAt(params);
  if (!resolved) {
    return null;
  }

  if (resolved.occurrence) {
    const callable = workspaceAnalysis.callableById.get(resolved.occurrence.symbolId);
    if (callable) {
      return hoverForCallable(callable);
    }
    const local = findLocalSymbol(resolved.analyzed, resolved.occurrence.symbolId);
    if (local) {
      return hoverForLocal(local);
    }
  }

  const token = getTokenAtOffset(resolved.document.getText(), resolved.offset);
  if (!token) {
    return null;
  }
  const callable = (workspaceAnalysis.callableByName.get(token.text) ?? [])[0];
  return callable ? hoverForCallable(callable) : null;
});

connection.onDefinition((params): Definition | null => {
  const resolved = resolvedOccurrenceAt(params);
  if (!resolved) {
    return null;
  }

  if (resolved.occurrence) {
    const locations = definitionLocations(resolved.occurrence.symbolId);
    if (locations.length > 0) {
      return locations;
    }
  }

  const token = getTokenAtOffset(resolved.document.getText(), resolved.offset);
  if (!token) {
    return null;
  }

  const locations = (workspaceAnalysis.callableByName.get(token.text) ?? []).flatMap(
    (callable) => {
      const document = getTextDocument(callable.uri);
      if (!document) {
        return [];
      }
      return [Location.create(callable.uri, spanToRange(document, callable.span))];
    },
  );
  return locations.length > 0 ? locations : null;
});

connection.onReferences((params: ReferenceParams): Location[] => {
  const resolved = resolvedOccurrenceAt(params);
  if (!resolved?.occurrence) {
    return [];
  }
  return referenceLocations(
    resolved.occurrence.symbolId,
    params.context.includeDeclaration,
  );
});

connection.onPrepareRename((params) => {
  const resolved = resolvedOccurrenceAt(params);
  if (!resolved?.occurrence) {
    return null;
  }
  return spanToRange(resolved.document, resolved.occurrence.span);
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const resolved = resolvedOccurrenceAt(params);
  if (!resolved?.occurrence) {
    return null;
  }

  const changes: Record<string, Array<{ range: Range; newText: string }>> = {};
  for (const occurrence of workspaceAnalysis.occurrencesBySymbol.get(resolved.occurrence.symbolId) ?? []) {
    const document = getTextDocument(occurrence.uri);
    if (!document) {
      continue;
    }
    const edits = changes[occurrence.uri] ?? [];
    edits.push({
      range: spanToRange(document, occurrence.span),
      newText: params.newName,
    });
    changes[occurrence.uri] = edits;
  }

  return { changes };
});

connection.onDocumentSymbol((params): DocumentSymbol[] =>
  documentSymbols(params.textDocument.uri),
);

connection.onWorkspaceSymbol((params): SymbolInformation[] =>
  workspaceSymbols(params.query),
);

connection.onDocumentHighlight((params): DocumentHighlight[] => {
  const resolved = resolvedOccurrenceAt(params);
  if (!resolved?.occurrence) {
    return [];
  }

  return (workspaceAnalysis.occurrencesBySymbol.get(resolved.occurrence.symbolId) ?? [])
    .filter((occurrence) => occurrence.uri === params.textDocument.uri)
    .map((occurrence) => ({
      range: spanToRange(resolved.document, occurrence.span),
      kind:
        occurrence.role === "write"
          ? DocumentHighlightKind.Write
          : occurrence.role === "definition"
            ? DocumentHighlightKind.Text
            : DocumentHighlightKind.Read,
    }));
});

connection.onFoldingRanges((params): FoldingRange[] => {
  const analyzed = getAnalyzedDocument(params.textDocument.uri);
  const document = getTextDocument(params.textDocument.uri);
  if (!analyzed || !document) {
    return [];
  }

  return analyzed.parsed.items
    .map((item) => {
      const startLine = document.positionAt(item.span.start).line;
      const endLine = document.positionAt(item.span.end).line;
      if (endLine <= startLine) {
        return undefined;
      }
      return FoldingRange.create(
        startLine,
        endLine,
        undefined,
        undefined,
        FoldingRangeKind.Region,
      );
    })
    .filter((range): range is FoldingRange => range !== undefined);
});

connection.onDocumentColor((params): ColorInformation[] =>
  documentColors(params.textDocument.uri),
);

connection.onColorPresentation((params): ColorPresentation[] => {
  const hex = hexFromColor(params.color);
  return [
    {
      label: hex,
      textEdit: {
        range: params.range,
        newText: hex,
      },
    },
  ];
});

documents.listen(connection);
connection.listen();
