const fs = require('node:fs');
const path = require('node:path');

function clean(root = path.resolve(__dirname, '..')) {
  const workspace = fs.realpathSync(root);
  const target = path.resolve(workspace, 'dist');
  if (path.dirname(target) !== workspace) throw new Error('Output directory is outside the project');
  if (!fs.existsSync(target)) return;
  if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) {
    throw new Error('Refusing to recursively remove a linked output directory');
  }
  fs.rmSync(target, { recursive: true });
}

if (require.main === module) clean();
module.exports = { clean };
