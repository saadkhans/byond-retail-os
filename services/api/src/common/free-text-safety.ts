/**
 * NO-SOURCE/NO-PATH screen (Codex P1), shared by every CV module that
 * accepts operator free text: the sensitive-text predicate
 * (video-ingest/media-safety) catches credentials, but a note could
 * still persist a camera URL or a local media path — violating the
 * no-source contract the moment it is echoed back. Rejects URLs of ANY
 * scheme (rtsp/rtsps/http/file/…), absolute Unix paths, Windows drive
 * paths, UNC paths, and obvious media filenames.
 *
 * Extracted verbatim from the Phase 16 cv-test-protocol service so the
 * Phase 17 calibration module screens with the SAME predicate — one
 * definition, no drift.
 */
export function containsSourceOrPathText(value: string): boolean {
  return (
    // Any URI scheme (stream, http, file, s3, …) — scheme-agnostic.
    /[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    // Windows drive path (C:\… or C:/…).
    /\b[a-z]:[\\/]/i.test(value) ||
    // Any backslash separator (UNC, drive-less, and relative Windows
    // paths alike — backslashes have no place in operator prose).
    /\\/.test(value) ||
    // Absolute Unix path at start or after whitespace/punctuation.
    /(?:^|[\s"'(=])\/(?:[\w.-]+\/)*[\w.-]+/.test(value) ||
    // Relative / home-relative prefixes (./x, ../x, ~/x).
    /(?:^|[\s"'(=])(?:\.{1,2}|~)\//.test(value) ||
    // Obvious media/stream filenames anywhere.
    /\.(mp4|mov|avi|mkv|webm|m3u8|mts|png|jpe?g|bmp|gif)\b/i.test(value) ||
    // EVERY compact slash/backslash-separated token, with NO character-
    // class restriction on the segments (Codex P1): a path segment can
    // be any non-whitespace text — Unicode directories, @-scoped names,
    // accented words — so ASCII-only \w would let tokens like Unicode
    // folder pairs straight through. Any separator with non-whitespace
    // on both sides rejects; this module's no-source/no-path contract
    // outweighs prose pairs — write "pass or fail", not "pass/fail".
    /[^\s\\/]+[\\/][^\s\\/]+/.test(value)
  );
}
