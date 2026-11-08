// Builds the live overlay's accessibility helper, src/main/live/helper/LiveHelper.cs, into
// resources/live-helper.exe with the C# compiler that ships inside Windows' .NET Framework,
// so no SDK is needed. On other platforms there is nothing to build: the overlay is Windows only.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'main', 'live', 'helper', 'LiveHelper.cs');
const output = join(root, 'resources', 'live-helper.exe');

if (process.platform !== 'win32') process.exit(0);

const framework = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = join(framework, 'csc.exe');
if (!existsSync(csc)) {
  console.error(`No C# compiler at ${csc}, so the live overlay helper was not built. The app runs without it.`);
  // A build for release must include it, or "Underline as you type" would quietly be missing.
  process.exit(process.env.CI ? 1 : 0);
}

if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) {
  console.log('live-helper.exe is up to date.');
  process.exit(0);
}

/** The framework keeps its WPF assemblies, which include UI Automation, in a folder of their own. */
const reference = (name) => {
  const wpf = join(framework, 'WPF', name);
  return `/r:${existsSync(wpf) ? wpf : join(framework, name)}`;
};

execFileSync(
  csc,
  [
    '/nologo',
    '/target:exe',
    '/optimize+',
    '/warn:4',
    `/out:${output}`,
    reference('UIAutomationClient.dll'),
    reference('UIAutomationTypes.dll'),
    reference('WindowsBase.dll'),
    reference('System.Web.Extensions.dll'),
    source,
  ],
  { stdio: 'inherit' },
);
console.log(`Built ${output}`);
