Ask a configured language server about a file. Operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`.

Pass `filePath`, `line` and `character` (both 1-based, as an editor shows them). `workspaceSymbol` also takes `query` (empty lists every symbol) and uses `filePath` only to choose which server to start. If no server is configured for the file, the tool returns an error.
