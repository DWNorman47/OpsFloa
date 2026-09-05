import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const entry = resolve(root, 'src', 'index.jsx');
const renders = resolve(root, 'renders');
mkdirSync(renders, { recursive: true });
const browserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE
  || browserCandidates.find(candidate => existsSync(candidate));
const binariesDirectory = process.env.REMOTION_BINARIES_DIR;

if (!browserExecutable) {
  throw new Error('No Chrome-compatible browser found. Set REMOTION_BROWSER_EXECUTABLE.');
}

for (const id of ['field-to-payroll', 'plans-to-project', 'protect-the-margin']) {
  console.log(`Rendering ${id}...`);
  const args = [
    cli,
    'render',
    entry,
    id,
    resolve(renders, `${id}.mp4`),
    '--codec=h264',
    '--crf=18',
    `--browser-executable=${browserExecutable}`,
  ];

  if (binariesDirectory) {
    args.push(`--binaries-directory=${binariesDirectory}`);
  }

  execFileSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
}
