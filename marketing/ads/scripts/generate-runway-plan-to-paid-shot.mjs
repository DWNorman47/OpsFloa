import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiBase = 'https://api.dev.runwayml.com/v1';
const apiVersion = '2024-11-06';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(dirname(fileURLToPath(import.meta.url)), 'runway-plan-to-paid-shots.json');
const shots = JSON.parse(readFileSync(configPath, 'utf8'));
const shotName = process.argv[2];
const flags = new Set(process.argv.slice(3));

if (!shotName || !shots[shotName]) {
  console.error(`Choose one shot: ${Object.keys(shots).join(', ')}`);
  process.exit(1);
}

if (!flags.has('--confirm-cost')) {
  console.error('This call is expected to spend about 25 Runway credits ($0.25). Re-run with --confirm-cost to submit it.');
  process.exit(1);
}

const apiSecret = process.env.RUNWAYML_API_SECRET;
if (!apiSecret) {
  console.error('Set RUNWAYML_API_SECRET in the environment before generating a shot.');
  process.exit(1);
}

const shot = shots[shotName];
const imagePath = resolve(projectRoot, shot.image);
const outputPath = resolve(projectRoot, shot.output);
if (!existsSync(imagePath)) {
  throw new Error(`Reference image not found: ${imagePath}`);
}
if (existsSync(outputPath) && !flags.has('--force')) {
  throw new Error(`Output already exists: ${outputPath}. Pass --force only when intentionally buying another take.`);
}

const mimeTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const mimeType = mimeTypes[extname(imagePath).toLowerCase()];
if (!mimeType) {
  throw new Error(`Unsupported reference image type: ${extname(imagePath)}`);
}

async function runway(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiSecret}`,
      'X-Runway-Version': apiVersion,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Runway API ${response.status}: ${body}`);
  }
  return body ? JSON.parse(body) : {};
}

const promptImage = `data:${mimeType};base64,${readFileSync(imagePath).toString('base64')}`;
const created = await runway('/image_to_video', {
  method: 'POST',
  body: JSON.stringify({
    model: 'gen4_turbo',
    promptImage,
    promptText: shot.prompt,
    ratio: '1280:720',
    duration: 5,
  }),
});

console.log(`Submitted ${shotName}: ${created.id}`);
let task = created;
let lastStatus;
const deadline = Date.now() + 15 * 60 * 1000;
while (Date.now() < deadline) {
  task = await runway(`/tasks/${created.id}`);
  if (task.status !== lastStatus) {
    console.log(`Runway status: ${task.status}`);
    lastStatus = task.status;
  }
  if (task.status === 'SUCCEEDED') break;
  if (['FAILED', 'CANCELED', 'CANCELLED'].includes(task.status)) {
    throw new Error(`Runway generation failed: ${JSON.stringify(task)}`);
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 5000));
}

if (task.status !== 'SUCCEEDED') {
  throw new Error(`Runway generation timed out after 15 minutes. Task: ${created.id}`);
}

const assetUrl = Array.isArray(task.output) ? task.output[0] : null;
if (!assetUrl) {
  throw new Error(`Runway task succeeded without a downloadable output: ${JSON.stringify(task)}`);
}

const assetResponse = await fetch(assetUrl);
if (!assetResponse.ok) {
  throw new Error(`Could not download Runway output: ${assetResponse.status}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.from(await assetResponse.arrayBuffer()));
writeFileSync(outputPath.replace(/\.mp4$/i, '.json'), JSON.stringify({
  shot: shotName,
  taskId: created.id,
  model: 'gen4_turbo',
  duration: 5,
  ratio: '1280:720',
  image: shot.image,
  prompt: shot.prompt,
  generatedAt: new Date().toISOString(),
}, null, 2));

console.log(`Saved ${outputPath}`);
