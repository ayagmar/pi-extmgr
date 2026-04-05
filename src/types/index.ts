/**
 * Core types and interfaces for pi-extmgr
 */

export type Scope = "global" | "project";
export type State = "enabled" | "disabled";

export interface ExtensionEntry {
  id: string;
  scope: Scope;
  state: State;
  activePath: string;
  disabledPath: string;
  displayName: string;
  summary: string;
}

export interface NpmPackage {
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
  keywords?: string[] | undefined;
  date?: string | undefined;
  size?: number | undefined; // Package size in bytes
}

export interface InstalledPackage {
  source: string;
  name: string;
  version?: string | undefined;
  scope: "global" | "project";
  resolvedPath?: string | undefined;
  description?: string | undefined;
  size?: number | undefined; // Package size in bytes
}

export interface PackageExtensionEntry {
  id: string;
  packageSource: string;
  packageName: string;
  packageScope: Scope;
  extensionPath: string;
  absolutePath: string;
  displayName: string;
  summary: string;
  state: State;
}

export interface LocalUnifiedItem {
  type: "local";
  id: string;
  displayName: string;
  summary: string;
  scope: Scope;
  state: State;
  activePath: string;
  disabledPath: string;
  originalState: State;
}

export interface PackageUnifiedItem {
  type: "package";
  id: string;
  displayName: string;
  scope: Scope;
  source: string;
  version?: string | undefined;
  description?: string | undefined;
  size?: number | undefined; // Package size in bytes
  updateAvailable?: boolean | undefined;
}

export type UnifiedItem = LocalUnifiedItem | PackageUnifiedItem;

export interface SearchCache {
  query: string;
  results: NpmPackage[];
  timestamp: number;
}

// Action types for unified view
export type UnifiedAction =
  | { type: "cancel" }
  | { type: "apply" }
  | { type: "remote" }
  | { type: "help" }
  | { type: "menu" }
  | { type: "quick"; action: "install" | "search" | "update-all" | "auto-update" }
  | {
      type: "action";
      itemId: string;
      action?: "menu" | "update" | "remove" | "details" | "configure";
    };

export type BrowseAction =
  | { type: "package"; name: string }
  | { type: "prev" }
  | { type: "next" }
  | { type: "refresh" }
  | { type: "search"; query: string }
  | { type: "install" }
  | { type: "menu" }
  | { type: "cancel" };
