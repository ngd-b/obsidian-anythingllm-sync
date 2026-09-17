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

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}
