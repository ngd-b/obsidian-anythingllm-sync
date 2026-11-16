import { normalizePath } from "obsidian";

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

/** Canonical roots: parent folders already cover all their descendants. */
export function normalizeWatchFolders(folders: readonly string[]): string[] {
  const unique = [...new Set(folders.filter((folder) => typeof folder === "string").map(cleanVaultFolder).filter(Boolean))];
  return unique
    .filter((folder) => !unique.some((parent) => parent !== folder && isPathInsideFolder(folder, parent)))
    .sort((a, b) => a.localeCompare(b));
}

export function isPathInsideWatchFolders(filePath: string, folders: readonly string[]): boolean {
  return folders.some((folder) => isPathInsideFolder(filePath, folder));
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}
