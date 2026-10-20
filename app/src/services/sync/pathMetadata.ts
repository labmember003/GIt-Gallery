/** Pure path metadata shared by native and browser galleries. */
export type ParsedPath = {
  captureDate: Date | null;
  width: number | null;
  height: number | null;
  identity: string | null;
};

const CANONICAL_RE =
  /gitgallery\/library\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})(?:_(\d+)x(\d+))?_([a-f0-9]+)\.[A-Za-z0-9]+$/;

/**
 * Recover date, dimensions and identity from a path.
 *
 * This is what makes a single tree listing sufficient: the timeline, the grid
 * layout and dedup all read from here rather than from any downloaded file.
 */
export function parseCanonicalPath(path: string): ParsedPath {
  const clean = path.endsWith('.ptr') ? path.slice(0, -4) : path;
  const m = clean.match(CANONICAL_RE);
  if (!m) return { captureDate: null, width: null, height: null, identity: null };

  const [, y, mo, d, hh, mi, ss, w, h, id] = m;
  return {
    captureDate: new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)),
    width: w ? Number(w) : null,
    height: h ? Number(h) : null,
    identity: id ?? null,
  };
}

export function isCanonicalPath(path: string): boolean {
  return parseCanonicalPath(path).identity !== null;
}
