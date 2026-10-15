#!/usr/bin/env node

/**
 * scripts/build.js - Automated Single Executable Application (SEA) Builder.
 * Produces a 100% standalone executable (dist/secullum-agent.exe on Windows,
 * dist/secullum-agent on Linux) requiring NO Node.js runtime to execute.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const IS_WIN = process.platform === 'win32';
const customName = process.env.OUT_NAME || (process.argv[2] ? path.basename(process.argv[2]) : null);
const EXE_NAME = customName || (IS_WIN ? 'secullum-agent.exe' : 'secullum-agent');
const OUTPUT_EXE = path.join(DIST_DIR, EXE_NAME);

console.log(`🚀 Iniciando compilação do executável autônomo: ${EXE_NAME}`);

// 1. Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// 2. Bundle all modules with esbuild into a single file
console.log('📦 1/4 Empacotando módulos JS com esbuild...');
const bundleFile = path.join(DIST_DIR, 'bundle.js');
const npxCmd = IS_WIN ? 'npx.cmd' : 'npx';

execSync(`${npxCmd} --yes esbuild bin/cli.js --bundle --platform=node --target=node20 --outfile="${bundleFile}"`, {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

// 3. Write SEA config
console.log('⚙️  2/4 Gerando blob de preparação SEA (Single Executable Application)...');
const seaConfigFile = path.join(ROOT_DIR, 'sea-config.json');
const seaConfig = {
  main: path.relative(ROOT_DIR, bundleFile).replace(/\\/g, '/'),
  output: path.relative(ROOT_DIR, path.join(DIST_DIR, 'sea-prep.blob')).replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(seaConfigFile, JSON.stringify(seaConfig, null, 2), 'utf-8');

// 4. Generate preparation blob with Node SEA compiler
execSync(`"${process.execPath}" --experimental-sea-config sea-config.json`, {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

// 5. Copy current node binary as template
console.log(`📋 3/4 Copiando binário base para ${EXE_NAME}...`);
fs.copyFileSync(process.execPath, OUTPUT_EXE);

// 6. Inject preparation blob using postject
console.log('💉 4/4 Injetando bytecode da aplicação no executável nativo...');
const blobPath = path.join(DIST_DIR, 'sea-prep.blob');
const postjectCmd = `${npxCmd} --yes postject "${OUTPUT_EXE}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;

execSync(postjectCmd, {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

// Ensure executable permissions on Linux / macOS
if (!IS_WIN) {
  try {
    fs.chmodSync(OUTPUT_EXE, 0o755);
  } catch {}
}

// 7. Cleanup intermediate files
try {
  if (fs.existsSync(bundleFile)) fs.unlinkSync(bundleFile);
  if (fs.existsSync(blobPath)) fs.unlinkSync(blobPath);
} catch {}

const stats = fs.statSync(OUTPUT_EXE);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);

console.log('\n✨ SUCESSO! Executável autônomo gerado com sucesso:');
console.log(`   Arquivo:  ${OUTPUT_EXE}`);
console.log(`   Tamanho:  ${sizeMb} MB`);
console.log(`   Requisitos: Nenhum! Pode ser copiado e executado diretamente em qualquer máquina sem Node.js instalado.\n`);
