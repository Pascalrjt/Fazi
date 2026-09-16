import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version) {
  if (!versionPattern.test(version)) {
    throw new Error(`Expected a major.minor.patch version, got ${version}`);
  }
  return version.split('.').map(BigInt);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function chooseVersion(baseVersion, tags, commitTags) {
  parseVersion(baseVersion);
  const releaseVersions = (values) => values
    .filter((tag) => tag.startsWith('v') && versionPattern.test(tag.slice(1)))
    .map((tag) => tag.slice(1));
  const reserved = releaseVersions(commitTags);
  if (reserved.length > 1) throw new Error('Multiple release versions point to this commit');
  if (reserved.length === 1) return reserved[0];
  const latest = [baseVersion, ...releaseVersions(tags)].sort(compareVersions).at(-1);
  const [major, minor, patch] = parseVersion(latest);
  return `${major}.${minor}.${patch + 1n}`;
}

export function replaceCargoVersion(contents, section, version) {
  let found = 0;
  const updated = contents.replace(section, (block) => {
    found++;
    if (!/^version = "[^"]+"$/m.test(block)) {
      throw new Error('Could not locate the Fazi Cargo version field');
    }
    return block.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  });
  if (found !== 1) {
    throw new Error('Could not locate the Fazi Cargo version');
  }
  return updated;
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  git('fetch', 'origin', '--tags');
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const version = chooseVersion(config.version, git('tag', '--list').split('\n'),
    git('tag', '--points-at', 'HEAD').split('\n'));

  for (const path of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.version = version;
    if (path === 'package-lock.json') value.packages[''].version = version;
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  const sections = {
    'src-tauri/Cargo.toml': /\[package\][\s\S]*?(?=\n\[|$)/g,
    'src-tauri/Cargo.lock': /\[\[package\]\]\nname = "fazi"\n[\s\S]*?(?=\n\[\[package\]\]|$)/g,
  };
  for (const [path, section] of Object.entries(sections)) {
    writeFileSync(path, replaceCargoVersion(readFileSync(path, 'utf8'), section, version));
  }
  const tag = `v${version}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
  console.log(`Building Fazi ${tag} from ${git('rev-parse', 'HEAD')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
