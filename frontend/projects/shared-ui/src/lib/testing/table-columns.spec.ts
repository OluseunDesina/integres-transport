import { expectColumnVisibilityParity } from './table-columns';

/**
 * The guard is only worth having if it actually fails on the shape it
 * exists to catch, so each case below is a real mis-pairing rather than
 * a smoke test.
 */
function render(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

const MATCHING = `
  <table>
    <thead>
      <tr><th>Name</th><th class="hidden md:table-cell">Code</th><th>Status</th></tr>
    </thead>
    <tbody>
      <tr><td>Lagos</td><td class="hidden md:table-cell">LAG</td><td>Active</td></tr>
      <tr><td>Lekki</td><td class="hidden md:table-cell">LEK</td><td>Inactive</td></tr>
    </tbody>
  </table>
`;

describe('expectColumnVisibilityParity', () => {
  it('passes when every header and cell agree', () => {
    expect(() => expectColumnVisibilityParity(render(MATCHING), 'routes')).not.toThrow();
  });

  it('fails when a header hides a column its cells still render', () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th class="hidden md:table-cell">Code</th></tr></thead>
        <tbody><tr><td>Lagos</td><td>LAG</td></tr></tbody>
      </table>
    `;

    expect(() => expectColumnVisibilityParity(render(html), 'routes')).toThrowError(
      /column 1 \("Code"\)/,
    );
  });

  it('fails when the skeleton row forgets what the data row hides', () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th class="hidden lg:table-cell">Code</th></tr></thead>
        <tbody>
          <tr><td>Lagos</td><td class="hidden lg:table-cell">LAG</td></tr>
          <tr><td>skeleton</td><td>skeleton</td></tr>
        </tbody>
      </table>
    `;

    expect(() => expectColumnVisibilityParity(render(html), 'routes')).toThrowError(/row 1/);
  });

  it('fails when a row has a different number of cells than the header', () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Code</th></tr></thead>
        <tbody><tr><td>Lagos</td></tr></tbody>
      </table>
    `;

    expect(() => expectColumnVisibilityParity(render(html), 'routes')).toThrowError(
      /1 cells but the header has 2/,
    );
  });

  it('ignores classes that do not affect visibility', () => {
    const html = `
      <table>
        <thead><tr><th class="px-4 py-2 uppercase">Name</th></tr></thead>
        <tbody><tr><td class="px-4 py-3 font-medium">Lagos</td></tr></tbody>
      </table>
    `;

    expect(() => expectColumnVisibilityParity(render(html), 'routes')).not.toThrow();
  });

  it('skips a spanned message row, which has no columns to align', () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th class="hidden md:table-cell">Code</th></tr></thead>
        <tbody><tr><td colspan="2">No results.</td></tr></tbody>
      </table>
    `;

    expect(() => expectColumnVisibilityParity(render(html), 'routes')).not.toThrow();
  });

  // A guard that quietly checks nothing is worse than no guard: a spec
  // could be pointed at a fixture whose table never rendered (an error
  // branch, an empty state) and go on passing forever.
  it('fails when the fixture rendered no table at all', () => {
    expect(() => expectColumnVisibilityParity(render('<p>No routes yet</p>'), 'routes')).toThrowError(
      /found no <table>/,
    );
  });
});
