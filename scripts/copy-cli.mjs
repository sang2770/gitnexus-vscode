import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceWebDistRoot = path.join(projectRoot, 'GitNexus', 'gitnexus-web', 'dist');
const runtimeWebRoot = path.join(projectRoot, 'runtime', 'web', 'dist');

console.log('📦 Bundling gitnexus web...');
console.log(`  Source: ${sourceWebDistRoot}`);
console.log(`  Destination: ${runtimeWebRoot}`);

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

if (fs.existsSync(path.join(sourceWebDistRoot, 'index.html'))) {
  fs.mkdirSync(runtimeWebRoot, { recursive: true });
  copyDir(sourceWebDistRoot, runtimeWebRoot);
  console.log('✅ Web dist bundled successfully');
} else {
  console.error('❌ gitnexus-web dist not found. Run npm run build:web first.');
  process.exit(1);
}
