/*
 * The format constants the write path and the read path have to agree about.
 *
 * Neither of them owns this. `exporter.ts` knows one collection layout and is
 * strict about it, `collection.ts` takes two schemas and three package versions
 * and is not, and keeping those apart is the point of the split — so what they
 * share sits below both rather than in the stricter one, where the reader would
 * have to import the whole writer in order to read it.
 */

/*
 * Named rather than default, which is why the rule is waived here: this file
 * holds one constant today and is where the next shared one goes, so a default
 * export would have to be undone the moment there are two.
 */
/** Anki stores a note's fields as one string joined by this control character. */
// oxlint-disable-next-line import/prefer-default-export
export const FIELD_SEPARATOR = "\u001F";
