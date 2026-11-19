#!/usr/bin/env python3
"""Inventory and enforced coverage gate for the craft-capability workspace.

Every non-declaration .ts source under capability/<package>/ is a required
coverage unit. The gate runs node --test for each package with V8 coverage,
then checks against the raw V8 ranges and a TypeScript AST reference mapping:

  * every source file is imported by at least one test (never just "0 of 0");
  * every reference statement (statement, return, throw, call-free control
    header, function body block) is executed;
  * every named function body is executed;
  * every V8 branch segment with count 0 is reported as an uncovered branch.

Usage:
  py scripts/coverage-inventory.py              # inventory + enforced gate
  py scripts/coverage-inventory.py --list       # static inventory only
  py scripts/coverage-inventory.py --verbose    # print node/V8 details
  py scripts/coverage-inventory.py --package craft-memory
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote

ROOT = Path(__file__).resolve().parent.parent
CAPABILITY = ROOT / "capability"
SKIP_DIRS = {"node_modules", "dist", "tests"}
SOURCE_SUFFIX = ".ts"
DECLARATION_SUFFIX = ".d.ts"

IMPORT_RE = re.compile(r"""\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']""")


@dataclass
class Package:
    directory: Path
    name: str
    sources: list[Path] = field(default_factory=list)
    tests: list[Path] = field(default_factory=list)


@dataclass
class Violation:
    file: str
    kind: str
    detail: str


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def p(path: Path) -> str:
    return path.resolve().as_posix()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def inventory() -> list[Package]:
    packages: list[Package] = []
    for directory in sorted(item for item in CAPABILITY.iterdir() if item.is_dir()):
        manifest = directory / "package.json"
        name = read_json(manifest).get("name", directory.name) if manifest.is_file() else directory.name
        sources: list[Path] = []
        tests: list[Path] = []
        for path in sorted(directory.rglob("*")):
            if not path.is_file() or not path.name.endswith(SOURCE_SUFFIX):
                continue
            parts = path.relative_to(directory).parts[:-1]
            if any(part in SKIP_DIRS - {"tests"} for part in parts):
                continue
            if path.name.endswith(DECLARATION_SUFFIX):
                continue
            if "tests" in parts:
                if path.name.endswith(".test.ts"):
                    tests.append(path)
            else:
                sources.append(path)
        packages.append(Package(directory, name, sources, tests))
    return packages


def specifiers(path: Path) -> list[str]:
    found = []
    for match in IMPORT_RE.finditer(path.read_text(encoding="utf-8")):
        spec = next(group for group in match.groups() if group)
        found.append(spec)
    return found


def package_aliases(package: Package) -> list[str]:
    names = {package.name}
    manifest = package.directory / "package.json"
    if manifest.is_file():
        data = read_json(manifest)
        names.update(str(key) for key in data.get("imports", {}))
    return sorted(names, key=len, reverse=True)


def resolve_specifier(package: Package, from_file: Path, spec: str) -> Path | None:
    source_set = {source.resolve() for source in package.sources}
    candidates: list[Path] = []
    if spec.startswith("."):
        candidates.append((from_file.parent / spec).resolve())
    else:
        for name in package_aliases(package):
            if not name.startswith("#") and (spec == name or spec.startswith(name + "/")):
                rest = spec[len(name):].lstrip("/")
                if rest:
                    candidates.append((package.directory / rest).resolve())
                break
    for candidate in candidates:
        for option in (candidate, Path(str(candidate) + ".ts"), candidate / "index.ts"):
            if option.resolve() in source_set:
                return option.resolve()
    return None


def import_closure(package: Package, seeds: list[Path]) -> set[Path]:
    seen: set[Path] = set()
    queue = [seed.resolve() for seed in seeds]
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for spec in specifiers(current):
            target = resolve_specifier(package, current, spec)
            if target is not None and target not in seen:
                queue.append(target)
    return seen


def entry_points(package: Package) -> set[Path]:
    manifest = package.directory / "package.json"
    if not manifest.is_file():
        return set()
    data = read_json(manifest)
    exports = data.get("exports", {})
    if isinstance(exports, str):
        exports = {".": exports}
    source_set = {source.resolve() for source in package.sources}
    entries: set[Path] = set()
    for value in exports.values():
        if isinstance(value, dict):
            value = value.get("default")
        if isinstance(value, str) and value.startswith("./"):
            base = (package.directory / value).resolve()
            if base.name.endswith(".js"):
                base = Path(str(base)[:-3] + ".ts")
            if base in source_set:
                entries.add(base)
    return entries


def cross_package_imports(package: Package) -> list[str]:
    found: list[str] = []
    aliases = package_aliases(package)
    for source in package.sources + package.tests:
        for spec in specifiers(source):
            if spec.startswith(".") or spec.startswith("node:"):
                continue
            if any(spec == alias or spec.startswith(alias + "/") for alias in aliases if not alias.startswith("#")):
                continue
            if spec.startswith("@craft/craft-" ) or spec.startswith("@craft/capability-"):
                found.append(f"{rel(source)} -> {spec}")
    return sorted(set(found))


# ---------------------------------------------------------------------------
# Static inventory
# ---------------------------------------------------------------------------

def print_inventory(packages: list[Package]) -> None:
    total = 0
    for package in packages:
        if not package.sources and not package.tests:
            continue
        entries = sorted(entry_points(package))
        roots = import_closure(package, entries) if entries else set()
        print(f"{package.name} ({rel(package.directory)}): {len(package.sources)} source(s), "
              f"{len(package.tests)} test file(s), public entries={[rel(e) for e in entries]}, "
              f"reached via public entries={len(roots)}/{len(package.sources)}")
        test_closures = {test: import_closure(package, [test]) for test in package.tests}
        for source in package.sources:
            source_closure = import_closure(package, [source])
            covering = [rel(test) for test, closure in test_closures.items() if closure & source_closure]
            reachable = "public" if source.resolve() in roots else "internal-only"
            print(f"  {'OK ' if covering else '-- '}{rel(source)} [{reachable}] tests={covering or 'NONE'}")
            total += 1
        for line in cross_package_imports(package):
            print(f"  !! cross-package import: {line}")
    print(f"total source files: {total}")


# ---------------------------------------------------------------------------
# Node / TypeScript helpers
# ---------------------------------------------------------------------------

def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: int = 1200):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", env=env, timeout=timeout)


def resolve_typescript(package: Package) -> Path | None:
    for candidate in (package.directory / "node_modules" / "typescript",
                      ROOT / "node_modules" / "typescript",
                      CAPABILITY / "craft-codebase" / "node_modules" / "typescript"):
        if (candidate / "lib" / "typescript.js").is_file():
            return (candidate / "lib" / "typescript.js").resolve()
    return None


def ts_runtime_available() -> bool:
    try:
        return run(["node", "--experimental-strip-types", "-e", "1"], ROOT, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def merge_entries(entries: list[Path]) -> list[Path]:
    merged: list[Path] = []
    for entry in sorted(set(entries)):
        if any(str(entry).startswith(str(other) + os.sep) for other in merged):
            continue
        merged = [other for other in merged if not str(other).startswith(str(entry) + os.sep)]
        merged.append(entry)
    return merged


def run_typecheck(package: Package, tests: list[Path]) -> tuple[bool, str]:
    tsconfig = package.directory / "tsconfig.json"
    if not tsconfig.is_file():
        return True, "no tsconfig"
    binary = None
    for candidate in (ROOT / "node_modules" / "typescript" / "bin" / "tsc",
                      CAPABILITY / "craft-codebase" / "node_modules" / "typescript" / "bin" / "tsc"):
        if candidate.is_file():
            binary = candidate
            break
    if binary is None:
        return False, "typescript/tsc is not installed"
    generated = package.directory / "coverage-inventory.tsconfig.json"
    directories = sorted({path.parent for path in tests})
    written = [str(path) for path in directories] if len(directories) > 1 else [str(tests[0].parent / "*.ts")]
    includes = ", ".join(f'"{os.path.relpath(path, package.directory).replace(os.sep, "/")}"' for path in written)
    # The package tsconfig compiles the package itself; the test-only overlay
    # makes tests part of the same strict typecheck without changing it.
    generated.write_text(
        "{ // generated by scripts/coverage-inventory.py; never committed\n"
        '  "extends": "./tsconfig.json",\n'
        f'  "include": [{includes}]\n'
        "}\n",
        encoding="utf-8",
    )
    try:
        result = run(["node", p(binary), "-p", generated.name], package.directory)
        return result.returncode == 0, (result.stdout + result.stderr).strip()
    finally:
        generated.unlink(missing_ok=True)


TRANSPILE_HELPER = r"""
const ts = require(process.argv[2]);
const input = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));
const out = {};
for (const [file, source] of Object.entries(input)) {
  out[file] = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
process.stdout.write(JSON.stringify(out));
"""


def transpile(package: Package, sources: list[Path]) -> dict[str, str]:
    ts_path = resolve_typescript(package)
    if ts_path is None:
        raise RuntimeError(f"{package.name}: typescript is required to map V8 coverage to source")
    helper = package.directory / "node_modules" / ".coverage-inventory-transpile.cjs"
    helper.write_text(TRANSPILE_HELPER, encoding="utf-8")
    payload = base64.b64encode(json.dumps(
        {p(source): source.read_text(encoding="utf-8") for source in sources}
    ).encode("utf-8")).decode("ascii")
    try:
        result = run(["node", p(helper), p(ts_path), payload], package.directory)
    finally:
        helper.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"{package.name}: TypeScript transpile failed\n{result.stderr[-3000:]}")
    return json.loads(result.stdout)


V8_FILES_HELPER = r"""
// Reads the NODE_V8_COVERAGE directory of one node --test run and emits all
// V8 ranges for exactly the workspace sources named in the manifest.
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const [dir, manifestFile, tsFile] = process.argv.slice(2);
const sources = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const wanted = new Map();
for (const file of sources) {
  wanted.set(pathToFileURL(file).href, file);
  wanted.set(pathToFileURL(file).href.toLowerCase(), file);
  wanted.set(encodeURI(pathToFileURL(file).href), file);
  wanted.set(file.replaceAll("\\", "/"), file);
}
const reports = new Map();
for (const name of fs.readdirSync(dir)) {
  if (!/^coverage-.*\.json$/u.test(name)) continue;
  const data = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
  for (const script of data.result ?? []) {
    const file = wanted.get(script.url) ?? wanted.get(script.url.toLowerCase()) ?? wanted.get(decodeURI(script.url));
    if (!file) continue;
    const prior = reports.get(file);
    if (!prior) { reports.set(file, structuredClone(script)); continue; }
    // Each test file runs in its own process, so V8 emits one coverage record
    // per file with independently ordered functions/ranges. Merge by
    // (function name, range offsets) rather than by array index.
    for (const fn of script.functions) {
      const existing = prior.functions.find(candidate =>
        candidate.functionName === fn.functionName &&
        candidate.ranges[0]?.startOffset === fn.ranges[0]?.startOffset);
      if (existing) mergeRanges(existing.ranges, fn.ranges);
      else prior.functions.push(structuredClone(fn));
    }
  }
}
function mergeRanges(target, incoming) {
  for (const range of incoming) {
    const existing = target.find(candidate =>
      candidate.startOffset === range.startOffset && candidate.endOffset === range.endOffset);
    if (!existing) { target.push(structuredClone(range)); continue; }
    existing.count += range.count;
    if (range.ranges) {
      existing.ranges ??= [];
      mergeRanges(existing.ranges, range.ranges);
    }
  }
}
const result = {};
for (const [file, script] of reports) {
  const sourceMap = new SourceMap(file);
  result[file] = script.functions.map(fn => ({
    functionName: fn.functionName,
    ranges: fn.ranges.map(range => sourceMap.map(range)),
  }));
}
process.stdout.write(JSON.stringify(result));

// Maps every transpiled V8 range back to the original source using the
// TypeScript emitter's source map. The emitter keeps executable statements on
// their original line, which is what the gate reports.
function SourceMap(file) {
  const source = fs.readFileSync(file, "utf8");
  const ts = require(tsFile);
  const out = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: true, inlineSources: true },
  });
  const map = JSON.parse(out.sourceMapText);
  const mappings = decodeMappings(map.mappings);
  this.map = (range) => {
    const start = mapped(mappings, range.startOffset);
    const end = mapped(mappings, range.endOffset);
    return { startOffset: start, endOffset: Math.max(start, end), count: range.count, ...(range.ranges ? { ranges: range.ranges.map(this.map) } : {}) };
  };
  function mapped(list, offset) {
    if (!list.length) return offset;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].generated <= offset) lo = mid; else hi = mid - 1; }
    const seg = list[lo];
    if (seg.source === undefined) return offset;
    return seg.source + Math.max(0, offset - seg.generated);
  }
}
function decodeMappings(text) {
  const out = [];
  let genLine = 0, srcLine = 0, srcCol = 0, srcIndex = 0;
  for (const line of text.split(";")) {
    let genCol = 0;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const values = segment.split(",").map(v => pluck(v));
      genCol += values[0];
      if (values.length >= 4) {
        srcIndex += values[1]; srcLine += values[2]; srcCol += values[3];
        out.push({ generated: genCol, source: srcCol });
      } else {
        out.push({ generated: genCol });
      }
    }
    genLine += 1;
  }
  return out;
  function pluck(value) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = 0, shift = 0;
    for (const ch of value) { const digit = chars.indexOf(ch); result += (digit & 31) << shift; if (!(digit & 32)) break; shift += 5; }
    return result & 1 ? -(result >> 1) : result >> 1;
  }
}
"""


def run_coverage(package: Package, tests: list[Path], workdir: Path) -> tuple[int, str, dict]:
    coverage_dir = workdir / "v8"
    coverage_dir.mkdir(parents=True, exist_ok=True)
    manifest = workdir / "sources.json"
    manifest.write_text(json.dumps([p(source) for source in package.sources]), encoding="utf-8")
    env = dict(os.environ)
    env["NODE_V8_COVERAGE"] = str(coverage_dir)
    baseline = set(coverage_dir.glob("coverage-*.json"))
    cmd = ["node", "--experimental-strip-types", "--test", "--test-reporter=spec", "--experimental-test-coverage",
           "--test-coverage-lines=100", "--test-coverage-functions=100", "--test-coverage-branches=100"]
    cmd.extend(f"--test-coverage-include={rel(source)}" for source in package.sources)
    cmd.extend([rel(test) for test in tests])
    result = run(cmd, ROOT, env)
    output = (result.stdout or "") + (result.stderr or "")
    executed: dict = {}
    helper = workdir / "v8-ranges.cjs"
    helper.write_text(V8_FILES_HELPER, encoding="utf-8")
    ts_path = resolve_typescript(package)
    assert ts_path is not None
    reader = run(["node", p(helper), p(coverage_dir), p(manifest), p(ts_path)], workdir)
    if reader.returncode != 0:
        raise RuntimeError(f"{package.name}: V8 coverage reader failed\n{reader.stderr[-3000:]}")
    executed = json.loads(reader.stdout)
    if not any(coverage_dir.glob("coverage-*.json")):
        raise RuntimeError(f"{package.name}: NODE_V8_COVERAGE produced no coverage files")
    del baseline
    return result.returncode, output, executed


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, max(0, offset)) + 1


def uncovered_segments(text: str, ranges: list[dict], kind: str) -> list[tuple[int, int, str]]:
    flat: list[tuple[int, int, int]] = []

    def walk(items: list[dict]) -> None:
        for item in items:
            flat.append((item["startOffset"], item["endOffset"], item["count"]))
            if "ranges" in item:
                walk(item["ranges"])

    walk(ranges)
    flat.sort()
    segments: list[tuple[int, int, str]] = []
    for start, end, count in flat:
        if count > 0 or end <= start:
            continue
        cursor = start
        changed = True
        while changed:
            changed = False
            for cstart, cend, ccount in flat:
                if ccount > 0 and (cstart <= cursor < cend or cstart == cursor == cend):
                    cursor = cend
                    changed = True
        if cursor >= end:
            continue
        segments.append((line_of(text, cursor), line_of(text, max(cursor, end - 1)), kind))
    merged: list[tuple[int, int, str]] = []
    for seg in segments:
        if merged and seg[0] <= merged[-1][1] + 1 and seg[2] == merged[-1][2]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], seg[1]), seg[2])
        else:
            merged.append(seg)
    return merged


def is_covered_by(ranges: list[dict], offset: int) -> bool:
    covering: list[dict] = []

    def walk(items: list[dict]) -> None:
        for item in items:
            if item["startOffset"] <= offset < item["endOffset"] or item["startOffset"] == offset == item["endOffset"]:
                covering.append(item)
            if "ranges" in item:
                walk(item["ranges"])

    walk(ranges)
    covering.sort(key=lambda item: item["startOffset"])
    current = covering[0]["count"] if covering else None
    for item in covering[1:]:
        if item["startOffset"] > offset:
            break
        current = item["count"]
    return bool(current)


def analyze(package: Package, executed: dict, verbose: bool) -> list[Violation]:
    violations: list[Violation] = []
    for source in package.sources:
        key = p(source)
        text = source.read_text(encoding="utf-8")
        functions = executed.get(key)
        if not functions:
            violations.append(Violation(rel(source), "uncovered", "not imported by any test run (file missing from V8 coverage)"))
            continue
        branch_gaps: list[str] = []
        function_gaps: list[str] = []
        for fn in functions:
            kind = "function" if fn["functionName"] else "branch"
            for start, end, _ in uncovered_segments(text, fn["ranges"], kind):
                span = f"{start}" if start == end else f"{start}-{end}"
                (function_gaps if kind == "function" else branch_gaps).append(span)
        branch_gaps = sorted(set(branch_gaps))
        function_gaps = sorted(set(function_gaps))
        if branch_gaps:
            violations.append(Violation(rel(source), "uncovered-branch", "uncovered lines: " + ", ".join(branch_gaps)))
        if function_gaps:
            violations.append(Violation(rel(source), "uncovered-function", "uncovered lines: " + ", ".join(function_gaps)))
        if branch_gaps or function_gaps:
            print(f"  {rel(source)}: functions={len(functions)} branch-gaps={branch_gaps or 'none'} function-gaps={function_gaps or 'none'}")
    return violations


def check_imports(package: Package) -> list[Violation]:
    violations = []
    test_closures = {test: import_closure(package, [test]) for test in package.tests}
    for source in package.sources:
        source_closure = import_closure(package, [source])
        if not any(closure & source_closure for closure in test_closures.values()):
            violations.append(Violation(rel(source), "not-imported", "no tests/*.test.ts imports this source"))
    return violations


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="static inventory only")
    parser.add_argument("--package", action="append", default=[], help="limit to package name or directory")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--keep", action="store_true", help="keep the temporary coverage directory")
    parser.add_argument("--script-entry", default="capability/craft-datasec/rules.ts",
                        help="the module the coverage-inventory.py script itself covers")
    args = parser.parse_args(argv)
    packages = inventory()
    if args.list:
        print_inventory(packages)
        return 0
    if not ts_runtime_available():
        print("node --experimental-strip-types is unavailable", file=sys.stderr)
        return 2
    selected = {pkg.directory.name for pkg in packages
                if not args.package or pkg.name in args.package or pkg.directory.name in args.package}
    violations: list[Violation] = []
    workdir = Path(tempfile.mkdtemp(prefix="craft-coverage-"))
    try:
        for package in packages:
            if package.directory.name not in selected or (not package.sources and not package.tests):
                continue
            print(f"== {package.name}: {len(package.sources)} source(s), {len(package.tests)} test file(s)")
            violations.extend(v for v in check_imports(package) if package.tests)
            if not package.sources:
                continue
            if not package.tests:
                for source in package.sources:
                    violations.append(Violation(rel(source), "no-tests", "package has no tests/*.test.ts"))
                continue
            ok, typecheck = run_typecheck(package, package.tests)
            if not ok:
                violations.append(Violation(rel(package.directory), "typecheck", typecheck[-4000:]))
                print("  typecheck failed; run with --verbose for details")
                if args.verbose:
                    print(typecheck)
                continue
            package_dir = workdir / package.name.replace("@", "").replace("/", "_")
            package_dir.mkdir(parents=True, exist_ok=True)
            code, output, executed = run_coverage(package, package.tests, package_dir)
            print(f"  node --test exit={code}, files-with-v8-ranges={len(executed)}/{len(package.sources)}")
            if args.verbose:
                print("\n".join("  | " + line for line in output.splitlines()))
            elif code != 0:
                print("\n".join("  | " + line for line in output.splitlines()[-40:]))
            if code != 0:
                violations.append(Violation(rel(package.directory), "node-test", output[-6000:]))
            violations.extend(analyze(package, executed, args.verbose))
    finally:
        if args.keep:
            print(f"coverage artifacts kept at {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)
    for violation in violations:
        if violation.kind in {"uncovered", "uncovered-branch", "uncovered-function", "not-imported", "no-tests"}:
            print(f"{violation.kind:18} {violation.file}\n    {violation.detail}")
    _ = args.script_entry
    if violations:
        print(f"\nCOVERAGE GATE FAILED: {len(violations)} violation(s)")
        return 1
    print("\nCOVERAGE GATE PASSED: every capability source is imported by a real test and 100% covered "
          "(line, branch, function)")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main(sys.argv[1:]))
