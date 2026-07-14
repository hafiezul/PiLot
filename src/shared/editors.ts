export const editorDefinitions = [
  { id: "cursor", label: "Cursor", commands: ["cursor"], macApplications: ["Cursor"], windowsPaths: ["%LOCALAPPDATA%/Programs/cursor/Cursor.exe", "%ProgramFiles%/Cursor/Cursor.exe"] },
  { id: "trae", label: "Trae", commands: ["trae"], macApplications: ["Trae"], windowsPaths: ["%LOCALAPPDATA%/Programs/Trae/Trae.exe", "%ProgramFiles%/Trae/Trae.exe"] },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], macApplications: ["Kiro"], windowsPaths: ["%LOCALAPPDATA%/Programs/Kiro/Kiro.exe", "%ProgramFiles%/Kiro/Kiro.exe"] },
  { id: "vscode", label: "VS Code", commands: ["code"], macApplications: ["Visual Studio Code"], windowsPaths: ["%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe", "%ProgramFiles%/Microsoft VS Code/Code.exe"] },
  { id: "vscode-insiders", label: "VS Code Insiders", commands: ["code-insiders"], macApplications: ["Visual Studio Code - Insiders"], windowsPaths: ["%LOCALAPPDATA%/Programs/Microsoft VS Code Insiders/Code - Insiders.exe", "%ProgramFiles%/Microsoft VS Code Insiders/Code - Insiders.exe"] },
  { id: "vscodium", label: "VSCodium", commands: ["codium"], macApplications: ["VSCodium"], windowsPaths: ["%LOCALAPPDATA%/Programs/VSCodium/VSCodium.exe", "%ProgramFiles%/VSCodium/VSCodium.exe"] },
  { id: "zed", label: "Zed", commands: ["zed", "zeditor"], macApplications: ["Zed"], windowsPaths: ["%LOCALAPPDATA%/Programs/Zed/Zed.exe", "%ProgramFiles%/Zed/Zed.exe"] },
  { id: "antigravity", label: "Antigravity", commands: ["agy"], macApplications: ["Antigravity"], windowsPaths: ["%LOCALAPPDATA%/Programs/Antigravity/Antigravity.exe", "%ProgramFiles%/Antigravity/Antigravity.exe"] },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], macApplications: ["IntelliJ IDEA", "IntelliJ IDEA CE"], windowsDirectory: "IntelliJ IDEA", windowsExecutable: "idea64.exe" },
  { id: "aqua", label: "Aqua", commands: ["aqua"], macApplications: ["Aqua"], windowsDirectory: "Aqua", windowsExecutable: "aqua64.exe" },
  { id: "clion", label: "CLion", commands: ["clion"], macApplications: ["CLion"], windowsDirectory: "CLion", windowsExecutable: "clion64.exe" },
  { id: "datagrip", label: "DataGrip", commands: ["datagrip"], macApplications: ["DataGrip"], windowsDirectory: "DataGrip", windowsExecutable: "datagrip64.exe" },
  { id: "dataspell", label: "DataSpell", commands: ["dataspell"], macApplications: ["DataSpell"], windowsDirectory: "DataSpell", windowsExecutable: "dataspell64.exe" },
  { id: "goland", label: "GoLand", commands: ["goland"], macApplications: ["GoLand"], windowsDirectory: "GoLand", windowsExecutable: "goland64.exe" },
  { id: "phpstorm", label: "PhpStorm", commands: ["phpstorm"], macApplications: ["PhpStorm"], windowsDirectory: "PhpStorm", windowsExecutable: "phpstorm64.exe" },
  { id: "pycharm", label: "PyCharm", commands: ["pycharm"], macApplications: ["PyCharm"], windowsDirectory: "PyCharm", windowsExecutable: "pycharm64.exe" },
  { id: "rider", label: "Rider", commands: ["rider"], macApplications: ["Rider"], windowsDirectory: "Rider", windowsExecutable: "rider64.exe" },
  { id: "rubymine", label: "RubyMine", commands: ["rubymine"], macApplications: ["RubyMine"], windowsDirectory: "RubyMine", windowsExecutable: "rubymine64.exe" },
  { id: "rustrover", label: "RustRover", commands: ["rustrover"], macApplications: ["RustRover"], windowsDirectory: "RustRover", windowsExecutable: "rustrover64.exe" },
  { id: "webstorm", label: "WebStorm", commands: ["webstorm"], macApplications: ["WebStorm"], windowsDirectory: "WebStorm", windowsExecutable: "webstorm64.exe" },
] as const;

export const configuredEditorId = "configured" as const;
export const fileManagerId = "file-manager" as const;
export type ApplicationId = typeof editorDefinitions[number]["id"] | typeof configuredEditorId | typeof fileManagerId;
export const applicationIds = new Set<ApplicationId>([...editorDefinitions.map(({ id }) => id), configuredEditorId, fileManagerId]);

export const terminalDefinitions = [
  { id: "system", label: "System default" },
  { id: "iterm", label: "iTerm" },
  { id: "warp", label: "Warp" },
  { id: "ghostty", label: "Ghostty" },
  { id: "windows-terminal", label: "Windows Terminal" },
  { id: "powershell", label: "PowerShell" },
  { id: "gnome-terminal", label: "GNOME Terminal" },
  { id: "konsole", label: "Konsole" },
  { id: "kitty", label: "kitty" },
  { id: "wezterm", label: "WezTerm" },
  { id: "alacritty", label: "Alacritty" },
] as const;
export type TerminalId = typeof terminalDefinitions[number]["id"];
export const terminalIds = new Set<TerminalId>(terminalDefinitions.map(({ id }) => id));
export type TerminalState = {
  available: Array<{ id: TerminalId; label: string }>;
  preferred: TerminalId;
  storedPreferred: TerminalId;
  notice?: string;
};

export type ApplicationState = {
  available: Array<{ id: ApplicationId; label: string; kind: "editor" | "file-manager" }>;
  preferred?: ApplicationId;
  storedPreferred?: ApplicationId;
  notice?: string;
};

export type ApplicationsApi = {
  getApplicationState(projectPath: string, taskPath: string): Promise<ApplicationState>;
  setPreferredApplication(projectPath: string, taskPath: string, application: ApplicationId): Promise<ApplicationState>;
};
