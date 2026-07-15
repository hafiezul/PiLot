export const diagnosticCategories = [
  "auth",
  "settings-lock",
  "preferences",
  "session-compatibility",
  "runtime",
  "shell",
  "packaging",
] as const;

export type DiagnosticCategory = typeof diagnosticCategories[number];
export type DiagnosticSeverity = "info" | "warning" | "error";

export const diagnosticOperations = [
  "app.start", "app.bootstrap", "app.window-load", "app.notification", "app.lifecycle",
  "diagnostics.preview", "diagnostics.export", "diagnostics.export-failed",
  "auth.read", "auth.write", "auth.login",
  "preferences.read", "preferences.write",
  "settings.read", "settings.write",
  "session.compatibility", "session.read", "session.write",
  "runtime.run", "runtime.setup", "runtime.command",
  "shell.capture", "shell.resolve", "shell.launch",
] as const;
export type DiagnosticOperation = typeof diagnosticOperations[number];

export const diagnosticCategoryLabels: Record<DiagnosticCategory, string> = {
  auth: "Authentication",
  "settings-lock": "Settings lock",
  preferences: "Preferences",
  "session-compatibility": "Session compatibility",
  runtime: "Runtime",
  shell: "Shell",
  packaging: "Packaging",
};

export type DiagnosticEvent = {
  timestamp: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  operation: DiagnosticOperation;
  summary: string;
  guidance: string;
  code?: string;
};

export type DiagnosticBundle = {
  format: "pilot-diagnostics";
  version: 1;
  generatedAt: string;
  application: {
    name: "PiLot";
    version: string;
    packaged: boolean;
    platform: string;
    architecture: string;
    electronVersion: string;
    nodeVersion: string;
  };
  privacy: {
    localOnly: true;
    analytics: false;
    automaticCrashUploads: false;
    excludedContent: ["secrets", "Task transcripts", "source content", "file and Project paths", "diff content"];
  };
  events: DiagnosticEvent[];
};

export type DiagnosticsApi = {
  getDiagnosticPreview(): Promise<DiagnosticBundle>;
  exportDiagnosticBundle(): Promise<boolean>;
};
