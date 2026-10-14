// Builds the Windows Installer package (circle-desktop-<version>-windows-x64.msi) and its
// .sha256 from the folder scripts/package.mjs left in out/, with the WiX Toolset dotnet tool:
//   dotnet tool install --global wix --version <WIX_VERSION>
// Run it on Windows after `npm run package`. The parts that do not need Windows are exported
// for test/msi.test.ts.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// WiX 5 is the last release under the MS-RL licence alone; 6 and later add the Open Source
// Maintenance Fee terms. 5 already has <Files> harvesting.
export const WIX_VERSION = '5.0.2';
export const UI_EXTENSION = `WixToolset.UI.wixext/${WIX_VERSION}`;
export const ARCH = 'x64';

// The package source, written to Circle.wxs for `wix build`. It is kept here rather than in a
// .wxs file, which Prettier would read as JavaScript. The build passes:
//   -d Version=<x.y.z>       Circle's version from the root package.json
//   -d Icon=<path>           dist/assets/circle.ico
//   -bindpath App=<folder>   the packaged Circle-win32-x64 folder, installed whole
// The UpgradeCode is fixed for good: every Circle MSI carries it so that a newer one replaces
// the installed one; another code would install beside it. Nothing goes into %APPDATA%\Circle,
// the application's data folder, so removing Circle leaves it in place. The shortcut's ID is the
// one main.ts gives the application, so Windows ties its notifications and taskbar button to
// the Start menu entry. A shortcut that is not advertised needs a per-user registry key as its
// key path (ICE38, ICE43).
export const PACKAGE_SOURCE = String.raw`<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Package
    Name="Circle"
    Manufacturer="qingshanfeihu"
    Version="$(var.Version)"
    UpgradeCode="F63273EF-466F-4FC3-8D1D-7B09C48A5923"
    Scope="perMachine"
    InstallerVersion="500"
    Compressed="yes"
    Language="1033">
    <MajorUpgrade
      AllowSameVersionUpgrades="yes"
      DowngradeErrorMessage="A newer version of Circle is already installed." />
    <MediaTemplate EmbedCab="yes" />

    <Icon Id="circle.ico" SourceFile="$(var.Icon)" />
    <Property Id="ARPPRODUCTICON" Value="circle.ico" />
    <Property Id="ARPURLINFOABOUT" Value="https://github.com/circle-platforms/circle" />

    <ui:WixUI Id="WixUI_Minimal" />
    <WixVariable Id="WixUILicenseRtf" Value="$(var.License)" />
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="launch Circle" />
    <UI>
      <Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchCircle" Order="1" Condition="NOT Installed AND WIXUI_EXITDIALOGOPTIONALCHECKBOX=1" />
    </UI>
    <CustomAction Id="LaunchCircle" Directory="INSTALLFOLDER" ExeCommand="&quot;[INSTALLFOLDER]Circle.exe&quot;" Return="asyncNoWait" Impersonate="yes" />

    <!-- 卸载注册信息 -->
    <Property Id="ARPCONTACT" Value="qingshanfeihu" />
    <Property Id="ARPHELPLINK" Value="https://github.com/circle-platforms/circle/issues" />
    <Property Id="ARPURLUPDATEINFO" Value="https://github.com/circle-platforms/circle/releases" />
    <Property Id="ARPNOREPAIR" Value="1" />
    <!-- Restart Manager stays out of installing and removing Circle, and out of removing this
         version when a newer one replaces it, which takes this package's value. On GitHub's
         Windows runners a machine whose installs went through it stopped answering now and
         then (issue 45). The updater waits for Circle to end before the installer runs. -->
    <Property Id="MSIRESTARTMANAGERCONTROL" Value="Disable" />

    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Circle" />
    </StandardDirectory>

    <StandardDirectory Id="ProgramMenuFolder">
      <Component Id="StartMenuShortcut">
        <Shortcut
          Id="CircleShortcut"
          Name="Circle"
          Target="[INSTALLFOLDER]Circle.exe"
          WorkingDirectory="INSTALLFOLDER">
          <ShortcutProperty Key="System.AppUserModel.ID" Value="com.qingshanfeihu.circle" />
        </Shortcut>
        <RegistryValue
          Root="HKCU"
          Key="Software\qingshanfeihu\Circle"
          Name="StartMenuShortcut"
          Type="integer"
          Value="1"
          KeyPath="yes" />
      </Component>
    </StandardDirectory>

    <Feature Id="Main" Title="Circle">
      <Files Directory="INSTALLFOLDER" Include="!(bindpath.App)\**" />
      <ComponentRef Id="StartMenuShortcut" />
    </Feature>
  </Package>
</Wix>
`;

type Artifact = { path: string; sha256: string };
type Receipt = {
  version: string;
  platform: string;
  arch: string;
  artifacts: Artifact[];
  [key: string]: unknown;
};

/** The version as Windows Installer takes it: three numbers, at most 255.255.65535. */
export function msiVersion(version: string): string {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    .exec(version)
    ?.slice(1);
  if (!parts)
    throw new Error(
      `an MSI version is three numbers, x.y.z; ${JSON.stringify(version)} is not, ` +
        'and a prerelease or build suffix cannot go into one',
    );
  const [major, minor, build] = parts.map(Number) as [number, number, number];
  if (major > 255 || minor > 255 || build > 65535)
    throw new Error(
      `an MSI version is at most 255.255.65535; ${version} is larger`,
    );
  return version;
}

export function msiName(version: string): string {
  return `circle-desktop-${version}-windows-${ARCH}.msi`;
}

/** The `.sha256` file beside each release file, in the form `sha256sum --check` reads. */
export function checksumLine(sha256: string, name: string): string {
  return `${sha256}  ${name}\n`;
}

export function refuseOtherHosts(platform: string): void {
  if (platform !== 'win32')
    throw new Error(
      `the MSI is built on Windows, with the WiX Toolset ${WIX_VERSION}; this host is ${platform}`,
    );
}

/** Checks the first line `wix --version` prints, such as `5.0.2+aa65968c`. */
export function checkWixVersion(output: string): void {
  const found = /^(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
  if (found !== WIX_VERSION)
    throw new Error(
      `the MSI is built with WiX ${WIX_VERSION}, but wix --version says ${JSON.stringify(output.trim())}; ` +
        `run dotnet tool install --global wix --version ${WIX_VERSION}`,
    );
}

export function wixBuildArgs(options: {
  wxs: string;
  app: string;
  icon: string;
  license: string;
  version: string;
  output: string;
  work: string;
}): string[] {
  return [
    'build',
    options.wxs,
    '-arch',
    ARCH,
    '-ext',
    UI_EXTENSION,
    '-d',
    `Version=${msiVersion(options.version)}`,
    '-d',
    `Icon=${options.icon}`,
    '-d',
    `License=${options.license}`,
    '-bindpath',
    `App=${options.app}`,
    '-intermediatefolder',
    options.work,
    // Kept out of out/, where every circle-desktop-* file is a release file
    '-pdb',
    join(options.work, 'circle.wixpdb'),
    '-o',
    options.output,
  ];
}

/** The repository's license shown by WixUI, escaped as literal RTF text. */
export function licenseRtf(text: string): string {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\\{}\n\u0080-\uffff]/g, (character) => {
      if (character === '\n') return '\\par\n';
      if ('\\{}'.includes(character)) return '\\' + character;
      const value = character.charCodeAt(0);
      return `\\u${value > 32767 ? value - 65536 : value}?`;
    });
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\f0\\fs18\n${body}}`;
}

/** ICE validation, with the build's .wixpdb for source lines. */
export function wixValidateArgs(options: {
  msi: string;
  work: string;
}): string[] {
  return [
    'msi',
    'validate',
    '-intermediatefolder',
    options.work,
    '-pdb',
    join(options.work, 'circle.wixpdb'),
    options.msi,
  ];
}

/** The receipt package.mjs wrote, with the MSI listed once among its artifacts. */
export function withMsiArtifact(receipt: Receipt, artifact: Artifact): Receipt {
  return {
    ...receipt,
    artifacts: [
      ...receipt.artifacts.filter((entry) => entry.path !== artifact.path),
      artifact,
    ],
  };
}

function wix(args: string[]): string {
  console.log(`wix ${args.join(' ')}`);
  const result = spawnSync('wix', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error)
    throw new Error(
      `cannot run wix (${result.error.message}); ` +
        `install it with dotnet tool install --global wix --version ${WIX_VERSION}`,
    );
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0)
    throw new Error(
      `wix ${args[0]} failed with exit code ${result.status}:\n${output}`,
    );
  process.stdout.write(output);
  return output;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function present(path: string, what: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new Error(
      `${what} is missing: ${path}; run npm --prefix apps/desktop run package first`,
    );
  }
}

export async function buildMsi(): Promise<string> {
  refuseOtherHosts(process.platform);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outputRoot = process.env.CIRCLE_DESKTOP_OUTPUT_DIR ?? join(root, 'out');
  // test/update.mjs builds a newer one to update to, as package.mjs does
  const version =
    process.env.CIRCLE_DESKTOP_VERSION ??
    (
      JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
  msiVersion(version);
  const folder = `Circle-win32-${ARCH}`;
  const app = join(outputRoot, folder);
  const icon = join(root, 'dist/assets/circle.ico');
  const receiptPath = join(outputRoot, 'artifact-receipt.json');
  await present(join(app, 'Circle.exe'), 'the packaged application');
  await present(icon, 'the application icon');
  await present(receiptPath, 'the package receipt');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
  if (
    receipt.version !== version ||
    receipt.platform !== 'win32' ||
    receipt.arch !== ARCH
  )
    throw new Error(
      `out/ holds Circle ${receipt.version} for ${receipt.platform}-${receipt.arch}, ` +
        `not ${version} for win32-${ARCH}; package it again`,
    );
  // The installer must hold exactly what was packaged and tested
  const asar = `${folder}/resources/app.asar`;
  const packaged = receipt.artifacts.find((entry) => entry.path === asar);
  if (packaged?.sha256 !== (await sha256(join(app, 'resources/app.asar'))))
    throw new Error(
      `${asar} differs from the one package.mjs recorded; package it again`,
    );
  checkWixVersion(wix(['--version']));
  const name = msiName(version);
  const output = join(outputRoot, name);
  await rm(output, { force: true });
  await rm(`${output}.sha256`, { force: true });
  const work = await mkdtemp(join(tmpdir(), 'circle-msi-'));
  try {
    const wxs = join(work, 'Circle.wxs');
    const license = join(work, 'LICENSE.rtf');
    await writeFile(
      license,
      licenseRtf(await readFile(join(root, '../../LICENSE'), 'utf8')),
    );
    await writeFile(wxs, PACKAGE_SOURCE);
    wix(wixBuildArgs({ wxs, app, icon, license, version, output, work }));
    wix(wixValidateArgs({ msi: output, work }));
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const digest = await sha256(output);
  await writeFile(`${output}.sha256`, checksumLine(digest, name));
  await writeFile(
    receiptPath,
    JSON.stringify(
      withMsiArtifact(receipt, { path: name, sha256: digest }),
      null,
      2,
    ) + '\n',
  );
  console.log(output);
  return output;
}

if (import.meta.main) {
  try {
    await buildMsi();
  } catch (error) {
    console.error(
      `circle msi: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
