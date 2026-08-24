# Search Indexing Privacy Design

**Date:** 2026-08-24

## Goal

Keep the baby album publicly reachable by people who know its address while asking
search engines not to crawl, index, archive, preview, or index its images. Preserve
Lighthouse SEO visibility without allowing an intentional privacy choice to fail the
automation by itself.

This design supersedes only the SEO gating decision in the production Lighthouse
audit design. Performance, accessibility, and best-practices thresholds remain
unchanged.

## Current Evidence

The first hosted Lighthouse run completed collection, summary generation, assertion,
and Artifact upload. It reported:

- performance: 75;
- accessibility: 100;
- best practices: 79, caused by HTTP and the lack of an HTTPS redirect;
- SEO: 83, caused by a missing meta description and an invalid `robots.txt`
  response.

Repository inspection confirms that `index.html` has no description or robots meta
directive and `public/robots.txt` does not exist. The server therefore likely serves
the SPA fallback HTML for `/robots.txt`, which Lighthouse cannot parse as a robots
file.

## Privacy Boundary

The site remains publicly accessible without a password. Search-engine directives
are advisory and are not access control. A person or crawler that knows the public
address can still request the page and its assets.

The selected policy is privacy-first discovery control:

- do not allow search-engine crawling;
- request that the page, snippets, cached copies, links, and images not be indexed;
- do not change server access, deployment, Nginx, GitHub Secrets, or repository
  visibility in this change.

True private access would require authentication or network access control and is a
separate project.

## Search Directives

`index.html` will add a generic description that introduces no additional personal
information:

```html
<meta name="description" content="记录宝宝成长瞬间的家庭纪念相册。" />
```

It will also add this page-level directive:

```html
<meta
  name="robots"
  content="noindex, nofollow, noarchive, nosnippet, noimageindex"
/>
```

`public/robots.txt` will contain exactly:

```text
User-agent: *
Disallow: /
```

The robots file prevents the current invalid-file diagnostic and clearly requests no
crawling. The HTML directive provides an additional no-index signal to agents that
still retrieve the page. Neither directive is presented as a security guarantee.

## Lighthouse Policy

The shared threshold objects in `scripts/lighthouse/thresholds.cjs` will gain an
`assertionLevel` field:

| Category | Target | Assertion level |
| --- | ---: | --- |
| Performance | 70 | `error` |
| Accessibility | 90 | `error` |
| Best practices | 90 | `error` |
| SEO | 90 | `warn` |

`lighthouserc.cjs` will continue to generate every assertion from this shared source.
SEO remains visible with a target of 90, but a score below the target produces an
LHCI warning rather than a failing exit status. The other three categories remain
release-independent quality gates.

The Markdown summary will use `目标分` rather than `最低分`. Results are:

- `通过` when the median reaches its target;
- `未通过` when an `error` category is below target;
- `提示` when a `warn` category is below target.

The current HTTP site will still fail the workflow because best practices is 79.
That failure remains intentional until HTTPS and the HTTP-to-HTTPS redirect are
configured. The SEO privacy choice alone will not make a future run red.

## Files

- Modify `index.html` with the description and robots directives.
- Create `public/robots.txt` with the deny-all crawl policy.
- Modify `scripts/lighthouse/thresholds.cjs` with assertion levels.
- Modify `lighthouserc.cjs` to use the shared level for each LHCI assertion.
- Modify `scripts/lighthouse/summarize-reports.mjs` to distinguish warnings from
  failures in the summary.
- Modify the related Lighthouse configuration, summary, and documentation tests.
- Create `scripts/seo-policy.test.ts` for the built search-policy contract.
- Modify `docs/lighthouse.md` to explain the privacy-first advisory SEO policy.

No deployment workflow, monitor workflow, server script, Nginx file, Secret, or
Environment setting changes are allowed.

## Testing

Test-first implementation will cover:

1. `index.html` contains one non-empty generic description and the exact robots meta
   directive.
2. `public/robots.txt` contains the exact deny-all policy.
3. `pnpm build` copies `robots.txt` into `dist` and preserves both HTML meta tags.
4. Shared thresholds use `error` for the three required categories and `warn` for
   SEO.
5. LHCI configuration generates a warning-level median SEO assertion while leaving
   the other three at error level.
6. A below-target SEO median is rendered as `提示`; a below-target required category
   remains `未通过`.
7. The beginner guide states that SEO is advisory for privacy, search directives are
   not access control, and HTTPS is still required for best practices.

Focused tests, the full Vitest suite, monitoring/deployment integrations, lint,
typecheck, build, frozen lock installation, and diff/scope checks must pass before
release.

## Release And Verification

This changes built site content, so it is released through the existing Tag workflow.
After deployment:

1. confirm `/robots.txt` returns plain text with the deny-all policy rather than the
   SPA HTML;
2. confirm the deployed HTML contains the description and robots directives;
3. manually run `生产站点 Lighthouse 检查` on `main`;
4. verify SEO remains visible as an advisory result;
5. do not lower the best-practices target to hide the remaining HTTP failure.

HTTPS configuration remains the next independent infrastructure task.
