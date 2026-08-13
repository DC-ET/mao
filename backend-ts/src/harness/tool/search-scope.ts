import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export class SearchScope {
  private constructor(
    readonly cwd: string,
    readonly rgTarget: string,
    readonly singleFile: string | null,
  ) {}

  static from(resolved: string): SearchScope {
    const stat = existsSync(resolved) ? statSync(resolved) : null;
    if (stat?.isFile()) {
      const parent = path.dirname(resolved);
      if (!parent) {
        throw new Error('Cannot search in file without parent directory: ' + resolved);
      }
      return new SearchScope(parent, path.relative(parent, resolved), resolved);
    }
    if (stat?.isDirectory()) {
      return new SearchScope(resolved, '.', null);
    }
    throw new Error('Search path does not exist or is not accessible: ' + resolved);
  }

  isSingleFile(): boolean {
    return this.singleFile != null;
  }

  outputFilePath(rgFilePath: string, workspaceRoot: string | null): string {
    if (this.singleFile != null) {
      const normalized = path.resolve(this.singleFile);
      if (workspaceRoot != null) {
        const root = path.resolve(workspaceRoot);
        const rel = path.relative(root, normalized);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          return rel;
        }
      }
      return path.basename(normalized);
    }
    return SearchScope.relativizeRgPath(rgFilePath, this.cwd);
  }

  static relativizeRgPath(pathStr: string, searchRoot: string): string {
    const trimmed = pathStr.startsWith('./') ? pathStr.slice(2) : pathStr;
    if (path.isAbsolute(trimmed)) {
      const normalized = path.resolve(trimmed);
      const rel = path.relative(searchRoot, normalized);
      return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : normalized;
    }
    return path.normalize(trimmed);
  }
}
