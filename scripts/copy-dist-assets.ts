#!/usr/bin/env bun
// FILE: scripts/copy-dist-assets.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Mirror every non-TypeScript src asset into dist at the same relative path so `?raw` imports resolve from the built package.
//   SCOPE: Owns the single definition of a copied asset (a src file that is not .ts/.tsx) and the src-to-dist mirror rule; pure path planning over directory walks plus a disk-backed CLI that copies every asset below dist/creating missing directories. The pack gate consumes the same listing so a dropped copy fails check-package with the file named.
//   DEPENDS: [node:fs, node:path]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   isSourceAssetPath - Decide whether one repo-root-relative src path is a copied non-TS asset.
//   listDirectoryFilePaths - Walk one directory under the repo root and list repo-root-relative files.
//   listSourceAssetPaths - List the non-TS src assets that must mirror into dist.
//   copySourceAssets - Copy every src asset to its mirrored dist path and report the written targets.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Replaced the single hardcoded system-instruction.md copy in the build script with a general src-to-dist mirror of every non-TypeScript asset.]
// END_CHANGE_SUMMARY

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Decide whether one repo-root-relative src path is a copied non-TS asset. */
export function isSourceAssetPath(path: string): boolean {
  return !path.endsWith(".ts") && !path.endsWith(".tsx");
}

/** Walk one directory under the repo root and list repo-root-relative files. */
export function listDirectoryFilePaths(repoRoot: string, directory: string): string[] {
  const rootDir = resolve(repoRoot, directory);
  if (!existsSync(rootDir)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile()) files.push(relative(repoRoot, absolute).split(sep).join("/"));
    }
  };
  visit(rootDir);
  return files.sort();
}

/** List the non-TS src assets that must mirror into dist. */
export function listSourceAssetPaths(repoRoot: string): string[] {
  return listDirectoryFilePaths(repoRoot, "src").filter(isSourceAssetPath);
}

/** Copy every src asset to its mirrored dist path and report the written targets. */
export function copySourceAssets(repoRoot: string): string[] {
  const targets: string[] = [];
  for (const asset of listSourceAssetPaths(repoRoot)) {
    const target = asset.replace(/^src\//, "dist/");
    const targetPath = resolve(repoRoot, target);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(resolve(repoRoot, asset), targetPath);
    targets.push(target);
  }
  return targets;
}

if (import.meta.main) {
  const targets = copySourceAssets(process.cwd());
  console.log(
    targets.length === 0
      ? "✓ no non-TS src assets to mirror into dist."
      : `✓ mirrored ${targets.length} non-TS src asset(s) into dist:\n${targets
          .map((target) => `  ${target}`)
          .join("\n")}`,
  );
}
