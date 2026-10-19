"""Stage an explicit legacy runtime artifact; never copy a developer checkout."""
from pathlib import Path
import argparse
import concurrent.futures
import hashlib
import json
import shutil
import tempfile


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--entry', type=Path, help='Explicit freshly compiled entry replacing the artifact entry')
    parser.add_argument('--strip-development', action='store_true', help='Omit declarations, source maps and dependency test/example trees')
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    inventory = json.loads((source / 'files.json').read_text(encoding='utf-8'))
    if manifest.get('protocol') != 'legacy-stream-json' or manifest.get('entry') != 'cli.cjs':
        raise SystemExit('Expected an inventoried legacy-stream-json runtime with cli.cjs entry')
    if manifest.get('desktopToolCatalog') != 'complete-permission-gated' or not isinstance(manifest.get('ripgrep'), dict):
        raise SystemExit('Use the current compatibility artifact with the complete Desktop tool catalog and pinned ripgrep helper')
    resources = Path(__file__).resolve().parents[1] / 'src-tauri/resources'
    resources.mkdir(parents=True, exist_ok=True)
    target = resources / 'cli-legacy'
    if target.exists():
        raise SystemExit('Review and archive the existing cli-legacy staging directory first')
    staged = Path(tempfile.mkdtemp(prefix='legacy-candidate-', dir=resources))
    rows = []
    omitted = []
    try:
        names = set()
        for row in inventory:
            relative = Path(row['path'])
            key = relative.as_posix().casefold()
            if relative.is_absolute() or '..' in relative.parts or key in names:
                raise ValueError('Unsafe or duplicate runtime inventory path')
            names.add(key)
        def stage(row):
            relative = Path(row['path'])
            original = source / relative
            notice = any(word in original.name.casefold() for word in ['license', 'notice', 'copying', 'copyright'])
            development = original.name.endswith(('.d.ts', '.d.mts', '.d.cts', '.map')) or any(
                part.casefold() in {'test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'coverage', 'examples', 'example', 'docs', 'dist-types'}
                for part in relative.parts[1:-1])
            if args.strip_development and development and not notice:
                return None
            if original.is_symlink() or not original.resolve(strict=True).is_relative_to(source):
                raise ValueError('Redirected runtime input')
            data = original.read_bytes()
            if hashlib.sha256(data).hexdigest() != row['sha256']:
                raise ValueError('Runtime input hash differs: ' + relative.as_posix())
            selected = args.entry.resolve(strict=True) if relative.as_posix() == 'cli.cjs' and args.entry else original
            if selected != original:
                data = selected.read_bytes()
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            return {'path': relative.as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        # Bound I/O concurrency; never hold the whole dependency closure in memory.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for item in pool.map(stage, inventory):
                if item is None:
                    omitted.append(None)
                else:
                    rows.append(item)
        if 'cli.cjs' not in names or not (staged / 'node_modules').is_dir():
            raise ValueError('Incomplete legacy runtime')
        manifest['sha256'] = digest(staged / 'cli.cjs')
        manifest['entryRebuilt'] = args.entry is not None
        manifest['omittedDevelopmentFiles'] = len(omitted)
        manifest.pop('sourceSha256', None)
        for name in ['NOTICE.txt', 'package.json']:
            file = source / name
            if file.is_file() and not (staged / name).exists():
                shutil.copyfile(file, staged / name)
        (staged / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        (staged / 'files.json').write_text(json.dumps(rows, indent=2) + '\n', encoding='utf-8')
        staged.rename(target)
        print(json.dumps({'files': len(rows), 'bytes': sum(row['bytes'] for row in rows), 'entrySha256': manifest['sha256']}))
    except BaseException:
        # Preserve the failed candidate for diagnosis; never publish a partial tree.
        print('Incomplete candidate retained at: ' + str(staged))
        raise


if __name__ == '__main__':
    main()
