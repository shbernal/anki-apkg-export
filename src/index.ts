import { createRequire } from "node:module";
import path from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import Exporter from "./exporter.js";
import createTemplate, { type TemplateOptions } from "./template.js";

const require = createRequire(import.meta.url);
const locateFile = (file: string): string =>
  path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.wasm")), file);

let sqlModulePromise: Promise<SqlJsStatic> | null = null;
const getSqlModule = (): Promise<SqlJsStatic> => {
  sqlModulePromise ??= initSqlJs({ locateFile });
  return sqlModulePromise;
};

export { default as Exporter } from "./exporter.js";
export type { TemplateOptions } from "./template.js";

export default async function AnkiExport(
  deckName: string,
  template?: Readonly<TemplateOptions>,
): Promise<Exporter> {
  const sqlModule = await getSqlModule();

  return new Exporter(deckName, {
    template: createTemplate(template),
    sql: sqlModule,
  });
}
