import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { createRequire } from 'module';
import path from 'path';

import Exporter from './exporter.js';
import createTemplate, { type TemplateOptions } from './template.js';

const require = createRequire(import.meta.url);
const locateFile = (file: string): string =>
  path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm')), file);

let sqlModulePromise: Promise<SqlJsStatic> | null = null;
const getSqlModule = (): Promise<SqlJsStatic> => {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs({ locateFile });
  }
  return sqlModulePromise;
};

export { Exporter };
export type { TemplateOptions };

export default async function AnkiExport(deckName: string, template?: TemplateOptions): Promise<Exporter> {
  const sqlModule = await getSqlModule();

  return new Exporter(deckName, {
    template: createTemplate(template),
    sql: sqlModule
  });
}
