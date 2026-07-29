import * as vscode from 'vscode';
import type { Diagnostic, DiagnosticsPort, Unsubscribe } from '@tars/core';

function toSeverity(severity: vscode.DiagnosticSeverity): Diagnostic['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
  }
}

function toDiagnostic(path: string, diagnostic: vscode.Diagnostic): Diagnostic {
  const base = {
    path,
    // The vscode Position is 0-based; every user-facing surface is 1-based.
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity: toSeverity(diagnostic.severity),
    message: diagnostic.message,
  };
  return diagnostic.source === undefined ? base : { ...base, source: diagnostic.source };
}

export class VscodeDiagnostics implements DiagnosticsPort {
  all(path?: string): readonly Diagnostic[] {
    if (path !== undefined) {
      const uri = vscode.Uri.file(path);
      return vscode.languages
        .getDiagnostics(uri)
        .map((diagnostic) => toDiagnostic(uri.fsPath, diagnostic));
    }
    return vscode.languages
      .getDiagnostics()
      .flatMap(([uri, diagnostics]) =>
        diagnostics.map((diagnostic) => toDiagnostic(uri.fsPath, diagnostic)),
      );
  }

  onDidChange(listener: (paths: readonly string[]) => void): Unsubscribe {
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      listener(event.uris.map((uri) => uri.fsPath));
    });
    return () => {
      subscription.dispose();
    };
  }
}
