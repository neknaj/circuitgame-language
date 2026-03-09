import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(
    path.join("out", "server", "server.js"),
  );

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ["--nolazy", "--inspect=6010"],
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "ncg" },
      { scheme: "untitled", language: "ncg" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.ncg"),
    },
  };

  client = new LanguageClient(
    "ncgLanguageServer",
    "NCG Language Server",
    serverOptions,
    clientOptions,
  );

  void client.start();
  context.subscriptions.push({
    dispose: () => {
      void client?.stop();
    },
  });
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
  }
}
