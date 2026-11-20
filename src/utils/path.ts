import { normalizePath } from "obsidian";
import type { WatchFolderSelection } from "../types";

export function cleanVaultFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed) return "";
  return normalizePath(trimmed).replace(/^\/+|\/+$/g, "");
}

export function isPathInsideFolder(filePath: string, folder: string): boolean {
  const cleanFolder = cleanVaultFolder(folder);
  if (!cleanFolder) return false;
  const normalizedFile = normalizePath(filePath);
  return normalizedFile === cleanFolder || normalizedFile.startsWith(`${cleanFolder}/`);
}

export function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The nearest explicit choice wins, so an excluded subtree can contain a selected folder. */
export function isPathInsideWatchFolders(path: string, selection: WatchFolderSelection): boolean {
  for (let folder = normalizePath(path); folder; folder = parentFolder(folder)) {
    if (selection.excludedFolders.includes(folder)) return false;
    if (selection.watchFolders.includes(folder)) return true;
  }
  return false;
}

export function normalizeWatchFolders(selection: WatchFolderSelection): WatchFolderSelection {
  const rules = new Map<string, boolean>();
  function add(paths: string[], included: boolean): void {
    for (const path of paths) {
      const clean = typeof path === "string" && cleanVaultFolder(path);
      if (clean) rules.set(clean, included);
    }
  }
  add(selection.watchFolders, true);
  add(selection.excludedFolders, false);

  const result: WatchFolderSelection = { watchFolders: [], excludedFolders: [] };
  for (const path of [...rules.keys()].sort((a, b) => a.localeCompare(b))) {
    let ancestor = parentFolder(path);
    while (ancestor && !rules.has(ancestor)) ancestor = parentFolder(ancestor);
    const included = rules.get(path);
    if (included === (rules.get(ancestor) ?? false)) continue;
    (included ? result.watchFolders : result.excludedFolders).push(path);
  }
  return result;
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}
