import type {
  AskRequest,
  JsonValue,
  MappingRequest,
  SourceExcerpt,
} from "@/lib/llm/types";

const REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]";
const REDACTED_PROVIDER_KEY = "[REDACTED_PROVIDER_KEY]";
const REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]";
const REDACTED_DATABASE_URL = "[REDACTED_DATABASE_URL]";
const REDACTED_JWT = "[REDACTED_JWT]";
const REDACTED_SECRET = "[REDACTED_SECRET]";

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9][A-Z0-9 -]{0,40} )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9][A-Z0-9 -]{0,40} )?PRIVATE KEY-----|$)/gi;
const PGP_PRIVATE_KEY_PATTERN =
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/gi;
const PROVIDER_KEY_PATTERN =
  /(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_.*-]{6,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{20,}|(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,})(?=$|[^A-Za-z0-9_-])/g;
const JWT_PATTERN =
  /(^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})(?=$|[^A-Za-z0-9_-])/g;
const AUTHORIZATION_PATTERN =
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const DATABASE_URL_PATTERN =
  /\b((?:postgres(?:ql)?(?:\+[A-Za-z0-9_-]+)?|mysql(?:\+[A-Za-z0-9_-]+)?|mariadb|mongodb(?:\+srv)?|redis(?:s)?|mssql|sqlserver|oracle|cockroachdb|clickhouse|neo4j|snowflake):\/\/)[^\s"'`<>]+/gi;
const JDBC_URL_PATTERN =
  /\bjdbc:(?:postgresql|mysql|mariadb|sqlserver|oracle|h2|sqlite):[^\s"'`<>]+/gi;
const HTTP_USERINFO_PATTERN =
  /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const NAMED_SECRET_PATTERN =
  /((?:"|')?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|consumer[_-]?secret|webhook[_-]?secret|signing[_-]?secret|secret(?:[_-]?(?:key|token))?|token|password|passwd|pwd|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|database[_-]?url)(?:"|')?\s*(?:=>|[:=])\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]&]+)/gi;
const SECRET_XML_ELEMENT_PATTERN =
  /<(password|passwd|token|secret|api[_-]?key|client[_-]?secret)>[\s\S]*?<\/\1>/gi;

type UnknownRecord = Record<string, unknown>;
type CloneContainer = unknown[] | UnknownRecord;

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCloneContainer(value: unknown): value is CloneContainer {
  return Array.isArray(value) || isPlainRecord(value);
}

function defineEnumerable(
  target: UnknownRecord,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function uniqueRedactedKey(
  target: UnknownRecord,
  key: string,
  index: number,
): string {
  const redacted = redactSensitiveText(key);
  const base = redacted || "[REDACTED_KEY]";
  if (!Object.prototype.hasOwnProperty.call(target, base)) return base;

  let suffix = index;
  while (Object.prototype.hasOwnProperty.call(target, `${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

/**
 * Redact common credential shapes without depending on browser- or Node-only APIs.
 * The returned text is safe to display or include in a provider request, while the
 * input string is never mutated or retained by this module.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTED_PRIVATE_KEY)
    .replace(PGP_PRIVATE_KEY_PATTERN, REDACTED_PRIVATE_KEY)
    .replace(DATABASE_URL_PATTERN, (_match, scheme: string) =>
      `${scheme}${REDACTED_DATABASE_URL}`,
    )
    .replace(JDBC_URL_PATTERN, REDACTED_DATABASE_URL)
    .replace(HTTP_USERINFO_PATTERN, (_match, scheme: string) =>
      `${scheme}${REDACTED_CREDENTIAL}@`,
    )
    .replace(AUTHORIZATION_PATTERN, (_match, kind: string) =>
      `${kind} ${REDACTED_CREDENTIAL}`,
    )
    .replace(JWT_PATTERN, (_match, prefix: string) =>
      `${prefix}${REDACTED_JWT}`,
    )
    .replace(PROVIDER_KEY_PATTERN, (_match, prefix: string) =>
      `${prefix}${REDACTED_PROVIDER_KEY}`,
    )
    .replace(SECRET_XML_ELEMENT_PATTERN, (_match, tag: string) =>
      `<${tag}>${REDACTED_SECRET}</${tag}>`,
    )
    .replace(NAMED_SECRET_PATTERN, (_match, prefix: string) =>
      `${prefix}${REDACTED_SECRET}`,
    );
}

/**
 * Clone and recursively redact JSON-compatible data. The implementation is
 * iterative so deeply nested, size-bounded API input cannot overflow the stack.
 */
export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!isCloneContainer(value)) return value;

  const root: CloneContainer = Array.isArray(value) ? [] : {};
  const seen = new WeakMap<object, CloneContainer>();
  const pending: Array<{ source: CloneContainer; target: CloneContainer }> = [
    { source: value, target: root },
  ];
  seen.set(value, root);

  function cloneChild(child: unknown): unknown {
    if (typeof child === "string") return redactSensitiveText(child);
    if (!isCloneContainer(child)) return child;

    const known = seen.get(child);
    if (known) return known;

    const clone: CloneContainer = Array.isArray(child) ? [] : {};
    seen.set(child, clone);
    pending.push({ source: child, target: clone });
    return clone;
  }

  while (pending.length) {
    const current = pending.pop();
    if (!current) break;

    if (Array.isArray(current.source) && Array.isArray(current.target)) {
      current.target.length = current.source.length;
      for (let index = 0; index < current.source.length; index += 1) {
        current.target[index] = cloneChild(current.source[index]);
      }
      continue;
    }

    if (Array.isArray(current.source) || Array.isArray(current.target)) continue;
    const sourceRecord: UnknownRecord = current.source;
    const targetRecord: UnknownRecord = current.target;
    const entries = Object.entries(sourceRecord);
    entries.forEach(([key, child], index) => {
      const safeKey = uniqueRedactedKey(targetRecord, key, index);
      defineEnumerable(targetRecord, safeKey, cloneChild(child));
    });
  }

  return root as T;
}

const EVIDENCE_STRING_KEYS = [
  "id",
  "kind",
  "filePath",
  "excerpt",
  "description",
  "language",
] as const;
const EVIDENCE_NUMBER_KEYS = ["line", "endLine"] as const;

/**
 * Reduce a graph Evidence record to the fields needed for grounding. In
 * particular, the legacy `content`, `path`, and `startLine` aliases are never
 * copied, preventing a second unredacted copy of an excerpt from escaping.
 */
export function sanitizeEvidenceForLlm(
  value: unknown,
): Record<string, JsonValue> | null {
  if (!isPlainRecord(value)) return null;

  const sanitized: Record<string, JsonValue> = {};
  for (const key of EVIDENCE_STRING_KEYS) {
    if (typeof value[key] === "string") {
      sanitized[key] = redactSensitiveText(value[key]);
    }
  }
  for (const key of EVIDENCE_NUMBER_KEYS) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      sanitized[key] = value[key];
    }
  }
  return sanitized;
}

function sanitizeEvidenceCollections(root: unknown): void {
  if (!isCloneContainer(root)) return;

  const pending: CloneContainer[] = [root];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (isCloneContainer(item)) pending.push(item);
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (key === "evidence" && Array.isArray(child)) {
        const evidence = child.flatMap((item) => {
          const sanitized = sanitizeEvidenceForLlm(item);
          return sanitized ? [sanitized] : [];
        });
        defineEnumerable(current, key, evidence);
      } else if (isCloneContainer(child)) {
        pending.push(child);
      }
    }
  }
}

/** Redact a compact graph and allow-list every nested `evidence` collection. */
export function sanitizeGraphForLlm(
  graph: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const sanitized = redactSensitiveValue(graph);
  sanitizeEvidenceCollections(sanitized);
  return sanitized;
}

/** Redact excerpts while retaining their line ranges and grounding IDs. */
export function sanitizeSourceExcerptsForLlm(
  excerpts: SourceExcerpt[],
): SourceExcerpt[] {
  return excerpts.map((excerpt) => ({
    id: redactSensitiveText(excerpt.id),
    path: redactSensitiveText(excerpt.path),
    language: redactSensitiveText(excerpt.language),
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
    content: redactSensitiveText(excerpt.content),
  }));
}

/**
 * First-pass sanitizer for untrusted JSON before schema validation. This keeps
 * validation errors from reflecting a credential-shaped ID or path.
 */
export function sanitizeIncomingLlmPayload(value: unknown): unknown {
  const sanitized = redactSensitiveValue(value);
  if (!isPlainRecord(sanitized) || !isPlainRecord(sanitized.graph)) {
    return sanitized;
  }
  defineEnumerable(
    sanitized,
    "graph",
    sanitizeGraphForLlm(sanitized.graph as Record<string, JsonValue>),
  );
  return sanitized;
}

export function sanitizeAskRequestForLlm(request: AskRequest): AskRequest {
  return {
    question: redactSensitiveText(request.question),
    graph: sanitizeGraphForLlm(request.graph),
    evidence: sanitizeSourceExcerptsForLlm(request.evidence),
    conversation: request.conversation.map((turn) => ({
      role: turn.role,
      content: redactSensitiveText(turn.content),
    })),
  };
}

export function sanitizeMappingRequestForLlm(
  request: MappingRequest,
): MappingRequest {
  return {
    graph: sanitizeGraphForLlm(request.graph),
    excerpts: sanitizeSourceExcerptsForLlm(request.excerpts),
    focus:
      request.focus === null ? null : redactSensitiveText(request.focus),
  };
}
