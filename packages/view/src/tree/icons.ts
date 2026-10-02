/**
 * Perk icon loading.
 *
 * 810 distinct textures across the three trees, drawn thousands of times a second while
 * panning, so they are decoded once into `HTMLImageElement`s and held forever — the whole set
 * is under a megabyte.
 *
 * 51 of the pack's perk icons name a PNG that exists in no archive at all. That is a pack bug,
 * not a gap in extraction; the preload substitutes the mod's own `unknown.png`, so by the time
 * a URL reaches here it is either real or a deliberate placeholder.
 */

type Entry = { image: HTMLImageElement | null };

export class IconCache {
  private readonly entries = new Map<string, Entry>();
  private readonly onLoad: () => void;
  private readonly urlFor: (resourcePath: string) => string | null;

  constructor(urlFor: (resourcePath: string) => string | null, onLoad: () => void) {
    this.urlFor = urlFor;
    this.onLoad = onLoad;
  }

  /**
   * The decoded icon, or null while it is still loading or if there is nothing to show.
   *
   * Never throws and never blocks: a caller draws what it has and the `onLoad` callback asks
   * for another frame once more arrives.
   */
  get(resourcePath: string | undefined): HTMLImageElement | null {
    if (resourcePath === undefined || resourcePath.length === 0) return null;

    const existing = this.entries.get(resourcePath);
    if (existing !== undefined) return existing.image;

    const entry: Entry = { image: null };
    this.entries.set(resourcePath, entry);

    const url = this.urlFor(resourcePath);
    if (url === null) return null;

    const image = new Image();
    image.onload = () => {
      entry.image = image;
      this.onLoad();
    };
    // A decode failure leaves the entry at null rather than retrying every frame.
    image.onerror = () => {};
    image.src = url;

    return null;
  }
}
