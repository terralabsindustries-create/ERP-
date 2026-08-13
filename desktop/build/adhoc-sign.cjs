/**
 * Ad-hoc signs the macOS bundle after packaging.
 *
 * Without an Apple Developer certificate electron-builder skips signing
 * entirely, which leaves the app carrying only the linker-generated signature
 * Electron ships with: `Sealed Resources=none`, `Info.plist=not bound`. On
 * Apple Silicon that is not a valid bundle signature, and Gatekeeper reports
 * the download as *"SerpY is damaged and can't be opened"* — which reads like
 * a corrupt file rather than a signing problem, so it sends people hunting in
 * the wrong direction.
 *
 * A deep ad-hoc signature (`--sign -`) makes the bundle internally consistent.
 * It does NOT make the app trusted: first launch still needs right-click →
 * Open, because ad-hoc signatures carry no identity to notarise. It only turns
 * an unopenable app into one the user can choose to open.
 *
 * The real fix is a Developer ID certificate plus notarisation. Until then this
 * keeps macOS installs working.
 */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // electron-builder already signed it if a certificate was found; re-signing
  // ad-hoc on top would throw that real identity away.
  if (context.packager.platformSpecificBuildOptions.identity) {
    console.log('  • real signing identity present — skipping ad-hoc signature');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  });

  // Fail the build rather than shipping a bundle that cannot open. A broken
  // signature is invisible until a user downloads it, so catch it here.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit'
  });
  console.log('  • ad-hoc signature verified');
};
