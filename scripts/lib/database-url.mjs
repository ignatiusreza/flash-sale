/**
 * The database for an environment: a URL that names one is taken as it is; one
 * that does not gets `flashsale_<appEnv>`.
 *
 * So the URL says where Postgres is and who connects, and the environment
 * decides which database — the same split the RabbitMQ queue names make —
 * unless the URL deliberately names one. Any query string, such as `sslmode`,
 * is kept either way.
 *
 * Dependency-free plain JavaScript because the dev and E2E scripts need it
 * before anything has been built, and the test setup needs it too.
 */
export function databaseUrlFor(url, appEnv) {
  const parsed = new URL(url);
  // A URL without a path has pathname "" here, one ending in "/" has "/".
  if (parsed.pathname.replace(/^\//, '') !== '') return url;
  parsed.pathname = `/flashsale_${appEnv}`;
  return parsed.toString();
}
