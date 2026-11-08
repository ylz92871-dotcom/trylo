import { contentHashOf } from "../../../../../control/hash.js";
import { createHash } from "node:crypto";
import { err } from "../../../../../../tooling/contract/result.js";
import { recordOf } from "../../domain/evolution/parse.js";
import { decodeToolInspectionRequest, MAX_TOOL_RESEARCH_TEXT, type ToolInspectionReport, type ToolInspectionRequest, type ToolResearchDocument, type ToolResearchDocumentBasis } from "../../domain/evolution/research.js";
import { isNpmSha512Integrity, npmRegistryArchiveUrl } from "../../../../../../tooling/contract/npm-source.js";
import { guardedGet } from "./guarded-get.js";
import { createHttpsTransport, type HttpTransport } from "./transport.js";

const RESPONSE_BYTES = 512 * 1024;

/** At most two public metadata GETs per inspection. Never fetch archives, write files or execute source. */
export function createToolResearchService(options: { readonly transport?: HttpTransport } = {}) {
  const transport = options.transport ?? createHttpsTransport();
  return { inspect: async (raw: ToolInspectionRequest, signal: AbortSignal): Promise<ToolInspectionReport> => {
    const request = decodeToolInspectionRequest(raw);
    if (request === undefined) return { status: "failed", candidate: raw.candidate, documents: [], code: "invalid_inspection_request" };

    const fail = (code: string): ToolInspectionReport => ({ status: "failed", candidate: request.candidate, documents: [], code });

    if (signal.aborted) return fail("cancelled");

    try {
      if (request.candidate.platform === "github") {
        const result = await githubDocument(transport, request.candidate.id, request.candidate.version, request.path, signal);
        return "code" in result ? fail(result.code) : { status: "complete", candidate: request.candidate, documents: [result] };
      }

      const url = `https://registry.npmjs.org/${encodeURIComponent(request.candidate.id)}/${encodeURIComponent(request.candidate.version!)}`;
      const manifest = await readJson(transport, url, signal);
      if (!manifest.ok) return fail(manifest.code);

      if (!recordOf(manifest.value) || manifest.value.name !== request.candidate.id || manifest.value.version !== request.candidate.version) return fail("inspection_version_mismatch");

      const exact = manifest.value;
      const fields = ["name", "version", "description", "bin", "main", "module", "types", "exports", "engines", "os", "cpu", "repository", "gitHead", "license", "dependencies", "peerDependencies"];
      const dist = recordOf(exact.dist) ? { tarball: exact.dist.tarball, integrity: exact.dist.integrity } : undefined;
      const text = JSON.stringify({ ...Object.fromEntries(fields.filter(key => exact[key] !== undefined).map(key => [key, exact[key]])),
        ...(dist === undefined ? {} : { dist }) }, null, 2);
      const packageSubject = { name: request.candidate.id, version: request.candidate.version! };
      const archiveClaim = dist?.tarball === npmRegistryArchiveUrl(packageSubject.name, packageSubject.version) && isNpmSha512Integrity(dist.integrity)
        ? { archiveUrl: dist.tarball, integrity: dist.integrity } : undefined;
      const metadata = document(url, "package.json", "metadata", text, request.candidate.version, false,
        { kind: "registry_version_metadata", package: packageSubject, ...(archiveClaim === undefined ? {} : { archiveClaim }) });

      if (request.path === undefined || request.path === "package.json") return { status: "complete", candidate: request.candidate, documents: [metadata] };

      const repository = githubRepository(exact.repository);
      const commit = exact.gitHead;

      // A default-branch README must never masquerade as documentation of the pinned npm bytes.
      if (repository === undefined || typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) return fail("inspection_revision_unavailable");

      const relative = [repository.directory, request.path].filter(Boolean).join("/");
      const source = await githubDocument(transport, repository.id, commit, relative, signal, packageSubject);

      return "code" in source ? fail(source.code) : { status: "complete", candidate: request.candidate, documents: [metadata, source] };
    } catch {
      // Transport/JSON contracts may be violated by an injected host; private network text is never archived.
      return fail(signal.aborted ? "cancelled" : "inspection_service_failed");
    }
  } };
}

async function githubDocument(transport: HttpTransport, id: string, revision: string | undefined, path: string | undefined, signal: AbortSignal,
  npmPackage?: { readonly name: string; readonly version: string }): Promise<ToolResearchDocument | { readonly code: string }> {
  const endpoint = path === undefined ? "readme" : `contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const url = new URL(`https://api.github.com/repos/${id}/${endpoint}`);

  if (revision !== undefined) url.searchParams.set("ref", revision);

  const response = await readJson(transport, url.toString(), signal);
  if (!response.ok) return response;

  const value = response.value;
  const basis: Extract<ToolResearchDocumentBasis, { readonly kind: "repository_reference" }> = { kind: "repository_reference", repository: id,
    refKind: revision === undefined ? "default_branch" : /^[a-f0-9]{40}$/u.test(revision) ? "commit" : "mutable_ref",
    ...(revision === undefined ? {} : { requestedRef: revision }),
    ...(npmPackage === undefined ? {} : { npmLink: { package: npmPackage, relationship: "publisher_claimed_gitHead" } }) };

  if (Array.isArray(value)) {
    const entries = value.slice(0, 128).flatMap(item => recordOf(item) && typeof item.path === "string"
      && typeof item.type === "string" ? [{ path: item.path, type: item.type }] : []);
    if (entries.length === 0) return { code: "inspection_empty_directory" };
    return document(url.toString(), path || "(repository root)", "directory", JSON.stringify(entries), revision, value.length > entries.length, basis);
  }

  if (!recordOf(value) || value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string"
    || typeof value.path !== "string" || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.sha)) return { code: "inspection_content_unavailable" };

  const encoded = value.content.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) return { code: "inspection_content_malformed" };

  const bytes = Buffer.from(encoded, "base64");
  if (Buffer.from(bytes).toString("base64") !== encoded || path !== undefined && value.path !== path) return { code: "inspection_content_mismatch" };

  const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blobSha !== value.sha) return { code: "inspection_blob_mismatch" };

  if (bytes.includes(0)) return { code: "inspection_binary_refused" };

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.trim().length === 0) return { code: "inspection_empty_content" };

  return document(url.toString(), value.path, /(?:^|\/)(?:readme|license|changelog|.*\.(?:md|rst|txt))$/iu.test(value.path) ? "documentation" : "source", text, value.sha,
    false, { ...basis, blobSha });
}

function document(sourceUrl: string, path: string, kind: ToolResearchDocument["kind"], text: string, revision?: string, alreadyTruncated = false,
  basis?: ToolResearchDocumentBasis): ToolResearchDocument {
  return { sourceUrl, path, kind, contentHash: contentHashOf(text), text: text.slice(0, MAX_TOOL_RESEARCH_TEXT),
    truncated: alreadyTruncated || text.length > MAX_TOOL_RESEARCH_TEXT, contentHashBasis: "canonical_rendered_text",
    ...(basis === undefined ? {} : { basis }), ...(revision === undefined ? {} : { revision }) };
}

async function readJson(transport: HttpTransport, url: string, signal: AbortSignal) {
  const apiOnly: HttpTransport = { get: request => request.url === url ? transport.get(request)
    : Promise.resolve(err("network_failure", "research does not follow endpoint redirects")) };
  const response = await guardedGet(apiOnly, url, RESPONSE_BYTES, signal);
  if (!response.ok) return { ok: false as const, code: response.code };

  // API redirects must remain API reads; archives/raw download hosts are not a research fallback.
  if (!["api.github.com", "registry.npmjs.org"].includes(new URL(response.value.url).hostname)) return { ok: false as const, code: "inspection_redirect_refused" };

  try { return { ok: true as const, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.value.body)) as unknown }; }
  catch { return { ok: false as const, code: "inspection_not_json" }; }
}

function githubRepository(raw: unknown): { readonly id: string; readonly directory?: string } | undefined {
  const declared = typeof raw === "string" ? raw : recordOf(raw) && typeof raw.url === "string" ? raw.url : undefined;
  if (declared === undefined) return undefined;

  const match = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(declared);
  if (match?.[1] === undefined) return undefined;

  const directory = recordOf(raw) ? raw.directory : undefined;
  if (directory !== undefined && (typeof directory !== "string" || directory.length > 256
    || /[\\\u0000-\u0020?#:%]/u.test(directory) || directory.startsWith("/") || directory.split("/").some(part => part === "." || part === ".."))) return undefined;

  return { id: match[1], ...(directory === undefined ? {} : { directory }) };
}
