/** Machine-readable CLI exit codes and stderr formatting (F6 contract). */
export const EXIT_CODES = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 2 });

export function formatCliError(error: any) {
  const code = error && error.code ? String(error.code) + ": " : "";
  const message = error && error.message ? String(error.message) : String(error);
  return code + message;
}
