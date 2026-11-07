import type { FilePathKind } from "../types/pipeline";

/** Cross-platform absolute check (ADR-0043) — mirrors Rust `looks_absolute_cross_platform`. */
export function looksAbsoluteCrossPlatform(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  if (p.toLowerCase().startsWith("s3://")) return true;
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  return false;
}

export function portableRelative(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Prefer relative+kind when `absPath` is under the project file directory.
 * Otherwise keep absolute. Unsaved projects (no rootPath) stay absolute.
 */
export function bindFilePath(
  absPath: string,
  projectFile?: string | null,
): { path: string; path_kind: FilePathKind } {
  const trimmed = absPath.trim();
  if (!projectFile?.trim() || trimmed.toLowerCase().startsWith("s3://")) {
    return { path: trimmed, path_kind: "absolute" };
  }
  const projDir = projectFile.replace(/[/\\][^/\\]*$/, "");
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const base = norm(projDir);
  const target = norm(trimmed);
  if (base && (target === base || target.startsWith(`${base}/`))) {
    const rel = portableRelative(trimmed.slice(projDir.length));
    if (rel) return { path: rel, path_kind: "relative" };
  }
  return { path: trimmed, path_kind: "absolute" };
}
