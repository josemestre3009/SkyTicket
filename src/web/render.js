import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { helpers } from './format.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_VIEWS_DIR = path.resolve(here, '..', '..', 'views');
export const DEFAULT_PUBLIC_DIR = path.resolve(here, '..', '..', 'public');

export function createRenderer({ viewsDir = DEFAULT_VIEWS_DIR, cache = false } = {}) {
  async function renderView(view, locals = {}) {
    const filename = path.join(viewsDir, `${view}.ejs`);
    return ejs.renderFile(filename, locals, { cache, async: true });
  }

  async function renderPage(view, locals = {}) {
    const merged = { helpers, ...locals };
    const body = await renderView(view, merged);
    return ejs.renderFile(path.join(viewsDir, 'layout.ejs'), { ...merged, body }, { cache, async: true });
  }

  return { renderView, renderPage, viewsDir };
}

export default createRenderer;
