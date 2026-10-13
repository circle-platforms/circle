import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCH,
  PACKAGE_SOURCE,
  UI_EXTENSION,
  WIX_VERSION,
  checkWixVersion,
  checksumLine,
  licenseRtf,
  msiName,
  msiVersion,
  refuseOtherHosts,
  withMsiArtifact,
  wixBuildArgs,
  wixValidateArgs,
} from '../scripts/msi.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repository = join(desktop, '../..');
// Every Circle MSI carries this code; a new one would install beside the old one
const UPGRADE_CODE = 'F63273EF-466F-4FC3-8D1D-7B09C48A5923';

type Element = {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
};

// Enough XML for the package source: elements and attributes, with no inner text.
function parseXml(source: string): Element {
  const body = source
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tag =
    /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"<]*")*)\s*(\/?)>/g;
  const top: Element = { name: '#document', attributes: {}, children: [] };
  const open = [top];
  let end = 0;
  for (const match of body.matchAll(tag)) {
    const text = body.slice(end, match.index).trim();
    assert.equal(text, '', `unexpected text before ${match[0]}`);
    end = match.index + match[0].length;
    const [, closing, name, attributeText, selfClosing] = match;
    const parent = open.at(-1)!;
    if (closing) {
      assert.equal(name, parent.name, `</${name}> closes <${parent.name}>`);
      open.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const [, key, value] of attributeText!.matchAll(
      /([\w.:-]+)\s*=\s*"([^"]*)"/g,
    )) {
      assert.equal(attributes[key!], undefined, `${name} repeats ${key}`);
      attributes[key!] = value!;
    }
    const element: Element = { name: name!, attributes, children: [] };
    parent.children.push(element);
    if (!selfClosing) open.push(element);
  }
  assert.equal(body.slice(end).trim(), '', 'unexpected text at the end');
  assert.equal(open.length, 1, `<${open.at(-1)!.name}> is not closed`);
  assert.equal(top.children.length, 1, 'one root element');
  return top.children[0]!;
}

function all(element: Element, name: string): Element[] {
  return element.children.flatMap((child) => [
    ...(child.name === name ? [child] : []),
    ...all(child, name),
  ]);
}

function only(element: Element, name: string): Element {
  const found = all(element, name);
  assert.equal(found.length, 1, `one <${name}> in <${element.name}>`);
  return found[0]!;
}

function directory(root: Element, id: string): Element {
  const found = all(root, 'StandardDirectory').filter(
    (element) => element.attributes.Id === id,
  );
  assert.equal(found.length, 1, `one StandardDirectory ${id}`);
  return found[0]!;
}

const source = PACKAGE_SOURCE;
const wix = parseXml(source);
const pkg = only(wix, 'Package');

test('the MSI version is three numbers within what Windows Installer takes', () => {
  for (const version of ['0.0.0', '1.1.1', '2.10.300', '255.255.65535'])
    assert.equal(msiVersion(version), version);
  for (const version of [
    '1.2.0-rc.1',
    '1.2.0-beta',
    '1.2.0+build.5',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '',
  ])
    assert.throws(() => msiVersion(version), /three numbers, x\.y\.z/);
  for (const version of ['256.0.0', '1.256.0', '1.0.65536'])
    assert.throws(() => msiVersion(version), /at most 255\.255\.65535/);
});

test('the version Circle carries now can go into an MSI', async () => {
  const { version } = JSON.parse(
    await readFile(join(repository, 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(msiVersion(version), version);
});

test('the package installs for all users and replaces older and same versions', () => {
  assert.equal(wix.name, 'Wix');
  assert.equal(wix.attributes.xmlns, 'http://wixtoolset.org/schemas/v4/wxs');
  assert.deepEqual(pkg.attributes, {
    Name: 'Circle',
    Manufacturer: 'qingshanfeihu',
    Version: '$(var.Version)',
    UpgradeCode: UPGRADE_CODE,
    Scope: 'perMachine',
    InstallerVersion: '500',
    Compressed: 'yes',
    Language: '1033',
  });
  const upgrade = only(pkg, 'MajorUpgrade');
  assert.match(upgrade.attributes.DowngradeErrorMessage ?? '', /newer version/);
  assert.equal(upgrade.attributes.AllowSameVersionUpgrades, 'yes');
  assert.equal(upgrade.attributes.AllowDowngrades, undefined);
  assert.equal(only(pkg, 'MediaTemplate').attributes.EmbedCab, 'yes');
  assert.equal(all(pkg, 'Media').length, 0);
});

test('the whole packaged folder goes to Program Files\\Circle', () => {
  const programFiles = directory(pkg, 'ProgramFiles64Folder');
  assert.deepEqual(
    programFiles.children.map((child) => [child.name, child.attributes]),
    [['Directory', { Id: 'INSTALLFOLDER', Name: 'Circle' }]],
  );
  const feature = only(pkg, 'Feature');
  const files = only(pkg, 'Files');
  assert.ok(feature.children.includes(files), 'the files belong to a feature');
  assert.deepEqual(files.attributes, {
    Directory: 'INSTALLFOLDER',
    Include: '!(bindpath.App)\\**',
  });
  assert.deepEqual(files.children, [], 'nothing is left out');
  // Every component is in the feature, or the build stops with an orphan
  const referenced = all(feature, 'ComponentRef').map(
    (element) => element.attributes.Id,
  );
  for (const component of all(pkg, 'Component'))
    assert.ok(referenced.includes(component.attributes.Id));
  // Nothing is installed into the data folder, so uninstalling leaves it
  for (const element of all(pkg, 'StandardDirectory'))
    assert.ok(
      ['ProgramFiles64Folder', 'ProgramMenuFolder'].includes(
        element.attributes.Id!,
      ),
      `${element.attributes.Id} is not installed into`,
    );
  assert.doesNotMatch(
    source,
    /AppDataFolder|LocalAppDataFolder|RemoveFolderEx/,
  );
});

test('the Start menu entry starts Circle.exe with the application user model ID', async () => {
  const menu = directory(pkg, 'ProgramMenuFolder');
  const component = only(menu, 'Component');
  const shortcut = only(component, 'Shortcut');
  assert.deepEqual(shortcut.attributes, {
    Id: 'CircleShortcut',
    Name: 'Circle',
    Target: '[INSTALLFOLDER]Circle.exe',
    WorkingDirectory: 'INSTALLFOLDER',
  });
  assert.deepEqual(
    shortcut.children.map((child) => [child.name, child.attributes]),
    [
      [
        'ShortcutProperty',
        { Key: 'System.AppUserModel.ID', Value: 'com.qingshanfeihu.circle' },
      ],
    ],
  );
  // The same ID the application gives itself on Windows and is packaged with
  const main = await readFile(join(desktop, 'src/main.ts'), 'utf8');
  assert.match(main, /setAppUserModelId\('com\.qingshanfeihu\.circle'\)/);
  const packageScript = await readFile(
    join(desktop, 'scripts/package.mjs'),
    'utf8',
  );
  assert.match(packageScript, /appBundleId: 'com\.qingshanfeihu\.circle'/);
  // A shortcut that is not advertised needs a per-user registry key path (ICE38, ICE43)
  const key = only(component, 'RegistryValue');
  assert.equal(key.attributes.Root, 'HKCU');
  assert.equal(key.attributes.KeyPath, 'yes');
});

test('Installed apps shows the icon and the project page', () => {
  const icon = only(pkg, 'Icon');
  assert.equal(icon.attributes.SourceFile, '$(var.Icon)');
  const properties = Object.fromEntries(
    all(pkg, 'Property').map((element) => [
      element.attributes.Id,
      element.attributes.Value,
    ]),
  );
  assert.equal(properties.ARPPRODUCTICON, icon.attributes.Id);
  assert.equal(
    properties.ARPURLINFOABOUT,
    'https://github.com/qingshanfeihu/circle',
  );
  assert.equal(properties.ARPCONTACT, 'qingshanfeihu');
  assert.equal(
    properties.ARPHELPLINK,
    'https://github.com/qingshanfeihu/circle/issues',
  );
  assert.equal(
    properties.ARPURLUPDATEINFO,
    'https://github.com/qingshanfeihu/circle/releases',
  );
  assert.equal(properties.ARPNOREPAIR, '1');
});

test('only the completion button can launch Circle, after an unchecked opt-in', () => {
  assert.equal(only(pkg, 'ui:WixUI').attributes.Id, 'WixUI_Minimal');
  assert.deepEqual(only(pkg, 'WixVariable').attributes, {
    Id: 'WixUILicenseRtf',
    Value: '$(var.License)',
  });
  const properties = Object.fromEntries(
    all(pkg, 'Property').map((item) => [
      item.attributes.Id,
      item.attributes.Value,
    ]),
  );
  assert.equal(
    properties.WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT,
    'launch Circle',
  );
  assert.equal(
    properties.WIXUI_EXITDIALOGOPTIONALCHECKBOX,
    undefined,
    'launch is unchecked until chosen',
  );
  const ui = only(pkg, 'UI');
  const publish = only(ui, 'Publish');
  assert.deepEqual(publish.attributes, {
    Dialog: 'ExitDialog',
    Control: 'Finish',
    Event: 'DoAction',
    Value: 'LaunchCircle',
    Order: '1',
    Condition: 'NOT Installed AND WIXUI_EXITDIALOGOPTIONALCHECKBOX=1',
  });
  const action = only(pkg, 'CustomAction');
  assert.deepEqual(action.attributes, {
    Id: 'LaunchCircle',
    Directory: 'INSTALLFOLDER',
    ExeCommand: '&quot;[INSTALLFOLDER]Circle.exe&quot;',
    Return: 'asyncNoWait',
    Impersonate: 'yes',
  });
  assert.equal(
    all(pkg, 'Custom').length,
    0,
    'quiet installs and updates cannot launch from an execute sequence',
  );
  assert.equal(all(pkg, 'InstallExecuteSequence').length, 0);
});

test('the actual license is literal RTF, including braces, slashes and non-ASCII text', () => {
  const result = licenseRtf('MIT License\r\n{\\中文}');
  assert.match(result, /^\{\\rtf1/);
  assert.ok(result.includes('MIT License\\par\n\\{\\\\\\u20013?\\u25991?\\}'));
  assert.ok(result.endsWith('}'));
});

test('wix build and wix msi validate get the pinned arguments', () => {
  const work = join('work', 'msi');
  const options = {
    wxs: join(work, 'Circle.wxs'),
    app: join('out', 'Circle-win32-x64'),
    icon: join('dist', 'assets', 'circle.ico'),
    license: join(work, 'LICENSE.rtf'),
    version: '1.2.3',
    output: join('out', msiName('1.2.3')),
    work,
  };
  const args = wixBuildArgs(options);
  assert.deepEqual(args, [
    'build',
    options.wxs,
    '-arch',
    'x64',
    '-ext',
    UI_EXTENSION,
    '-d',
    'Version=1.2.3',
    '-d',
    `Icon=${options.icon}`,
    '-d',
    `License=${options.license}`,
    '-bindpath',
    `App=${options.app}`,
    '-intermediatefolder',
    work,
    '-pdb',
    join(work, 'circle.wixpdb'),
    '-o',
    options.output,
  ]);
  assert.deepEqual(wixValidateArgs({ msi: options.output, work }), [
    'msi',
    'validate',
    '-intermediatefolder',
    work,
    '-pdb',
    join(work, 'circle.wixpdb'),
    options.output,
  ]);
  // Every variable and bind path the source uses is given, and nothing else
  const variables = (flag: string) =>
    args.flatMap((arg, index) =>
      args[index - 1] === flag ? [arg.split('=')[0]] : [],
    );
  assert.deepEqual(
    [...new Set([...source.matchAll(/\$\(var\.(\w+)\)/g)].map((m) => m[1]))],
    variables('-d'),
  );
  assert.deepEqual(
    [
      ...new Set(
        [...source.matchAll(/!\(bindpath\.(\w+)\)/g)].map((m) => m[1]),
      ),
    ],
    variables('-bindpath'),
  );
  assert.throws(
    () => wixBuildArgs({ ...options, version: '1.2.3-rc.1' }),
    /three numbers/,
  );
});

test('the MSI and its checksum are named like the other release files', () => {
  assert.equal(ARCH, 'x64');
  assert.equal(msiName('1.2.3'), 'circle-desktop-1.2.3-windows-x64.msi');
  assert.equal(
    checksumLine('ab'.repeat(32), msiName('1.2.3')),
    `${'ab'.repeat(32)}  circle-desktop-1.2.3-windows-x64.msi\n`,
  );
});

test('the receipt lists the MSI once', () => {
  const receipt = {
    builtAt: '2026-10-12T00:00:00.000Z',
    version: '1.2.3',
    electron: '44.7.0',
    platform: 'win32',
    arch: 'x64',
    artifacts: [
      { path: 'Circle-win32-x64/resources/app.asar', sha256: 'a' },
      { path: 'circle-desktop-1.2.3-windows-x64.zip', sha256: 'b' },
    ],
  };
  const once = withMsiArtifact(receipt, {
    path: msiName('1.2.3'),
    sha256: 'c',
  });
  const twice = withMsiArtifact(once, { path: msiName('1.2.3'), sha256: 'd' });
  assert.deepEqual(twice, {
    ...receipt,
    artifacts: [
      ...receipt.artifacts,
      { path: 'circle-desktop-1.2.3-windows-x64.msi', sha256: 'd' },
    ],
  });
  assert.equal(receipt.artifacts.length, 2);
});

test('only the pinned WiX builds the MSI', () => {
  checkWixVersion(
    `${WIX_VERSION}+aa65968c419420d32e3e1b647aea0082f5ca5b78\r\n`,
  );
  checkWixVersion(WIX_VERSION);
  for (const output of ['6.0.2+0000000', '5.0.1+0000000', '', 'wix'])
    assert.throws(() => checkWixVersion(output), /dotnet tool install/);
});

test('CI installs the WiX the script expects and builds the MSI', async () => {
  for (const workflow of ['release.yml', 'workbench.yml']) {
    const text = await readFile(
      join(repository, '.github/workflows', workflow),
      'utf8',
    );
    assert.ok(
      text.includes(
        `dotnet tool install --global wix --version ${WIX_VERSION}`,
      ),
      `${workflow} installs WiX ${WIX_VERSION}`,
    );
    assert.ok(
      text.includes(`extension add --global ${UI_EXTENSION}`),
      `${workflow} installs the pinned UI extension`,
    );
    assert.match(text, /npm --prefix apps\/desktop run package:msi/);
  }
  const manifest = JSON.parse(
    await readFile(join(desktop, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts['package:msi'], 'node scripts/msi.ts');
});

test('other hosts are refused before anything is written', async () => {
  refuseOtherHosts('win32');
  for (const platform of ['darwin', 'linux'])
    assert.throws(
      () => refuseOtherHosts(platform),
      new RegExp(`built on Windows.*this host is ${platform}`),
    );
});

test(
  'the script stops on this host without touching the output folder',
  { skip: process.platform === 'win32' && 'this host builds MSIs' },
  async () => {
    const output = await mkdtemp(join(tmpdir(), 'circle-msi-test-'));
    try {
      const result = spawnSync(
        process.execPath,
        [join(desktop, 'scripts/msi.ts')],
        {
          cwd: desktop,
          encoding: 'utf8',
          env: { ...process.env, CIRCLE_DESKTOP_OUTPUT_DIR: output },
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(
        result.stderr,
        new RegExp(
          `circle msi: the MSI is built on Windows, with the WiX Toolset ${WIX_VERSION.replaceAll('.', '\\.')}`,
        ),
      );
      assert.deepEqual(await readdir(output), []);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);
