export type Severity = "error" | "warning" | "info";

export interface Span {
  start: number;
  end: number;
}

export interface DiagnosticLike {
  code: string;
  message: string;
  severity: Severity;
  span: Span;
  source: "parser" | "semantic";
}

export interface PortSpec {
  name: string;
  width?: number;
  span: Span;
}

export interface ArgSlice {
  start: number;
  end?: number;
  separator?: "," | ":" | "-";
}

export interface ArgExpression {
  text: string;
  baseName: string;
  slice?: ArgSlice;
  span: Span;
}

export interface CallStatement {
  kind: "statement";
  span: Span;
  operator: ":" | "=";
  lhs: PortSpec[];
  callee: string;
  calleeSpan: Span;
  args: ArgExpression[];
  arrowSpan?: Span;
  raw: string;
}

export interface DefinitionBlock {
  kind: "func" | "module";
  name: string;
  nameSpan: Span;
  params: PortSpec[];
  outputs: PortSpec[];
  headerSpan: Span;
  bodySpan: Span;
  span: Span;
  statements: CallStatement[];
  diagnostics: DiagnosticLike[];
}

export interface UsingDirective {
  kind: "using";
  name: string;
  nameSpan: Span;
  inputs: number;
  outputs: number;
  span: Span;
}

export interface TestCase {
  span: Span;
  inputs: string[];
  outputs: string[];
}

export interface TestBlock {
  kind: "test";
  name: string;
  nameSpan: Span;
  inputs: number;
  outputs: number;
  bodySpan: Span;
  span: Span;
  cases: TestCase[];
  diagnostics: DiagnosticLike[];
}

export interface ColorToken {
  value: string;
  span: Span;
}

export interface GraphicalEntry {
  span: Span;
  x: number;
  y: number;
  target: string;
  targetSpan: Span;
  colors: ColorToken[];
}

export interface GraphicalBlock {
  kind: "graphical";
  name: string;
  nameSpan: Span;
  width: number;
  height: number;
  bodySpan: Span;
  span: Span;
  entries: GraphicalEntry[];
  diagnostics: DiagnosticLike[];
}

export type TopLevelItem =
  | UsingDirective
  | DefinitionBlock
  | TestBlock
  | GraphicalBlock;

export interface ParsedDocument {
  uri: string;
  text: string;
  items: TopLevelItem[];
  usings: UsingDirective[];
  definitions: DefinitionBlock[];
  tests: TestBlock[];
  graphicals: GraphicalBlock[];
  colors: ColorToken[];
  diagnostics: DiagnosticLike[];
}

export interface CallableSymbol {
  id: string;
  kind: "using" | "func" | "module";
  name: string;
  uri: string;
  span: Span;
  params: PortSpec[];
  outputs: PortSpec[];
}

export interface LocalSymbol {
  id: string;
  uri: string;
  definitionId: string;
  definitionName: string;
  name: string;
  kind: "param" | "output" | "local";
  width?: number;
  span: Span;
}

export interface SymbolOccurrence {
  symbolId: string;
  uri: string;
  name: string;
  span: Span;
  role: "definition" | "reference" | "write";
}

export interface CallResolution {
  statement: CallStatement;
  candidates: CallableSymbol[];
  resolved?: CallableSymbol;
  ambiguous: boolean;
}

export interface DefinitionScope {
  definition: DefinitionBlock;
  definitionId: string;
  symbols: Map<string, LocalSymbol>;
  writes: Map<string, Span[]>;
  callResolutions: CallResolution[];
}

export interface AnalyzedDocument {
  uri: string;
  parsed: ParsedDocument;
  diagnostics: DiagnosticLike[];
  scopes: DefinitionScope[];
  occurrences: SymbolOccurrence[];
}

export interface WorkspaceAnalysis {
  documents: Map<string, AnalyzedDocument>;
  callableByName: Map<string, CallableSymbol[]>;
  callableById: Map<string, CallableSymbol>;
  occurrencesBySymbol: Map<string, SymbolOccurrence[]>;
}
