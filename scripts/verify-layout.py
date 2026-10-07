#!/usr/bin/env python3
"""Verify every moved file against its recorded Git origin; report later edits."""
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "docs/migration-manifest.json").read_text())
changed, missing, unchanged = [], [], 0
seen = set()
for entry in manifest["files"]:
    target = entry["target"]
    assert target not in seen, f"duplicate target: {target}"
    seen.add(target)
    assert target.startswith(f'apps/{entry["app"]}/'), target
    ref = manifest[f'{entry["app"]}_base']
    original = subprocess.check_output(
        ["git", "show", f'{ref}:{entry["source"]}'], cwd=ROOT
    )
    assert hashlib.sha256(original).hexdigest() == entry["sha256"], target
    path = ROOT / target
    if not path.is_file():
        missing.append(target)
    elif hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]:
        unchanged += 1
    else:
        changed.append(target)

assert not missing, f"Missing moved files: {missing}"
assert not (ROOT / "pyproject.toml").exists(), "Python package must live in its app"
assert not (ROOT / "package.json").exists(), "Node package must live in its app"
assert not (ROOT / "air-choir").exists(), "Old AirChoir directory remains"
assert not (ROOT / "band2sheet").exists(), "Old Python package directory remains"
print(f'Origin hashes verified: {len(seen)}; present: {len(seen)}; unchanged: {unchanged}')
print(f'Edited after move ({len(changed)}); review alongside INTEGRATION.md:')
for path in changed:
    print(f'  {path}')
