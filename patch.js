const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, 'tool');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync(root)) {
  process.exit(0);
}

const sources = new Map();
for (const file of walk(root, [])) {
  sources.set(file, fs.readFileSync(file, 'utf8'));
}

const all = [...sources.values()].join('\n');

const usesBad = /\bUNPRINTABLE_POINTS\b/.test(all);
const definesBad =
  /\b(?:const|let|var)\s+UNPRINTABLE_POINTS\b/.test(all) ||
  /\b(?:const|let|var)\s*\{[^}]*\bUNPRINTABLE_POINTS\b[^}]*\}\s*=/.test(all) ||
  /\bUNPRINTABLE_POINTS\s*=[^=]/.test(all);
const definesGood = /\b(?:const|let|var)\s+UNPRINTABLE\b/.test(all);

if (usesBad && !definesBad && definesGood) {
  for (const [file, text] of sources) {
    if (text.includes('UNPRINTABLE_POINTS')) {
      fs.writeFileSync(file, text.replace(/\bUNPRINTABLE_POINTS\b/g, 'UNPRINTABLE'));
      console.log(`patched ${path.relative(__dirname, file)}`);
    }
  }
}
