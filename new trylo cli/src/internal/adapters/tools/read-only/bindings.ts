import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolBinding } from "../../../ports/tools.js";
import { DEFAULT_READ_ONLY_LIMITS } from "./limits.js";

/**
 * Built-in schemas; optional B1 fields are projected out only for known session compatibility.
 *
 * `parallelSafe: true` is declared here and nowhere else in this directory's
 * siblings on purpose (WP22.1): these eight tools read bytes and answer, and two
 * of them running at once cannot observe each other. Tools that talk to a
 * person, a server, or the same file from both ends are left undeclared and
 * therefore exclusive — an undeclared tool is the conservative default, not an
 * oversight.
 */
function bindingFor(name: string, description: string, parameters: JsonObject): ToolBinding {
  return { name, description, parameters, sideEffect: "read_only", parallelSafe: true, needsApproval: false,
    timeoutMs: 10_000,
    outputLimits: { maxBytes: DEFAULT_READ_ONLY_LIMITS.maxBytes + (name === "read_file" ? 512 : 0), maxLines: DEFAULT_READ_ONLY_LIMITS.maxLines },
  };
}
const filters = {
  include: { type: "array", items: { type: "string" }, description: "Only consider these workspace-relative globs, e.g. src/**/*.ts. Nonmatching files do not spend the content scan budget." },
  exclude: { type: "array", items: { type: "string" }, description: "Exclude these workspace-relative globs." },
};

export const READ_ONLY_BINDINGS: ReadonlyArray<ToolBinding> = [
  bindingFor("read_file",
    "Read UTF-8 text inside the workspace. Default: first 2000 lines within 64 KiB. offset is a 0-based index in LINES, limit is a line count. " +
    "The output starts with positioning metadata, followed by exact source text and a separate local-rules appendix. content in the structured result stays pure source text. " +
    "startLine/endLine are 1-based inclusive; zero denotes no returned lines. Pass nextOffset back unchanged as offset to continue, never add 1. " +
    "The legacy default may end with a partial line; the continuation rereads that line. Explicit ranges return complete ordinary lines. lineTooLong marks an incomplete oversized line with no byte paging.",
    { type: "object", properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 0, description: "0-based first line to return; offset 0 is line 1. Defaults to 0 (the top of the file). Pass a previous reply's nextOffset back unchanged to continue." },
      limit: { type: "integer", minimum: 1, description: "How many lines to return from offset. Defaults to as many as the size limit allows." },
    }, required: ["path"] }),
  bindingFor("list_files",
    "List one directory level as workspace-relative paths ready for read_file; directories end with /. Local .gitignore and default exclusions .git/node_modules/dist apply; hidden counts are reported.",
    { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative directory to list. Defaults to the workspace root." },
    }, required: [] }),
  bindingFor("search_text",
    "Search file content line by line; path accepts a file or directory. Default literal text; set mode to regex explicitly for JavaScript RegExp syntax such as alternation or anchors. Regex runs in a cancellable worker with a 250 ms per-file budget; regex_timeout means simplify the pattern or use literal mode. Narrow path to a module and include to relevant file types first. include/exclude are workspace-relative globs. Local .gitignore applies. By default files above 1 MiB and NUL-containing binary content are skipped with counts and incomplete reasons. Long lines show a snippet around the first match and report textStartColumn (1-based UTF-16 units) and lineTruncated. Output uses workspace-relative path:line:text ready for read_file.",
    { type: "object", properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Workspace-relative directory to search. Defaults to the workspace root." },
      mode: { type: "string", enum: ["literal", "regex"], description: 'Matching mode. Defaults to "literal".' },
      ignoreCase: { type: "boolean", description: "Case-insensitive matching in either mode." },
      ...filters,
    }, required: ["pattern"] }),
  bindingFor("glob_files",
    "Find files by glob pattern (*, **, ?, {a,b}, [a-z]); no slash matches basenames at any depth. path accepts a directory or one existing file. pattern is relative to path (the basename for a single file); include/exclude are workspace-relative. Local .gitignore and default exclusions apply. Output paths are workspace-relative ready for read_file; structured matches retain the old search-root-relative view.",
    { type: "object", properties: {
      pattern: { type: "string", description: 'Glob pattern, e.g. "*.ts" or "src/**/*.test.ts".' },
      path: { type: "string", description: "Workspace-relative directory to search from. Defaults to the workspace root." },
      ...filters,
    }, required: ["pattern"] }),
  bindingFor("find_files",
    "Find files by approximate name when you do not know the exact path or glob. query is matched against the whole workspace-relative path; it is NOT a content search and NOT a glob (use search_text or glob_files for those). A lowercase query ignores case; any uppercase letter makes it case-sensitive. Local .gitignore and default exclusions apply. Returns paths ready for read_file, best match first; when the index is incomplete the result says so rather than implying no such file exists.",
    { type: "object", properties: {
      query: { type: "string", description: "Approximate file name or path fragment, e.g. \"mention\", \"nav-view\", \"ports/tools\"." },
      limit: { type: "integer", minimum: 1, description: "How many matches to return. Defaults to 20." },
    }, required: ["query"] }),
  // WP19.1 (C25/L10): local image viewing. Text result is a redacted summary;
  // the payload travels in the structured value for the request layer.
  bindingFor("view_image",
    "View a local image file inside the workspace so a vision-capable model can see it. Only png, jpg, jpeg, gif and webp are accepted, at most 3932160 raw bytes; anything else refuses with a named code instead of a guess. detail is high by default; original spends the full patch budget and needs a model that honours it (run-layer catalog demand, pending — undeclared runs pass through today). Any other value is refused. The text result is a redacted summary; the full data URL travels in the structured result for the request layer to attach to the wire, never as a path string pretending to be the image.",
    { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative image path, e.g. \"assets/photo.png\"." },
      detail: { type: "string", enum: ["high", "original"], description: "How much of the image the model may spend budget on. Defaults to high." },
    }, required: ["path"] }),
  // WP13.1 (L11): PDF metadata and page ranges. The text result is a redacted
  // summary; the document payload travels in the structured value for the
  // provider wire (WP18聯验). Page rendering needs poppler on the machine and
  // refuses with `unavailable` without it — never invented page counts.
  bindingFor("read_pdf",
    "Read a PDF file inside the workspace. Without pages: validates the document and returns its size, measured page count when poppler is installed (unknown otherwise), and the payload for the provider wire. With pages (e.g. \"1-5\", \"3\", \"3-\"): renders at most 20 pages per read; open-ended ranges need a measured page count and out-of-document ranges refuse. Files above the size ceilings, non-PDF bytes, and password-protected documents refuse with named codes.",
    { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative PDF path, e.g. \"docs/spec.pdf\"." },
      pages: { type: "string", description: "Page range to render, e.g. \"1-5\", \"3\", or \"3-\". Pages are 1-indexed; at most 20 per read." },
    }, required: ["path"] }),
  // WP13.2 (L12): cell-aware notebook reads. Whole-notebook reads must fit the
  // byte ceiling or refuse with a cell_id resume hint; single-cell reads
  // include large outputs. Malformed notebooks refuse as invalid_notebook.
  bindingFor("read_notebook",
    "Read a Jupyter notebook (.ipynb) inside the workspace as cells, not raw JSON. Returns cell ids, types, sources, and code outputs with metadata and untouched cells preserved. Omit cell_id for the whole notebook (refuses past the size ceiling — then read one cell at a time); pass cell_id for exactly one cell including its large outputs.",
    { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative notebook path, e.g. \"analysis/exp.ipynb\"." },
      cell_id: { type: "string", description: "Read exactly one cell by id. Omit for the whole notebook." },
    }, required: ["path"] }),
];
