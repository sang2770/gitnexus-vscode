import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'GitNexus', 'gitnexus');
const sourceWebDistRoot = path.join(projectRoot, 'GitNexus', 'gitnexus-web', 'dist');
const runtimeRoot = path.join(projectRoot, 'runtime', 'gitnexus');
const runtimeWebRoot = path.join(projectRoot, 'runtime', 'web', 'dist');

// Copy CLI source + metadata, but NOT node_modules (lazy install)
const dirsToCopy = ['dist', 'vendor', 'hooks', 'skills'];
const filesToCopy = ['package.json', 'package-lock.json'];

console.log('📦 Bundling gitnexus CLI (lazy dependencies)...');
console.log(`  Source: ${sourceRoot}`);
console.log(`  Destination: ${runtimeRoot}`);
console.log(`  Note: node_modules will be installed on first extension activation`);

if (!fs.existsSync(path.join(sourceRoot, 'dist', 'cli', 'index.js'))) {
  console.error('❌ Error: Built CLI not found.');
  console.error('   Make sure to run: npm run build:gitnexus first');
  process.exit(1);
}

if (fs.existsSync(runtimeRoot)) {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
if (fs.existsSync(runtimeWebRoot)) {
  fs.rmSync(runtimeWebRoot, { recursive: true, force: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const files = fs.readdirSync(src);
  for (const file of files) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);

    if (fs.statSync(srcFile).isDirectory()) {
      copyDir(srcFile, destFile);
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
  }
}


fs.mkdirSync(runtimeRoot, { recursive: true });

for (const dir of dirsToCopy) {
  const src = path.join(sourceRoot, dir);
  const dest = path.join(runtimeRoot, dir);
  if (!fs.existsSync(src)) {
    continue;
  }
  copyDir(src, dest);
}

for (const file of filesToCopy) {
  const src = path.join(sourceRoot, file);
  const dest = path.join(runtimeRoot, file);
  if (!fs.existsSync(src)) {
    continue;
  }
  fs.copyFileSync(src, dest);
}

if (fs.existsSync(path.join(sourceWebDistRoot, 'index.html'))) {
  fs.mkdirSync(runtimeWebRoot, { recursive: true });
  copyDir(sourceWebDistRoot, runtimeWebRoot);
  console.log('✅ Dashboard web dist bundled to runtime/web/dist');
} else {
  console.warn('⚠️ gitnexus-web dist not found. Run npm run build:web to embed dashboard in VSIX.');
}

console.log('✅ CLI bundled successfully');
