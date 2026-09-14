import { readFileSync } from 'node:fs';
import { launchService } from './server/launcher.mjs';
import { redact } from './core/util.mjs';

// Windows PowerShell 5.1 decodes native stdout using the console code page.
// ASCII JSON escapes keep localized messages and paths intact on any code page.
const print = value => process.stdout.write(JSON.stringify(value).replace(/[^\x00-\x7f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');

// The Windows launcher passes argv in a temporary JSON file. This preserves
// spaces, Unicode and trailing backslashes without shell command construction.
try {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  print(await launchService(request));
} catch (error) {
  print({ ok: false, error: redact(error.message, 2000) });
  process.exitCode = 1;
}
