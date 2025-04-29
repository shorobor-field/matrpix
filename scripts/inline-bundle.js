const fs = require('fs');
const path = require('path');

const htmlPath = path.resolve(__dirname, '../dist/index.html');
const bundlePath = path.resolve(__dirname, '../dist/bundle.js');

let html = fs.readFileSync(htmlPath, 'utf8');
const bundleCode = fs.readFileSync(bundlePath, 'utf8');

// Replace bundle reference with actual code
html = html.replace('<script src="bundle.js"></script>', `<script>${bundleCode}</script>`);

// Save as single file
fs.writeFileSync(path.resolve(__dirname, '../dist/matrix-rpg-client.html'), html);
console.log('Created self-contained file: dist/matrix-rpg-client.html');