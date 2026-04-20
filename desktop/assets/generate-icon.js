/**
 * Génère les icônes Avi Contrôle pour electron-builder.
 *
 * Prérequis :
 *   npm install -g sharp  (ou : npm install --save-dev sharp)
 *
 * Usage :
 *   node assets/generate-icon.js
 *
 * Produit :
 *   assets/icon.png  (512×512)
 *   assets/icon.ico  (256×256, Windows)
 *   assets/icon.icns (macOS — nécessite macOS avec iconutil)
 *
 * À remplacer par votre vraie icône avant la mise en production.
 */

const fs   = require('fs');
const path = require('path');

// ── SVG source : logo minimaliste "AC" ──────────────────────────
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#4f46e5"/>
    </linearGradient>
  </defs>
  <!-- Fond arrondi -->
  <rect width="512" height="512" rx="96" ry="96" fill="url(#g)"/>
  <!-- Lettre A -->
  <text x="80"  y="360" font-family="Arial Black,sans-serif" font-size="260" font-weight="900"
        fill="white" opacity="1">A</text>
  <!-- Lettre C plus petite, décalée -->
  <text x="265" y="340" font-family="Arial Black,sans-serif" font-size="180" font-weight="900"
        fill="white" opacity="0.85">C</text>
  <!-- Trait de soulignement -->
  <rect x="60" y="390" width="392" height="12" rx="6" fill="white" opacity="0.4"/>
</svg>
`;

const outDir = path.join(__dirname);

// ── Écrire le SVG ────────────────────────────────────────────────
fs.writeFileSync(path.join(outDir, 'icon.svg'), SVG.trim());
console.log('✓ icon.svg écrit');

// ── Conversion PNG + ICO avec sharp (optionnel) ──────────────────
try {
  const sharp = require('sharp');

  const svgBuffer = Buffer.from(SVG);

  // PNG 512×512
  sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(outDir, 'icon.png'))
    .then(() => console.log('✓ icon.png généré (512×512)'))
    .catch(console.error);

  // ICO 256×256 (electron-builder l'accepte en .png renommé .ico)
  sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(path.join(outDir, 'icon.ico'))
    .then(() => console.log('✓ icon.ico généré (256×256)'))
    .catch(console.error);

} catch {
  console.log('ℹ  sharp non installé — copiez manuellement un icon.png et icon.ico dans assets/');
  console.log('   Pour installer : npm install --save-dev sharp');
  console.log('   Ou utilisez https://www.icoconverter.com/ pour convertir votre PNG en ICO');
}
