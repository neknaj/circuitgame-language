import {
  AnalyzedDocument,
  CallableSymbol,
  CallResolution,
  DefinitionBlock,
  DefinitionScope,
  DiagnosticLike,
  LocalSymbol,
  ParsedDocument,
  PortSpec,
  Span,
  SymbolOccurrence,
  WorkspaceAnalysis,
} from "./types";

function diag(
  code: string,
  message: string,
  span: Span,
  severity: "error" | "warning" | "info" = "error",
): DiagnosticLike {
  return { code, message, severity, span, source: "semantic" };
}

function syntheticPorts(
  count: number,
  prefix: "in" | "out",
  span: Span,
): PortSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}${index + 1}`,
    span,
  }));
}

function callableId(uri: string, kind: string, name: string, start: number): string {
  return `${kind}:${uri}:${name}:${start}`;
}

function localId(
  uri: string,
  definitionName: string,
  name: string,
  start: number,
): string {
  return `local:${uri}:${definitionName}:${name}:${start}`;
}

function resolveCallableCandidates(
  callableByName: Map<string, CallableSymbol[]>,
  name: string,
  currentUri: string,
): { candidates: CallableSymbol[]; resolved?: CallableSymbol; ambiguous: boolean } {
  const allCandidates = callableByName.get(name) ?? [];
  const sameFile = allCandidates.filter((candidate) => candidate.uri === currentUri);
  if (sameFile.length === 1) {
    return { candidates: sameFile, resolved: sameFile[0], ambiguous: false };
  }
  if (sameFile.length > 1) {
    return { candidates: sameFile, ambiguous: true };
  }
  if (allCandidates.length === 1) {
    return { candidates: allCandidates, resolved: allCandidates[0], ambiguous: false };
  }
  return { candidates: allCandidates, ambiguous: allCandidates.length > 1 };
}

function widthCompatible(port: PortSpec, symbol: LocalSymbol): boolean {
  return port.width === undefined || symbol.width === undefined || port.width === symbol.width;
}

function portWidth(port: PortSpec): number {
  return port.width ?? 1;
}

function sliceWidth(slice: { start: number; end?: number }): number {
  if (slice.end === undefined) {
    return 1;
  }
  return Math.abs(slice.end - slice.start) + 1;
}

function validateSlice(
  name: string,
  symbol: LocalSymbol,
  slice: { start: number; end?: number },
  diagnostics: DiagnosticLike[],
  span: Span,
): void {
  if (symbol.width === undefined) {
    return;
  }

  const lastIndex = slice.end ?? slice.start;
  if (slice.start >= symbol.width || lastIndex >= symbol.width) {
    diagnostics.push(
      diag(
        "slice-range",
        `Slice on \`${name}\` exceeds declared width ${symbol.width}.`,
        span,
      ),
    );
  }
  if (slice.end !== undefined && slice.end < slice.start) {
    diagnostics.push(
      diag(
        "slice-order",
        `Slice on \`${name}\` has end before start.`,
        span,
      ),
    );
  }
}

function createCallableSymbols(document: ParsedDocument): CallableSymbol[] {
  const callables: CallableSymbol[] = [];

  for (const using of document.usings) {
    callables.push({
      id: callableId(document.uri, using.kind, using.name, using.nameSpan.start),
      kind: "using",
      name: using.name,
      uri: document.uri,
      span: using.nameSpan,
      params: syntheticPorts(using.inputs, "in", using.nameSpan),
      outputs: syntheticPorts(using.outputs, "out", using.nameSpan),
    });
  }

  for (const definition of document.definitions) {
    const inferredOutputs = definition.outputs.map((output) => {
      if (output.width !== undefined) {
        return output;
      }

      const paramAlias = definition.params.find((param) => param.name === output.name);
      if (paramAlias?.width !== undefined) {
        return { ...output, width: paramAlias.width };
      }

      const writtenOutput = definition.statements
        .flatMap((statement) => statement.lhs)
        .find((port) => port.name === output.name && port.width !== undefined);
      if (writtenOutput?.width !== undefined) {
        return { ...output, width: writtenOutput.width };
      }

      return output;
    });

    callables.push({
      id: callableId(document.uri, definition.kind, definition.name, definition.nameSpan.start),
      kind: definition.kind,
      name: definition.name,
      uri: document.uri,
      span: definition.nameSpan,
      params: definition.params,
      outputs: inferredOutputs,
    });
  }

  return callables;
}

function analyzeDefinition(
  parsed: ParsedDocument,
  definition: DefinitionBlock,
  callableByName: Map<string, CallableSymbol[]>,
): { scope: DefinitionScope; occurrences: SymbolOccurrence[]; diagnostics: DiagnosticLike[] } {
  const diagnostics: DiagnosticLike[] = [];
  const occurrences: SymbolOccurrence[] = [];
  const definitionId = callableId(
    parsed.uri,
    definition.kind,
    definition.name,
    definition.nameSpan.start,
  );
  const scope: DefinitionScope = {
    definition,
    definitionId,
    symbols: new Map<string, LocalSymbol>(),
    writes: new Map<string, Span[]>(),
    callResolutions: [],
  };

  const declare = (
    port: PortSpec,
    kind: "param" | "output" | "local",
  ): LocalSymbol | undefined => {
    const existing = scope.symbols.get(port.name);
    if (existing) {
      if (existing.width === undefined && port.width !== undefined) {
        existing.width = port.width;
      }
      if ((kind === "param" || kind === "output") && existing.kind === kind) {
        diagnostics.push(
          diag(
            "symbol-duplicate",
            `Duplicate symbol \`${port.name}\` in definition header.`,
            port.span,
          ),
        );
      } else if (kind === "local" && !widthCompatible(port, existing)) {
        diagnostics.push(
          diag(
            "symbol-width-conflict",
            `Signal \`${port.name}\` is assigned with inconsistent widths.`,
            port.span,
            "warning",
          ),
        );
      }
      return existing;
    }

    const symbol: LocalSymbol = {
      id: localId(parsed.uri, definition.name, port.name, port.span.start),
      uri: parsed.uri,
      definitionId,
      definitionName: definition.name,
      name: port.name,
      kind,
      width: port.width,
      span: port.span,
    };
    scope.symbols.set(port.name, symbol);
    occurrences.push({
      symbolId: symbol.id,
      uri: parsed.uri,
      name: symbol.name,
      span: symbol.span,
      role: "definition",
    });
    return symbol;
  };

  for (const param of definition.params) {
    declare(param, "param");
  }
  for (const output of definition.outputs) {
    declare(output, "output");
  }
  for (const statement of definition.statements) {
    for (const lhs of statement.lhs) {
      declare(lhs, "local");
    }
  }

  for (const statement of definition.statements) {
    const resolution = resolveCallableCandidates(
      callableByName,
      statement.callee,
      parsed.uri,
    );

    const callResolution: CallResolution = {
      statement,
      candidates: resolution.candidates,
      resolved: resolution.resolved,
      ambiguous: resolution.ambiguous,
    };
    scope.callResolutions.push(callResolution);

    if (resolution.resolved) {
      occurrences.push({
        symbolId: resolution.resolved.id,
        uri: parsed.uri,
        name: statement.callee,
        span: statement.calleeSpan,
        role: "reference",
      });
    } else if (resolution.candidates.length === 0) {
      diagnostics.push(
        diag(
          "call-unknown",
          `Unknown callable \`${statement.callee}\`.`,
          statement.calleeSpan,
        ),
      );
    }

    if (resolution.resolved) {
      const expectedInputWidth = resolution.resolved.params.reduce(
        (sum, port) => sum + portWidth(port),
        0,
      );
      const actualInputWidth = statement.args.reduce((sum, arg) => {
        const symbol = scope.symbols.get(arg.baseName);
        if (arg.slice) {
          return sum + sliceWidth(arg.slice);
        }
        return sum + (symbol?.width ?? 1);
      }, 0);
      const expectedOutputWidth = resolution.resolved.outputs.reduce(
        (sum, port) => sum + portWidth(port),
        0,
      );
      const actualOutputWidth = statement.lhs.reduce(
        (sum, port) => sum + portWidth(port),
        0,
      );

      if (actualInputWidth !== expectedInputWidth) {
        diagnostics.push(
          diag(
            "call-arity-input",
            `\`${statement.callee}\` expects ${expectedInputWidth} input wire(s), got ${actualInputWidth}.`,
            statement.calleeSpan,
          ),
        );
      }
      if (actualOutputWidth !== expectedOutputWidth) {
        diagnostics.push(
          diag(
            "call-arity-output",
            `\`${statement.callee}\` returns ${expectedOutputWidth} output wire(s), but ${actualOutputWidth} target wire(s) were provided.`,
            statement.span,
          ),
        );
      }
    }

    for (const lhs of statement.lhs) {
      const symbol = scope.symbols.get(lhs.name);
      if (!symbol) {
        continue;
      }
      const writes = scope.writes.get(symbol.id) ?? [];
      writes.push(lhs.span);
      scope.writes.set(symbol.id, writes);
      occurrences.push({
        symbolId: symbol.id,
        uri: parsed.uri,
        name: lhs.name,
        span: lhs.span,
        role: "write",
      });
    }

    for (const arg of statement.args) {
      const symbol = scope.symbols.get(arg.baseName);
      if (!symbol) {
        diagnostics.push(
          diag(
            "signal-unknown",
            `Unknown signal \`${arg.baseName}\` in \`${definition.name}\`.`,
            arg.span,
          ),
        );
        continue;
      }
      if (arg.slice) {
        validateSlice(arg.baseName, symbol, arg.slice, diagnostics, arg.span);
      }
      occurrences.push({
        symbolId: symbol.id,
        uri: parsed.uri,
        name: arg.baseName,
        span: arg.span,
        role: "reference",
      });
    }
  }

  for (const [symbolId, writes] of scope.writes) {
    const symbol = Array.from(scope.symbols.values()).find((entry) => entry.id === symbolId);
    if (writes.length > 1) {
      diagnostics.push(
        diag(
          "signal-multiwrite",
          `Signal \`${symbol?.name ?? "unknown"}\` is assigned ${writes.length} times in \`${definition.name}\`.`,
          writes[1],
          "warning",
        ),
      );
    }
  }

  for (const symbol of scope.symbols.values()) {
    const writes = scope.writes.get(symbol.id) ?? [];
    if (symbol.kind === "output" && writes.length === 0) {
      diagnostics.push(
        diag(
          "output-unassigned",
          `Output \`${symbol.name}\` is never assigned.`,
          symbol.span,
          "warning",
        ),
      );
    }
  }

  return { scope, occurrences, diagnostics };
}

function analyzeTestsAndGraphicals(
  parsed: ParsedDocument,
  callableByName: Map<string, CallableSymbol[]>,
): { diagnostics: DiagnosticLike[]; occurrences: SymbolOccurrence[] } {
  const diagnostics: DiagnosticLike[] = [];
  const occurrences: SymbolOccurrence[] = [];

  for (const test of parsed.tests) {
    const resolution = resolveCallableCandidates(callableByName, test.name, parsed.uri);
    if (resolution.resolved) {
      occurrences.push({
        symbolId: resolution.resolved.id,
        uri: parsed.uri,
        name: test.name,
        span: test.nameSpan,
        role: "reference",
      });
      if (test.inputs !== resolution.resolved.params.length) {
        diagnostics.push(
          diag(
            "test-input-count",
            `Test \`${test.name}\` declares ${test.inputs} inputs, but callable expects ${resolution.resolved.params.length}.`,
            test.nameSpan,
          ),
        );
      }
      if (test.outputs !== resolution.resolved.outputs.length) {
        diagnostics.push(
          diag(
            "test-output-count",
            `Test \`${test.name}\` declares ${test.outputs} outputs, but callable expects ${resolution.resolved.outputs.length}.`,
            test.nameSpan,
          ),
        );
      }
    } else {
      diagnostics.push(
        diag(
          "test-target",
          `Unknown test target \`${test.name}\`.`,
          test.nameSpan,
          resolution.candidates.length > 0 ? "warning" : "error",
        ),
      );
    }

    for (const testCase of test.cases) {
      if (testCase.inputs.length !== test.inputs) {
        diagnostics.push(
          diag(
            "test-case-inputs",
            `Expected ${test.inputs} input bit(s), got ${testCase.inputs.length}.`,
            testCase.span,
          ),
        );
      }
      if (testCase.outputs.length !== test.outputs) {
        diagnostics.push(
          diag(
            "test-case-outputs",
            `Expected ${test.outputs} output bit(s), got ${testCase.outputs.length}.`,
            testCase.span,
          ),
        );
      }
    }
  }

  for (const graphical of parsed.graphicals) {
    const resolution = resolveCallableCandidates(callableByName, graphical.name, parsed.uri);
    if (resolution.resolved) {
      occurrences.push({
        symbolId: resolution.resolved.id,
        uri: parsed.uri,
        name: graphical.name,
        span: graphical.nameSpan,
        role: "reference",
      });
    }

    for (const entry of graphical.entries) {
      if (entry.x >= graphical.width || entry.y >= graphical.height) {
        diagnostics.push(
          diag(
            "graphical-bounds",
            `Graphical point (${entry.x}, ${entry.y}) is outside ${graphical.width}x${graphical.height}.`,
            entry.span,
          ),
        );
      }
    }
  }

  return { diagnostics, occurrences };
}

export function buildWorkspaceAnalysis(
  parsedDocuments: ParsedDocument[],
): WorkspaceAnalysis {
  const documents = new Map<string, AnalyzedDocument>();
  const callableByName = new Map<string, CallableSymbol[]>();
  const callableById = new Map<string, CallableSymbol>();

  for (const parsed of parsedDocuments) {
    for (const callable of createCallableSymbols(parsed)) {
      const list = callableByName.get(callable.name) ?? [];
      list.push(callable);
      callableByName.set(callable.name, list);
      callableById.set(callable.id, callable);
    }
  }

  for (const parsed of parsedDocuments) {
    const diagnostics: DiagnosticLike[] = [...parsed.diagnostics];
    const occurrences: SymbolOccurrence[] = [];
    const scopes: DefinitionScope[] = [];

    for (const callable of createCallableSymbols(parsed)) {
      occurrences.push({
        symbolId: callable.id,
        uri: parsed.uri,
        name: callable.name,
        span: callable.span,
        role: "definition",
      });
    }

    for (const definition of parsed.definitions) {
      const analyzed = analyzeDefinition(parsed, definition, callableByName);
      scopes.push(analyzed.scope);
      diagnostics.push(...analyzed.diagnostics);
      occurrences.push(...analyzed.occurrences);
    }

    const blockAnalysis = analyzeTestsAndGraphicals(parsed, callableByName);
    diagnostics.push(...blockAnalysis.diagnostics);
    occurrences.push(...blockAnalysis.occurrences);

    documents.set(parsed.uri, {
      uri: parsed.uri,
      parsed,
      diagnostics,
      scopes,
      occurrences,
    });
  }

  const occurrencesBySymbol = new Map<string, SymbolOccurrence[]>();
  for (const document of documents.values()) {
    for (const occurrence of document.occurrences) {
      const list = occurrencesBySymbol.get(occurrence.symbolId) ?? [];
      list.push(occurrence);
      occurrencesBySymbol.set(occurrence.symbolId, list);
    }
  }

  return {
    documents,
    callableByName,
    callableById,
    occurrencesBySymbol,
  };
}

export function formatPort(port: PortSpec): string {
  return port.width === undefined ? port.name : `${port.name}(${port.width})`;
}

export function formatCallableSignature(callable: CallableSymbol): string {
  const params = callable.params.map(formatPort).join(" ");
  const outputs = callable.outputs.map(formatPort).join(" ");
  if (callable.kind === "using") {
    return `${callable.name}:${callable.params.length}->${callable.outputs.length}`;
  }
  return `${callable.kind} ${callable.name} (${params})->(${outputs})`;
}

export function spanContains(span: Span, offset: number): boolean {
  return offset >= span.start && offset <= span.end;
}

export function findOccurrenceAtOffset(
  analyzed: AnalyzedDocument,
  offset: number,
): SymbolOccurrence | undefined {
  return analyzed.occurrences.find((occurrence) => spanContains(occurrence.span, offset));
}

export function findScopeAtOffset(
  analyzed: AnalyzedDocument,
  offset: number,
): DefinitionScope | undefined {
  return analyzed.scopes.find((scope) => spanContains(scope.definition.span, offset));
}
