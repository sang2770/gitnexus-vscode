// scripts/build-icon.mjs
// Convert resources/icon.svg → resources/icon.png (128x128)
// Run: node scripts/build-icon.mjs
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const svg = readFileSync(join(root, 'resources', 'icon.svg'));

await sharp(svg)
  .resize(128, 128)
  .png()
  .toFile(join(root, 'resources', 'icon.png'));

console.log('icon.png generated (128x128)');
