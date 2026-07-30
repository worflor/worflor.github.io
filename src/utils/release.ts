/*
 * build-time visibility probe for a github repository.
 *
 * the site makes claims about software that is not always reachable yet. neuron
 * is the case this was written for: the landing page is finished and good, the
 * repository behind it is private, there are no releases, and installing means
 * building from source. a "get it" button pointing at a 404 is the single
 * failure this file exists to prevent.
 *
 * the probe runs once per repository per build and never in the browser, so the
 * html ships already decided and nothing flickers into place on load.
 *
 * it fails closed, deliberately. a rate limit, a timeout, an offline build, a
 * renamed repository: every one of those answers "not public". being wrong in
 * that direction costs a visitor a few days of patience. being wrong in the
 * other direction costs the site the only thing it trades on, which is that
 * what it says about itself is true.
 */

const probes = new Map<string, Promise<boolean>>();

async function probe(repo: string): Promise<boolean> {
  // a token is optional. unauthenticated builds get github's 60-per-hour limit,
  // which one request per repository per build sits comfortably under, but ci
  // shares an address space with every other runner, so use the token when the
  // workflow already has one.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "woflo.dev-build",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      // 404 is the honest answer for a private repository seen by a stranger,
      // so it is not treated as an error worth shouting about.
      console.info(`[release] ${repo}: http ${res.status}, holding as not public`);
      return false;
    }

    const body = (await res.json()) as { private?: boolean };
    const open = body.private === false;
    console.info(`[release] ${repo}: ${open ? "public" : "private"}`);
    return open;
  } catch (error) {
    const why = error instanceof Error ? error.name : "unknown error";
    console.info(`[release] ${repo}: unreachable (${why}), holding as not public`);
    return false;
  }
}

/**
 * is this repository publicly readable right now, as "owner/name".
 * memoised for the life of the build, so a repository named by several pages
 * still costs exactly one request.
 */
export function repoIsPublic(repo: string): Promise<boolean> {
  let asked = probes.get(repo);
  if (!asked) {
    asked = probe(repo);
    probes.set(repo, asked);
  }
  return asked;
}
