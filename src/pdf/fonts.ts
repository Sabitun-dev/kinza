import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cache: { regular: Uint8Array; bold: Uint8Array } | undefined;

/**
 * DejaVu Sans covers Uzbek Latin (O‘ G‘ ʼ) and Cyrillic. On Netlify the files are shipped with
 * the function via `included_files` in netlify.toml; the folder is found relative to the cwd.
 */
export function loadFonts() {
  if (cache) return cache;
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  const candidates = [
    join(process.cwd(), 'assets/fonts'),
    join(here, '../../assets/fonts'),
    join(here, 'assets/fonts'),
    '/var/task/assets/fonts',
  ];
  const dir = candidates.find((d) => existsSync(join(d, 'DejaVuSans.ttf')));
  if (!dir) throw new Error('PDF font not found (assets/fonts/DejaVuSans.ttf)');
  cache = {
    regular: readFileSync(join(dir, 'DejaVuSans.ttf')),
    bold: readFileSync(join(dir, 'DejaVuSans-Bold.ttf')),
  };
  return cache;
}
