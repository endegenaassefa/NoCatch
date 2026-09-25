const fs = require('node:fs');
const path = require('node:path');

const ref = process.env.GITHUB_REF || '';
if (ref.startsWith('refs/tags/')) {
  const version = ref.slice('refs/tags/'.length).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Tag must contain a semantic release version');
  const root = path.resolve(__dirname, '..');
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(root, name);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.version = version;
    if (data.packages?.['']) data.packages[''].version = version;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  console.log(`Build version: ${version}`);
}
